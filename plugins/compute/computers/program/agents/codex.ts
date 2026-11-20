/**
 * Codex as an ACP agent: `codex app-server`, its JSON-RPC on stdio (rpc.ts,
 * in its dialect without `jsonrpc`), one process for the peer's sessions,
 * kept between prompts. A session is a Codex thread (`thread/start`), which
 * a later process takes up again (`thread/resume`): after the program
 * restarts, or after an idle session's process was stopped. A prompt is a
 * turn (`turn/start`); cancelling it interrupts the turn.
 *
 * It's only the engine. The agent's instructions are its whole prompt
 * (`baseInstructions`), and Codex adds none of its own: no environment,
 * permissions, apps or skills sections, no AGENTS.md. It has none of its
 * own tools (`LOCKED`): no shell, image viewing or making, sub-agents,
 * goals, memories, hooks, apps, plugins, skills, web search, browser or
 * computer use, nor questions for the person; and its models' catalog is
 * rewritten so that no model brings its own (`lockCatalog`: no code mode, no
 * file edits, no tool search). It runs read-only, asks nobody, and signs
 * in with ChatGPT only: a plan pays, never an API key.
 *
 * The only MCP server it reaches is the session's: its tools are called
 * directly and without asking (whether a call may run is the plugin's to
 * say), and held there until the plugin answers. Any other server its home
 * has is turned off. What's left of Codex's own are its tools for MCP
 * servers' resources (`list_mcp_resources`…), which no setting turns off:
 * they reach only the session's server, which has none. What Codex asks a
 * person anyway (an approval, a question) is declined. Its home is
 * `CODEX_HOME` (in `env`): a sign-in of its own, apart from the person's
 * own Codex.
 *
 * What it says as it goes becomes ACP updates: text and reasoning as they
 * stream, a tool's call and its end (for show: the call itself reaches the
 * MCP server). A turn that fails says why (`data.code`): `signed_out`,
 * `limit`, `model` or `failed`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { OWN, signalGroup } from "../workloads/processes.ts";
import { agentError, rpcError, spawnPeer } from "./rpc.ts";
import type {
  Adapter,
  AgentFailure,
  Ended,
  LoadSessionParams,
  McpServerParams,
  NewSessionParams,
  Peer,
  PromptParams,
  PromptResponse,
  SessionUpdate,
  Usage,
} from "./types.ts";
import { writeWhole } from "./write.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** How long an interrupted turn gets to end before Codex is stopped. */
const INTERRUPTING = 5_000;
/** How long `codex debug models` gets to say its catalog. */
const CATALOGING = 30_000;
/** How long a tool call may be held: a day, as a person may take that long to approve it. */
const HELD_SECONDS = 86_400;
/** How long the session's MCP server gets to answer Codex's handshake. */
const REACHING_SECONDS = 30;

/**
 * What Codex runs with (`-c` on its command line), for every thread: none
 * of its own tools, nothing of its own in the prompt, no hook of the home's
 * run, a summary of its reasoning to stream, and a ChatGPT sign-in only.
 */
export const LOCKED = {
  features: {
    shell_tool: false,
    unified_exec: false,
    shell_snapshot: false,
    view_image: false,
    image_generation: false,
    multi_agent: false,
    multi_agent_v2: false,
    goals: false,
    memories: false,
    hooks: false,
    apps: false,
    plugins: false,
    remote_plugin: false,
    tool_suggest: false,
    skill_search: false,
    skill_mcp_dependency_install: false,
    browser_use: false,
    browser_use_external: false,
    in_app_browser: false,
    computer_use: false,
    sleep_tool: false,
    request_permissions_tool: false,
  },
  web_search: "disabled",
  tools: { experimental_request_user_input: { enabled: false } },
  agents: { enabled: false },
  skills: { bundled: { enabled: false }, include_instructions: false },
  apps: { _default: { enabled: false } },
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  project_doc_max_bytes: 0,
  notify: [],
  forced_login_method: "chatgpt",
  check_for_update_on_startup: false,
  model_reasoning_summary: "auto",
};

/** A value as TOML, as `-c` reads it: JSON's strings are TOML's too. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")
    }}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Config as `-c key=value` arguments, one per setting (dotted keys). */
export function overrides(config: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(config).flatMap(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length
      ? overrides(value as Record<string, unknown>, `${prefix}${key}.`)
      : ["-c", `${prefix}${key}=${toml(value)}`]
  );
}

