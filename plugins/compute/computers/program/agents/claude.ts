/**
 * Claude Code as an ACP agent: `claude -p`, its input and output JSON lines
 * (stream-json), one process per session, kept between prompts (each user
 * message on its stdin is a turn; each `result` ends one).
 *
 * It's only the engine: the agent's instructions are its whole system
 * prompt, it has none of its own tools (`--tools ""`), and the only MCP
 * server it reaches is the session's (the agent's tools, held there until
 * the plugin answers). Its home is its config dir (`CLAUDE_CONFIG_DIR`): a
 * sign-in of its own, and no settings, hooks, plugins, CLAUDE.md or memory
 * of the person's. A session is Claude Code's own (`--session-id`), so a
 * later process takes it up again (`--resume`): after the program
 * restarts, or after its process was stopped.
 *
 * What it says as it goes becomes ACP updates: text and thinking as they
 * stream, a tool's call and its end (for show: the call itself reaches the
 * MCP server). A turn that fails says why (`data.code`): `signed_out`,
 * `limit`, `model` or `failed`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { OWN, signalGroup } from "../workloads/processes.ts";
import { agentError, rpcError } from "./rpc.ts";
import type {
  Adapter,
  AgentFailure,
  Ended,
  LoadSessionParams,
  McpServerParams,
  NewSessionParams,
  PromptParams,
  PromptResponse,
  SessionUpdate,
} from "./types.ts";
import { writeWhole } from "./write.ts";

/** How long an interrupted turn gets to end before its process is stopped. */
const INTERRUPTING = 5_000;
/** How long a stopped process gets before SIGKILL. */
const GRACE = 2_000;

