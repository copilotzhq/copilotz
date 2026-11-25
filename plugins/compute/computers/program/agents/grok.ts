/**
 * Grok Build as an ACP agent: `grok -p`, a process per prompt, its text on
 * stdin and its output JSON lines (`streaming-json`). A session is Grok's
 * own, made by the first prompt (`-s <id>`) and gone on in by the next
 * (`-r <id>`), in a later process too: after the program restarts.
 *
 * It's only the engine. The agent's instructions are its whole system
 * prompt (`--system-prompt-file`). It has none of its own tools: only
 * `search_tool` and `use_tool`, which reach MCP servers (`--tools`); no
 * memory, subagents, plan mode or web search. Grok honors an allowlist it
 * doesn't understand by keeping every tool, so a prompt it offers any other
 * tool fails before the model acts: any but those two and the session's
 * server's (`copilotz__lookup`), which it lists with them. The only MCP server it reaches is the
 * session's, named in the session's folder (`<cwd>/<session>`), in its
 * `.grok/config.toml`: its token in a file only its user reads, there only
 * while a prompt runs, a held call waiting a day. The folder is trusted
 * (`--trust`), or Grok wouldn't read it, and its calls go without asking
 * (`--always-approve`): whether one may run is the plugin's to say.
 *
 * Its home is `HOME`, with `GROK_HOME` in it: a sign-in of its own, and
 * none of the person's own Grok, or of the Claude Code and Cursor settings
 * Grok reads too (their plugins, hooks and MCP servers).
 *
 * What it says becomes ACP updates: text and thinking as they stream. A
 * prompt that fails says why (`data.code`): `signed_out`, `limit`, `model`,
 * `failed`, or, for a session Grok doesn't have, `stale`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { OWN, signalGroup } from "../workloads/processes.ts";
import { failureIn } from "./claude.ts";
import { agentError, rpcError } from "./rpc.ts";
import type {
  Adapter,
  Ended,
  LoadSessionParams,
  McpServerParams,
  NewSessionParams,
  PromptParams,
  PromptResponse,
  SessionUpdate,
} from "./types.ts";
import { writeWhole } from "./write.ts";

/** The only tools it may have: those that reach MCP servers. */
const TOOLS = ["search_tool", "use_tool"];
/** How long a held tool call may wait for its answer: a day. */
const HELD_SECONDS = 86_400;
/** How long a stopped process gets before SIGKILL. */
const GRACE = 2_000;

type Session = {
  id: string;
  /** Its own folder. */
  cwd: string;
  instructions: string;
  model: string;
  server?: McpServerParams;
  /** Whether Grok has it: the next prompt goes on in it (`-r`). */
  saved: boolean;
  child?: ChildProcess;
  cancelled?: boolean;
};

// deno-lint-ignore no-explicit-any
type Json = any;

/** ACP content blocks, as the text of a prompt. */
const textOf = (prompt: unknown[]) =>
  prompt.flatMap((block: Json): string[] =>
    block?.type === "text"
      ? [String(block.text ?? "")]
      : block?.type === "resource" && typeof block.resource?.text === "string"
      ? [block.resource.text]
      : block?.type === "resource_link"
      ? [`${block.name ?? block.uri}: ${block.uri}`]
      : []
  ).join("\n\n");

/** The session's MCP server, as Grok's config names one. */
const configOf = (server?: McpServerParams) =>
  server
    ? `[mcp_servers.${server.name}]\nurl = ${JSON.stringify(server.url)}\nheaders = { ${
      server.headers.map((h) => `${JSON.stringify(h.name)} = ${JSON.stringify(h.value)}`)
        .join(", ")
    } }\ntool_timeout_sec = ${HELD_SECONDS}\n`
    : "";

/** How its prompt ended, as ACP says it. */
const stopOf = (reason: unknown): PromptResponse["stopReason"] => {
  const said = String(reason).toLowerCase().replace(/[^a-z]/g, "");
  return said === "cancelled"
    ? "cancelled"
    : said === "maxtokens"
    ? "max_tokens"
    : said === "refusal"
    ? "refusal"
    : "end_turn";
};