/**
 * Codex's models' catalog (`codex debug models`), its models bringing none
 * of their own tools: no code mode (a JavaScript cell the other tools are
 * called from), no file edits (`apply_patch`), no tool search, no
 * experimental tools, and nothing said of skills, plugins or apps.
 * Undefined when it isn't one.
 */
export function lockCatalog(catalog: Json): Json | undefined {
  if (!Array.isArray(catalog?.models) || !catalog.models.length) return undefined;
  return {
    ...catalog,
    models: catalog.models.map((model: Json) => {
      const { tool_mode: _, ...rest } = model ?? {};
      return {
        ...rest,
        apply_patch_tool_type: null,
        supports_search_tool: false,
        experimental_supported_tools: [],
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
      };
    }),
  };
}

/** Why a turn failed, from what Codex said of it (`TurnError`): a sign-in, a limit, a model. */
export function failureOf(error: Json): AgentFailure {
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string"
    ? info
    : info && typeof info === "object"
    ? Object.keys(info)[0]
    : undefined;
  const status = kind && typeof info === "object" ? info[kind]?.httpStatusCode : undefined;
  if (kind === "unauthorized" || status === 401) return "signed_out";
  if (kind === "usageLimitExceeded" || kind === "rateLimitExceeded" || status === 429) {
    return "limit";
  }
  if (kind === "modelNotFound") return "model";
  const said = `${error?.message ?? ""} ${error?.additionalDetails ?? ""}`;
  if (/usage limit|rate.?limit|too many requests|quota|credits/i.test(said)) return "limit";
  if (/not logged in|log ?in again|sign ?in|unauthori[sz]ed|authenticat/i.test(said)) {
    return "signed_out";
  }
  if (
    /model/i.test(said) && /not.*(found|exist|available|support)|unsupported|access/i.test(said)
  ) {
    return "model";
  }
  return "failed";
}

/** Whether a turn failed because the model wouldn't (a policy's refusal), not because it couldn't. */
const refused = (error: Json) =>
  error?.codexErrorInfo === "cyberPolicy" ||
  error?.codexErrorInfo === "misalignmentPolicyViolation";

/** A text input, as Codex takes it. */
const textInput = (text: string) => ({ type: "text", text, text_elements: [] });

/** ACP content blocks, as a turn's input (`UserInput`s). */
export function inputOf(prompt: unknown[]): unknown[] {
  return prompt.flatMap((block: Json): unknown[] => {
    if (block?.type === "text") return [textInput(String(block.text ?? ""))];
    if (block?.type === "image") {
      if (block.data) {
        return [{
          type: "image",
          url: `data:${block.mimeType ?? "image/png"};base64,${block.data}`,
        }];
      }
      if (/^https?:\/\//.test(String(block.uri ?? ""))) return [{ type: "image", url: block.uri }];
      return [];
    }
    if (block?.type === "resource" && typeof block.resource?.text === "string") {
      return [textInput(block.resource.text)];
    }
    if (block?.type === "resource_link") {
      return [textInput(`${block.name ?? block.uri}: ${block.uri}`)];
    }
    return [];
  });
}

/** What Codex asks a person, answered no: its own tools' approvals, questions, elicitations. */
const DECLINED: Record<string, unknown> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "mcpServer/elicitation/request": { action: "decline", content: null, _meta: null },
  execCommandApproval: { decision: { denied: { rejection: "Only the agent's own tools run" } } },
  applyPatchApproval: { decision: { denied: { rejection: "Only the agent's own tools run" } } },
};

/** A config value without its nulls (TOML has none), as Codex takes it back. */
function defined(value: Json): Json {
  if (Array.isArray(value)) return value.map(defined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [
      key,
      defined(item),
    ]),
  );
}

type Turn = {
  resolve(response: PromptResponse): void;
  reject(error: unknown): void;
  /** Its id in Codex, once it's started. */
  id?: string;
  usage: Usage;
  /** What went wrong, as an `error` it won't retry said. */
  error?: Json;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type Session = { id: string; turn?: Turn };

/** What Codex runs a session's thread with: its instructions, model, folder and MCP server. */
type Thread = {
  model: string;
  cwd: string;
  approvalPolicy: "never";
  sandbox: "read-only";
  baseInstructions: string;
  config: { mcp_servers: Record<string, unknown> };
};

/** Runs `codex debug models`: its models' catalog, as JSON text (undefined when it can't). */
function catalogText(command: string, cwd: string, env: Record<string, string>) {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(command, ["debug", "models"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      ...OWN,
    });
    let stdout = "";
    child.stdout!.setEncoding("utf8").on("data", (text: string) => stdout += text);
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), CATALOGING);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : undefined);
    });
  });
}