type Turn = {
  resolve(response: PromptResponse): void;
  reject(error: unknown): void;
  /** What went wrong, as it said along the way. */
  failure?: AgentFailure;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type Session = {
  id: string;
  cwd: string;
  instructions: string;
  model: string;
  server?: McpServerParams;
  /** Whether Claude Code has it already (it resumes it). */
  saved: boolean;
  child?: ChildProcess;
  turn?: Turn;
};

// deno-lint-ignore no-explicit-any
type Json = any;

/** Why it failed, from what it said: a sign-in, a limit, a model, or nothing known. */
export function failureIn(text: string): AgentFailure | undefined {
  if (/not logged in|\/login|authenticat|oauth|unauthori[sz]ed|invalid api key/i.test(text)) {
    return "signed_out";
  }
  if (
    /usage limit|rate.?limit|limit reached|limit will reset|quota|credit balance|extra usage|too many requests/i
      .test(text)
  ) return "limit";
  if (
    /model/i.test(text) && /not.*(found|exist|available|support)|access|invalid|issue/i.test(text)
  ) {
    return "model";
  }
}

/** An assistant message's `error`, as a failure. */
const ERRORS: Record<string, AgentFailure> = {
  authentication_failed: "signed_out",
  rate_limit: "limit",
  billing_error: "limit",
};

/** ACP content blocks, as a user message's content. */
function contentOf(prompt: unknown[]): unknown[] {
  return prompt.flatMap((block: Json): unknown[] => {
    if (block?.type === "text") return [{ type: "text", text: String(block.text ?? "") }];
    if (block?.type === "image" && block.data) {
      return [{
        type: "image",
        source: { type: "base64", media_type: block.mimeType ?? "image/png", data: block.data },
      }];
    }
    if (block?.type === "resource" && typeof block.resource?.text === "string") {
      return [{ type: "text", text: block.resource.text }];
    }
    if (block?.type === "resource_link") {
      return [{ type: "text", text: `${block.name ?? block.uri}: ${block.uri}` }];
    }
    return [];
  });
}

/** How Claude's turn ended, as ACP says it. */
const stopOf = (reason: unknown): PromptResponse["stopReason"] =>
  reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : "end_turn";

/** A tool's name without its MCP server's prefix (`mcp__<server>__`). */
const bare = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");

export const claude: Adapter = (options) => {
  const sessions = new Map<string, Session>();
  const heard = new Set<(method: string, params: unknown) => void>();
  let gone: Ended | undefined;
  let ended!: (how: Ended) => void;
  const closed = new Promise<Ended>((resolve) => ended = resolve);

  const update = (session: Session, update: SessionUpdate) => {
    for (const handler of heard) handler("session/update", { sessionId: session.id, update });
  };

  /** Sends a JSON line to its process. */
  const send = (child: ChildProcess, message: unknown) => {
    child.stdin!.write(JSON.stringify(message) + "\n");
  };

  /** Ends the session's turn: answered, or failed. */
  const finish = (session: Session, settle: (turn: Turn) => void) => {
    const turn = session.turn;
    if (!turn) return;
    session.turn = undefined;
    clearTimeout(turn.timer);
    settle(turn);
  };

  /** Stops its process (the session stays: a later prompt resumes it). */
  const stop = async (child: ChildProcess) => {
    child.stdin!.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), GRACE);
    await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(timer);
  };

  /** What its process says, line by line. */
  const hear = (session: Session, child: ChildProcess, event: Json) => {
    const turn = session.turn;
    switch (event?.type) {
      case "system":
        if (event.subtype === "init") {
          if (typeof event.session_id === "string") session.saved = true;
          const ours = (event.mcp_servers ?? []).find((s: Json) =>
            s?.name === session.server?.name
          );
          if (ours?.status === "failed" && turn) {
            options.log("couldn't reach the agent's tools");
            finish(
              session,
              (t) => t.reject(agentError("failed", "Claude Code couldn't reach the agent's tools")),
            );
            void stop(child);
          }
        }
        return;
      case "stream_event": {
        if (event.parent_tool_use_id) return;
        const delta = event.event?.type === "content_block_delta" ? event.event.delta : undefined;
        if (delta?.type === "text_delta" && delta.text) {
          update(session, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta.text },
          });
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          update(session, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: delta.thinking },
          });
        }
        return;
      }
      case "assistant": {
        if (event.parent_tool_use_id) return;
        if (turn && typeof event.error === "string") turn.failure ??= ERRORS[event.error];
        for (const block of event.message?.content ?? []) {
          if (block?.type !== "tool_use") continue;
          update(session, {
            sessionUpdate: "tool_call",
            toolCallId: block.id,
            title: bare(String(block.name ?? "")),
            kind: "other",
            status: "pending",
            rawInput: block.input,
          });
        }
        return;
      }
      case "user": {
        if (event.parent_tool_use_id) return;
        const content = event.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type !== "tool_result") continue;
          update(session, {
            sessionUpdate: "tool_call_update",
            toolCallId: block.tool_use_id,
            status: block.is_error ? "failed" : "completed",
          });
        }
        return;
      }
      case "rate_limit_event":
        if (turn && event.rate_limit_info?.status === "rejected") turn.failure = "limit";
        return;
      case "control_request": {
        // What would ask a person: only the agent's tools are let through.
        const request = event.request ?? {};
        const prefix = `mcp__${session.server?.name}__`;
        const response = request.subtype !== "can_use_tool"
          ? { subtype: "error", request_id: event.request_id, error: "Not supported" }
          : {
            subtype: "success",
            request_id: event.request_id,
            response: session.server && String(request.tool_name ?? "").startsWith(prefix)
              ? { behavior: "allow", updatedInput: request.input ?? {} }
              : { behavior: "deny", message: "Only the agent's own tools run here" },
          };
        send(child, { type: "control_response", response });
        return;
      }
      case "result": {
        if (typeof event.session_id === "string") session.saved = true;
        const usage = event.usage ?? {};
        const meta = {
          copilotz: {
            usage: {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              ...(usage.cache_read_input_tokens ? { cached: usage.cache_read_input_tokens } : {}),
              ...(usage.cache_creation_input_tokens
                ? { cacheWrite: usage.cache_creation_input_tokens }
                : {}),
            },
          },
        };
        finish(session, (t) => {
          if (t.cancelled) return t.resolve({ stopReason: "cancelled", _meta: meta });
          if (event.is_error || (event.subtype && event.subtype !== "success")) {
            const said = [event.result, ...(event.errors ?? [])].filter(Boolean).join(": ");
            return t.reject(
              agentError(t.failure ?? failureIn(said) ?? "failed", said || "Claude Code failed"),
            );
          }
          t.resolve({ stopReason: stopOf(event.stop_reason), _meta: meta });
        });
        return;
      }
    }
  };

  /** Starts the session's process: a new session, or the one it has (`--resume`). */
  const start = async (session: Session) => {
    // Its process's own files, gone with it: the system prompt, and its MCP config, whose
    // token is a secret (in a file only its user reads, never on its command line).
    const run = join(options.home, "run", randomBytes(12).toString("hex"));
    const prompt = `${run}.md`;
    const config = `${run}.json`;
    await writeWhole(prompt, session.instructions);
    const server = session.server;
    await writeWhole(
      config,
      JSON.stringify({
        mcpServers: server
          ? {
            [server.name]: {
              type: "http",
              url: server.url,
              headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
            },
          }
          : {},
      }),
      0o600,
    );
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--system-prompt-file",
      prompt,
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      config,
      ...(server ? ["--allowedTools", `mcp__${server.name}`] : []),
      "--model",
      session.model,
      ...(session.saved ? ["--resume", session.id] : ["--session-id", session.id]),
    ];
    const env: Record<string, string> = {
      ...options.env,
      // A held call waits for its person: a day.
      MCP_TOOL_TIMEOUT: "86400000",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(options.command, args, {
      cwd: session.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...OWN,
    });
    session.child = child;
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (text: string) => {
      stderr = (stderr + text).slice(-4096);
    });
    child.stdin!.on("error", () => {});
    let buffer = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let event: Json;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        hear(session, child, event);
      }
    });
    const exited = (error?: string) => {
      if (session.child === child) session.child = undefined;
      for (const file of [prompt, config]) void rm(file, { force: true }).catch(() => {});
      const said = (error ?? stderr).trim().split("\n").slice(-3).join(" ").slice(0, 500);
      if (said && session.turn) options.log(`stopped: ${said}`);
      finish(
        session,
        (turn) =>
          turn.cancelled ? turn.resolve({ stopReason: "cancelled" }) : turn.reject(
            agentError(
              turn.failure ?? failureIn(said) ?? "failed",
              `Claude Code stopped${said ? `: ${said}` : ""}`,
            ),
          ),
      );
    };
    child.once("error", (error) => exited(error.message));
    child.once("close", () => exited());
  };

  /** A session's params, checked. */
  const sessionOf = (params: NewSessionParams, id: string, saved: boolean): Session => {
    const meta = params?._meta?.copilotz;
    if (typeof meta?.instructions !== "string" || typeof meta.model !== "string") {
      throw rpcError("_meta.copilotz needs the instructions and model", undefined, -32602);
    }
    const server = (params.mcpServers ?? []).find((s) => s?.type === "http");
    return {
      id,
      cwd: params.cwd,
      instructions: meta.instructions,
      model: meta.model,
      ...(server ? { server } : {}),
      saved,
    };
  };

  /** Whether Claude Code keeps session `id` (a transcript of it, in any project of its home). */
  const kept = async (id: string) => {
    const projects = join(options.home, "projects");
    const folders = await readdir(projects).catch(() => [] as string[]);
    for (const folder of folders) {
      if (await access(join(projects, folder, `${id}.jsonl`)).then(() => true, () => false)) {
        return true;
      }
    }
    return false;
  };

  const methods: Record<string, (params: Json) => Promise<unknown>> = {
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true, embeddedContext: true },
        },
        authMethods: [],
      }),
    "session/new": async (params: NewSessionParams) => {
      const session = sessionOf(params, randomUUID(), false);
      sessions.set(session.id, session);
      await start(session);
      return { sessionId: session.id };
    },
    "session/load": async (params: LoadSessionParams) => {
      const id = String(params?.sessionId ?? "");
      if (sessions.has(id)) return {};
      if (!/^[0-9a-f-]{36}$/i.test(id) || !await kept(id)) {
        throw agentError("failed", `Claude Code has no session ${id}`);
      }
      const session = sessionOf(params, id, true);
      sessions.set(id, session);
      await start(session);
      return {};
    },
    "session/prompt": async (params: PromptParams) => {
      const session = sessions.get(params?.sessionId);
      if (!session) throw rpcError(`No session ${params?.sessionId}`, undefined, -32602);
      if (session.turn) throw agentError("failed", "A prompt is running in this session");
      if (!session.child) await start(session);
      const child = session.child!;
      const answer = new Promise<PromptResponse>((resolve, reject) => {
        session.turn = { resolve, reject, cancelled: false };
      });
      send(child, {
        type: "user",
        message: { role: "user", content: contentOf(params.prompt ?? []) },
        parent_tool_use_id: null,
        session_id: session.id,
      });
      return await answer;
    },
  };

  return {
    request<R>(method: string, params?: unknown) {
      if (gone) return Promise.reject(agentError("failed", "Claude Code's adapter is closed"));
      const run = methods[method];
      if (!run) return Promise.reject(rpcError(`Method not found: ${method}`, undefined, -32601));
      return run(params) as Promise<R>;
    },
    notify(method, params: Json) {
      if (method !== "session/cancel") return;
      const session = sessions.get(params?.sessionId);
      const turn = session?.turn;
      const child = session?.child;
      if (!turn || !child || turn.cancelled) return;
      turn.cancelled = true;
      send(child, {
        type: "control_request",
        request_id: `interrupt_${randomBytes(6).toString("hex")}`,
        request: { subtype: "interrupt" },
      });
      // Not ended in time: its process goes (the session is resumed next time).
      turn.timer = setTimeout(() => void stop(child), INTERRUPTING);
    },
    onNotification: (handler) => void heard.add(handler),
    // It never asks the client anything.
    onRequest: () => {},
    closed,
    async close() {
      if (gone) return;
      gone = { code: null };
      await Promise.all(
        [...sessions.values()].map((session) => session.child && stop(session.child)),
      );
      sessions.clear();
      ended(gone);
    },
  };
};