export const grok: Adapter = (options) => {
  const sessions = new Map<string, Session>();
  const heard = new Set<(method: string, params: unknown) => void>();
  let gone: Ended | undefined;
  let ended!: (how: Ended) => void;
  const closed = new Promise<Ended>((resolve) => ended = resolve);

  const update = (session: Session, update: SessionUpdate) => {
    for (const handler of heard) handler("session/update", { sessionId: session.id, update });
  };

  /** Stops a prompt's process. */
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), GRACE);
    await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(timer);
  };

  /** One prompt, in a process of its own: what it says, then how it ended. */
  const run = async (session: Session, text: string): Promise<PromptResponse> => {
    const system = join(options.home, "run", `${randomBytes(12).toString("hex")}.md`);
    const config = join(session.cwd, ".grok", "config.toml");
    await writeWhole(system, session.instructions);
    await writeWhole(config, configOf(session.server), 0o600);
    const resumed = session.saved;
    const child = spawn(options.command, [
      "-p",
      resumed ? "-r" : "-s",
      session.id,
      "--output-format",
      "streaming-json",
      "--system-prompt-file",
      system,
      "--tools",
      TOOLS.join(","),
      "--no-memory",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      "--trust",
      "--always-approve",
      "-m",
      session.model,
      "--cwd",
      session.cwd,
    ], { cwd: session.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], ...OWN });
    session.child = child;
    session.cancelled = false;
    child.stdin!.on("error", () => {});
    child.stdin!.end(text);
    let said = "";
    let wrote = false;
    let usage: Json;
    let reason: unknown;
    let refused: string | undefined;
    const hear = (event: Json) => {
      // Its session is made: what comes next goes on in it.
      if (event?.type !== "error") session.saved = true;
      if (event?.type === "available_commands" || event?.type === "tool_call") {
        const tools: string[] = event.type === "tool_call" ? [event.toolName] : event.tools ?? [];
        // Its two, and the session's server's tools (`<server>__<tool>`), which it lists too.
        const ours = session.server && `${session.server.name}__`;
        const own = tools.filter((tool) =>
          !TOOLS.includes(tool) && !(ours && tool.startsWith(ours))
        );
        if (own.length && !refused) {
          refused = own.join(", ");
          options.log(`Grok Build offered tools of its own: ${refused}`);
          void stop(child);
        }
      } else if (event?.type === "text" && event.data && !refused) {
        wrote = true;
        update(session, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.data },
        });
      } else if (event?.type === "thought" && event.data && !refused) {
        update(session, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.data },
        });
      } else if (event?.type === "end") {
        usage = event.usage;
        reason = event.stopReason;
      } else if (event?.type === "error") said = String(event.message ?? "");
    };
    let buffer = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        try {
          if (line) hear(JSON.parse(line));
        } catch { /* not a line of its output */ }
      }
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (text: string) => {
      stderr = (stderr + text).slice(-4096);
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        stderr += error.message;
        resolve(null);
      });
      child.once("close", resolve);
    });
    session.child = undefined;
    await Promise.all([rm(system, { force: true }), rm(config, { force: true })]);
    const cancelled = session.cancelled;
    if (cancelled) return { stopReason: "cancelled" };
    if (refused) throw agentError("failed", `Grok Build offered tools of its own: ${refused}`);
    if (code === 0 && reason !== undefined) {
      const input = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0);
      return {
        stopReason: stopOf(reason),
        _meta: {
          copilotz: {
            usage: {
              input,
              output: usage?.output_tokens ?? 0,
              ...(usage?.cache_read_input_tokens ? { cached: usage.cache_read_input_tokens } : {}),
              ...(usage?.cache_creation_input_tokens
                ? { cacheWrite: usage.cache_creation_input_tokens }
                : {}),
            },
          },
        },
      };
    }
    const why = (said || stderr).trim().split("\n").slice(-3).join(" ").slice(0, 500);
    if (why) options.log(`stopped: ${why}`);
    // A session it doesn't have (gone, or never saved): stale, so it starts afresh, given it all.
    throw agentError(
      failureIn(why) ?? (resumed && !wrote ? "stale" : "failed"),
      `Grok Build stopped${why ? `: ${why}` : ""}`,
    );
  };

  /** A session's params, checked, in a folder of its own. */
  const sessionOf = async (params: NewSessionParams, id: string, saved: boolean) => {
    const meta = params?._meta?.copilotz;
    if (typeof meta?.instructions !== "string" || typeof meta.model !== "string") {
      throw rpcError("_meta.copilotz needs the instructions and model", undefined, -32602);
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw agentError("failed", `Grok Build has no session ${id}`);
    const cwd = join(params.cwd, id);
    await mkdir(cwd, { recursive: true });
    const server = (params.mcpServers ?? []).find((s) => s?.type === "http");
    const session: Session = {
      id,
      cwd,
      instructions: meta.instructions,
      model: meta.model,
      ...(server ? { server } : {}),
      saved,
    };
    sessions.set(id, session);
    return session;
  };

  const methods: Record<string, (params: Json) => Promise<unknown>> = {
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, embeddedContext: true },
        },
        authMethods: [],
      }),
    "session/new": async (params: NewSessionParams) => {
      const session = await sessionOf(params, randomUUID(), false);
      return { sessionId: session.id };
    },
    // Taken up again as it is: one Grok doesn't have is stale at its first prompt.
    "session/load": async (params: LoadSessionParams) => {
      const id = String(params?.sessionId ?? "");
      if (!sessions.has(id)) await sessionOf(params, id, true);
      return {};
    },
    "session/prompt": async (params: PromptParams) => {
      const session = sessions.get(params?.sessionId);
      if (!session) throw rpcError(`No session ${params?.sessionId}`, undefined, -32602);
      if (session.child) throw agentError("failed", "A prompt is running in this session");
      return await run(session, textOf(params.prompt ?? []));
    },
  };

  return {
    request<R>(method: string, params?: unknown) {
      if (gone) return Promise.reject(agentError("failed", "Grok Build's adapter is closed"));
      const call = methods[method];
      if (!call) return Promise.reject(rpcError(`Method not found: ${method}`, undefined, -32601));
      return call(params) as Promise<R>;
    },
    notify(method, params: Json) {
      if (method !== "session/cancel") return;
      const session = sessions.get(params?.sessionId);
      if (!session?.child) return;
      session.cancelled = true;
      void stop(session.child);
    },
    onNotification: (handler) => void heard.add(handler),
    // It never asks the client anything.
    onRequest: () => {},
    closed,
    async close() {
      if (gone) return;
      gone = { code: null };
      await Promise.all([...sessions.values()].map((s) => s.child && stop(s.child)));
      sessions.clear();
      ended(gone);
    },
  };
};