export const codex: Adapter = (options) => {
  const sessions = new Map<string, Session>();
  const heard = new Set<(method: string, params: unknown) => void>();
  let gone: Ended | undefined;
  let ended!: (how: Ended) => void;
  const closed = new Promise<Ended>((resolve) => ended = resolve);
  let codexPeer: Peer | undefined;

  const update = (session: Session, update: SessionUpdate) => {
    for (const handler of heard) handler("session/update", { sessionId: session.id, update });
  };

  const chunk = (session: Session, kind: string, text: unknown) => {
    if (typeof text === "string" && text) {
      update(session, { sessionUpdate: kind, content: { type: "text", text } });
    }
  };

  /** What a turn used, as its answer says it. */
  const meta = (turn: Turn) => {
    const { input, output, cached, cacheWrite } = turn.usage;
    return {
      copilotz: {
        usage: {
          input,
          output,
          ...(cached ? { cached } : {}),
          ...(cacheWrite ? { cacheWrite } : {}),
        },
      },
    };
  };

  /** Ends the session's turn: answered, or failed. */
  const finish = (session: Session, settle: (turn: Turn) => void) => {
    const turn = session.turn;
    if (!turn) return;
    session.turn = undefined;
    clearTimeout(turn.timer);
    settle(turn);
  };

  /** It's gone (closed, or Codex stopped): every turn ends, and so does the peer. */
  const end = (how: Ended) => {
    if (gone) return;
    gone = how;
    for (const session of sessions.values()) {
      finish(
        session,
        (turn) =>
          turn.cancelled
            ? turn.resolve({ stopReason: "cancelled", _meta: meta(turn) })
            : turn.reject(
              agentError(
                failureOf({ message: how.error }),
                `Codex stopped${how.error ? `: ${how.error}` : ""}`,
              ),
            ),
      );
    }
    sessions.clear();
    ended(how);
  };

  /** Interrupts a turn once Codex has said its id; not ended in time, Codex goes. */
  const interrupt = (session: Session, turn: Turn) => {
    if (!turn.id || turn.timer) return;
    void codexPeer?.request("turn/interrupt", { threadId: session.id, turnId: turn.id })
      .catch((error) => options.log(`couldn't interrupt: ${(error as Error)?.message ?? error}`));
    turn.timer = setTimeout(() => {
      options.log("an interrupted turn didn't end: stopping Codex");
      void close();
    }, INTERRUPTING);
  };

  /** What Codex says as it goes, of a session's turn. */
  const hear = (method: string, params: Json) => {
    const session = sessions.get(params?.threadId);
    const turn = session?.turn;
    if (!session || !turn) return;
    switch (method) {
      case "turn/started":
        turn.id ??= params.turn?.id;
        if (turn.cancelled) interrupt(session, turn);
        return;
      case "item/agentMessage/delta":
        return chunk(session, "agent_message_chunk", params.delta);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return chunk(session, "agent_thought_chunk", params.delta);
      case "item/reasoning/summaryPartAdded":
        if (params.summaryIndex > 0) chunk(session, "agent_thought_chunk", "\n\n");
        return;
      case "item/started":
        if (params.item?.type === "mcpToolCall") {
          update(session, {
            sessionUpdate: "tool_call",
            toolCallId: params.item.id,
            title: String(params.item.tool ?? ""),
            kind: "other",
            status: "pending",
            rawInput: params.item.arguments,
          });
        } else if (!["userMessage", "agentMessage", "reasoning"].includes(params.item?.type)) {
          options.log(`Codex began a ${params.item?.type}`);
        }
        return;
      case "item/completed":
        if (params.item?.type === "mcpToolCall") {
          update(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: params.item.id,
            status: params.item.status === "completed" ? "completed" : "failed",
          });
        }
        return;
      case "thread/tokenUsage/updated": {
        // `last` is one model request's; a turn makes one per step.
        const last = params.tokenUsage?.last ?? {};
        turn.usage.input += last.inputTokens ?? 0;
        turn.usage.output += last.outputTokens ?? 0;
        turn.usage.cached = (turn.usage.cached ?? 0) + (last.cachedInputTokens ?? 0);
        turn.usage.cacheWrite = (turn.usage.cacheWrite ?? 0) + (last.cacheWriteInputTokens ?? 0);
        return;
      }
      case "error":
        if (params.willRetry) options.log(`retrying: ${params.error?.message ?? "an error"}`);
        else turn.error = params.error;
        return;
      case "turn/completed": {
        const { status, error } = params.turn ?? {};
        finish(session, (t) => {
          if (t.cancelled || status === "interrupted") {
            return t.resolve({ stopReason: "cancelled", _meta: meta(t) });
          }
          if (status === "completed") return t.resolve({ stopReason: "end_turn", _meta: meta(t) });
          const why = error ?? t.error;
          if (refused(why)) return t.resolve({ stopReason: "refusal", _meta: meta(t) });
          t.reject(agentError(failureOf(why), why?.message ?? "Codex's turn failed"));
        });
        return;
      }
    }
  };

  /** What Codex asks: declined, all of it (only the agent's tools run, and they ask nobody). */
  const decline = (method: string) => {
    options.log(`declined Codex's ${method}`);
    if (Object.hasOwn(DECLINED, method)) return Promise.resolve(DECLINED[method]);
    return Promise.reject(rpcError(`Declined: ${method}`, undefined, -32601));
  };

  /** Its catalog without models' own tools, written to its home: its path, or undefined. */
  const catalog = async () => {
    const text = await catalogText(options.command, options.home, options.env);
    let locked: Json;
    try {
      locked = text ? lockCatalog(JSON.parse(text)) : undefined;
    } catch {
      // Not JSON: as if it said none.
    }
    if (!locked) {
      options.log("couldn't read Codex's models: they keep their own tools");
      return undefined;
    }
    const path = join(options.home, "copilotz-models.json");
    await writeWhole(path, JSON.stringify(locked));
    return path;
  };

  /** Starts Codex and greets it: the peer its sessions talk to. */
  const start = async (): Promise<Peer> => {
    const models = await catalog();
    if (gone) throw agentError("failed", "Codex's adapter is closed");
    const peer = spawnPeer(
      options.command,
      [
        "app-server",
        ...overrides(LOCKED),
        ...(models ? overrides({ model_catalog_json: models }) : []),
      ],
      { cwd: options.home, env: options.env, bare: true, log: options.log },
    );
    codexPeer = peer;
    peer.onNotification(hear);
    peer.onRequest(decline);
    void peer.closed.then(end);
    await peer.request("initialize", {
      clientInfo: { name: "copilotz", title: "Copilotz", version: VERSION },
      // Its experimental fields: a thread's own instructions (`baseInstructions`).
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    peer.notify("initialized", {});
    return peer;
  };
  const ready = start();
  ready.catch((error) => end({ code: null, error: (error as Error)?.message ?? String(error) }));

  /** Fails unless Codex is signed in with ChatGPT (a plan, not a key). */
  const signedIn = async (peer: Peer) => {
    const read = await peer.request<Json>("account/read", { refreshToken: false });
    if (read?.account?.type !== "chatgpt") {
      throw agentError(
        "signed_out",
        read?.account
          ? "Codex is signed in with a key, not a ChatGPT plan"
          : "Codex isn't signed in",
      );
    }
  };

  /** The MCP servers its home has besides the session's, turned off (as they are, but off). */
  const othersOff = async (peer: Peer, cwd: string, ours: Set<string>) => {
    const read = await peer.request<Json>("config/read", { cwd }).catch((error) => {
      options.log(`couldn't read Codex's config: ${(error as Error)?.message ?? error}`);
      return undefined;
    });
    const servers = read?.config?.mcp_servers ?? {};
    return Object.fromEntries(
      Object.entries(servers).filter(([name]) => !ours.has(name)).map((
        [name, server],
      ) => [name, { ...defined(server), enabled: false }]),
    );
  };

  /** A session's thread: its params checked, with its MCP server, and the home's others off. */
  const threadOf = async (peer: Peer, params: NewSessionParams): Promise<Thread> => {
    const meta = params?._meta?.copilotz;
    if (typeof meta?.instructions !== "string" || typeof meta.model !== "string") {
      throw rpcError("_meta.copilotz needs the instructions and model", undefined, -32602);
    }
    if (typeof params.cwd !== "string" || !params.cwd) {
      throw rpcError("cwd is required", undefined, -32602);
    }
    const servers = (params.mcpServers ?? []).filter((s): s is McpServerParams =>
      s?.type === "http"
    );
    const ours = Object.fromEntries(servers.map((server) => [server.name, {
      url: server.url,
      http_headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
      // Called directly: not from a code cell, nor found by searching.
      omit_tools_from: ["code_mode", "deferred"],
      // Without asking: whether a call may run is the plugin's to say.
      default_tools_approval_mode: "approve",
      tool_timeout_sec: HELD_SECONDS,
      startup_timeout_sec: REACHING_SECONDS,
      // Unreached, the thread doesn't start: no turn runs without the agent's tools.
      required: true,
    }]));
    const others = await othersOff(peer, params.cwd, new Set(Object.keys(ours)));
    return {
      model: meta.model,
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: meta.instructions,
      config: { mcp_servers: { ...others, ...ours } },
    };
  };

  /** A thread that couldn't start or resume, as a failure. */
  const startFailure = (error: unknown) => {
    const said = (error as Error)?.message ?? String(error);
    if (/required MCP servers failed/i.test(said)) {
      return agentError("failed", "Codex couldn't reach the agent's tools");
    }
    return agentError(failureOf({ message: said }), said);
  };

  const methods: Record<string, (params: Json) => Promise<unknown>> = {
    initialize: async () => {
      await ready;
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true, embeddedContext: true },
        },
        authMethods: [],
      };
    },
    "session/new": async (params: NewSessionParams) => {
      const peer = await ready;
      await signedIn(peer);
      const thread = await threadOf(peer, params);
      const started = await peer.request<Json>("thread/start", thread).catch((error) => {
        throw startFailure(error);
      });
      const id = started?.thread?.id;
      if (typeof id !== "string" || !id) throw agentError("failed", "Codex started no thread");
      sessions.set(id, { id });
      return { sessionId: id };
    },
    "session/load": async (params: LoadSessionParams) => {
      const peer = await ready;
      const id = String(params?.sessionId ?? "");
      if (sessions.has(id)) return {};
      await signedIn(peer);
      const thread = await threadOf(peer, params);
      await peer.request("thread/resume", { threadId: id, ...thread, excludeTurns: true })
        .catch((error) => {
          const failure = startFailure(error);
          throw failure.message === "Codex couldn't reach the agent's tools"
            ? failure
            : agentError("failed", `Codex has no thread ${id}: ${failure.message}`);
        });
      sessions.set(id, { id });
      return {};
    },
    "session/prompt": async (params: PromptParams) => {
      const peer = await ready;
      const session = sessions.get(params?.sessionId);
      if (!session) throw rpcError(`No session ${params?.sessionId}`, undefined, -32602);
      if (session.turn) throw agentError("failed", "A prompt is running in this session");
      const answer = new Promise<PromptResponse>((resolve, reject) => {
        session.turn = { resolve, reject, usage: { input: 0, output: 0 }, cancelled: false };
      });
      const turn = session.turn!;
      peer.request<Json>("turn/start", {
        threadId: session.id,
        input: inputOf(params.prompt ?? []),
      })
        .then((started) => {
          turn.id ??= started?.turn?.id;
          if (turn.cancelled && session.turn === turn) interrupt(session, turn);
        }, (error) => {
          const said = (error as Error)?.message ?? String(error);
          finish(session, (t) => t.reject(agentError(failureOf({ message: said }), said)));
        });
      return await answer;
    },
  };

  /** Ends it, then stops Codex (one still starting doesn't start). */
  const close = async () => {
    if (gone) return;
    end({ code: null });
    await (codexPeer ?? await ready.catch(() => undefined))?.close();
  };

  return {
    request<R>(method: string, params?: unknown) {
      if (gone) return Promise.reject(agentError("failed", "Codex's adapter is closed"));
      const run = methods[method];
      if (!run) return Promise.reject(rpcError(`Method not found: ${method}`, undefined, -32601));
      return run(params) as Promise<R>;
    },
    notify(method, params: Json) {
      if (method !== "session/cancel") return;
      const session = sessions.get(params?.sessionId);
      const turn = session?.turn;
      if (!session || !turn || turn.cancelled) return;
      turn.cancelled = true;
      interrupt(session, turn);
    },
    onNotification: (handler) => void heard.add(handler),
    // It never asks the client anything: what Codex asks is declined here.
    onRequest: () => {},
    closed,
    close,
  };
};
