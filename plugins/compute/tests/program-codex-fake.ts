/**
 * A fake `codex`, for the Codex adapter's tests (program-codex.test.ts): run
 * as the computer runs `codex`, it says what it was started with and asked
 * (JSON lines to `FAKE_LOG`), and answers as `codex app-server` does, its
 * JSON-RPC without `jsonrpc`. Each turn is scripted by what its input says:
 *
 * - `say <words>`: thinks a little, then says them, word by word;
 * - `call <tool> <json>`: calls the agent's tool on the thread's MCP server
 *   (held there until it's answered), then says `got <result>`;
 * - `ask`: asks to run a command, then says what it was answered;
 * - `wait`: until it's interrupted;
 * - `limit`, `badmodel`, `unauthorized`, `refuse`: fails as Codex does;
 * - `turns`: how many turns its thread has had; `crash`: exits.
 *
 * `debug models` prints a catalog whose model brings its own tools, unless
 * `FAKE_NO_CATALOG` is set. Signed in is a file in its home
 * (`fake-auth.json`, the account: `{ "type": "chatgpt" }` or a key's), as
 * `login status` says too, and `logout` deletes; the MCP servers its config has are
 * `fake-config.json`'s. Threads are kept in its home, so a later process
 * resumes them.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

// deno-lint-ignore no-explicit-any
type Json = any;

const args = process.argv.slice(2);
// Its home: the one it's given, else the person's own, as Codex's is.
const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
const log = (entry: unknown) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
};
const read = (path: string): Json =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;

if (args[0] === "debug" && args[1] === "models") {
  if (process.env.FAKE_NO_CATALOG) process.exit(1);
  console.log(JSON.stringify({
    models: [{
      slug: "fake-model",
      tool_mode: "code_mode_only",
      apply_patch_tool_type: "freeform",
      supports_search_tool: true,
      experimental_supported_tools: ["something"],
      include_skills_usage_instructions: true,
      context_window: 1000,
    }],
  }));
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("codex-cli 0.999.0");
  process.exit(0);
}
if (args[0] === "logout") {
  rmSync(join(home, "fake-auth.json"), { force: true });
  console.log("Successfully logged out");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  const account = read(join(home, "fake-auth.json"));
  if (!account) {
    console.error("Not logged in");
    process.exit(1);
  }
  console.error(
    account.type === "chatgpt" ? "Logged in using ChatGPT" : "Logged in using an API key - sk-***",
  );
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

log({ started: { pid: process.pid, args, cwd: process.cwd(), env: { CODEX_HOME: home } } });

const out = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
const note = (method: string, params: unknown) => out({ method, params });

type Thread = { id: string; params: Json; turns: number };
const threads = new Map<string, Thread>();
const threadFile = (id: string) => join(home, "fake-threads", `${id}.json`);
const keep = (thread: Thread) => {
  mkdirSync(join(home, "fake-threads"), { recursive: true });
  writeFileSync(threadFile(thread.id), JSON.stringify({ turns: thread.turns }));
};

/** What it asks the client, by id: their answers. */
const asked = new Map<string, (message: Json) => void>();
let nextAsk = 0;
const ask = (method: string, params: unknown) =>
  new Promise<Json>((resolve) => {
    const id = `ask-${++nextAsk}`;
    asked.set(id, resolve);
    out({ id, method, params });
  });

/** Running turns' interruptions, by thread. */
const interrupts = new Map<string, () => void>();

/** One JSON-RPC exchange with an MCP server over HTTP: its answer (or failure). */
async function mcp(server: Json, message: Json): Promise<Json> {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.http_headers,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.status === 202 ? undefined : await response.json();
}

/** The thread's MCP servers that are on, and reached over HTTP. */
const serversOf = (params: Json) =>
  Object.entries(params?.config?.mcp_servers ?? {}).filter(([, s]: [string, Json]) =>
    s?.enabled !== false && s?.url
  ) as [string, Json][];

/** Codex's checks of a thread's config: every server has a transport; required ones answer. */
async function checkServers(params: Json) {
  for (
    const [name, server] of Object.entries(params?.config?.mcp_servers ?? {}) as [string, Json][]
  ) {
    if (!server?.url && !server?.command) {
      throw { code: -32600, message: `invalid transport in mcp_servers.${name}` };
    }
  }
  for (const [name, server] of serversOf(params)) {
    if (!server.required) continue;
    try {
      await mcp(server, { id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    } catch (error) {
      throw {
        code: -32603,
        message:
          `error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: ${name}: ${
            (error as Error).message
          }`,
      };
    }
  }
}

/** Runs a turn as its input says. */
async function play(thread: Thread, turnId: string, words: string) {
  const base = { threadId: thread.id, turnId };
  const tell = (method: string, params: Json = {}) => note(method, { ...base, ...params });
  const used = (input: number, cached: number, output: number) =>
    tell("thread/tokenUsage/updated", {
      tokenUsage: {
        last: {
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteInputTokens: 0,
          outputTokens: output,
        },
        total: {
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteInputTokens: 0,
          outputTokens: output,
        },
      },
    });
  const said = (text: string) => {
    tell("item/started", { item: { type: "agentMessage", id: "msg", text: "" } });
    for (const word of text.split(/(?<= )/)) {
      tell("item/agentMessage/delta", { itemId: "msg", delta: word });
    }
    tell("item/completed", { item: { type: "agentMessage", id: "msg", text } });
  };
  const done = (status: string, error: Json = null) =>
    tell("turn/completed", { turn: { id: turnId, status, error, items: [] } });
  const [command, ...rest] = words.trim().split(" ");
  tell("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
  switch (command) {
    case "say":
      tell("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 0 });
      tell("item/reasoning/summaryTextDelta", { itemId: "r", delta: "Thinking", summaryIndex: 0 });
      tell("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 1 });
      tell("item/reasoning/summaryTextDelta", { itemId: "r", delta: "More", summaryIndex: 1 });
      said(rest.join(" "));
      used(100, 40, 7);
      return done("completed");
    case "call": {
      const [tool, ...json] = rest;
      const [, server] = serversOf(thread.params)[0] ?? [];
      const callArgs = JSON.parse(json.join(" ") || "{}");
      used(100, 0, 5);
      tell("item/started", {
        item: {
          type: "mcpToolCall",
          id: "call_1",
          server: "copilotz",
          tool,
          status: "inProgress",
          arguments: callArgs,
        },
      });
      let text = "";
      try {
        await mcp(server, {
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        });
        await mcp(server, { method: "notifications/initialized" });
        const listed = await mcp(server, { id: 2, method: "tools/list" });
        log({ listed: listed?.result?.tools?.map((t: Json) => t.name) });
        const answer = await mcp(server, {
          id: 3,
          method: "tools/call",
          params: { name: tool, arguments: callArgs },
        });
        text = answer?.result?.content?.[0]?.text ?? JSON.stringify(answer?.error);
      } catch (error) {
        text = (error as Error).message;
      }
      tell("item/completed", {
        item: {
          type: "mcpToolCall",
          id: "call_1",
          server: "copilotz",
          tool,
          status: "completed",
          arguments: callArgs,
        },
      });
      said(`got ${text}`);
      used(120, 100, 3);
      return done("completed");
    }
    case "ask": {
      const answer = await ask("item/commandExecution/requestApproval", {
        ...base,
        itemId: "cmd",
        command: "rm -rf /",
      });
      said(`answered ${JSON.stringify(answer)}`);
      return done("completed");
    }
    case "wait":
      await new Promise<void>((resolve) => interrupts.set(thread.id, resolve));
      return done("interrupted");
    case "limit":
      tell("error", {
        willRetry: false,
        error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
      });
      return done("failed", {
        message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded",
      });
    case "badmodel":
      return done("failed", {
        message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
        codexErrorInfo: "badRequest",
      });
    case "unauthorized": {
      const error = {
        message: "unexpected status 401 Unauthorized",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      };
      tell("error", { willRetry: true, error: { ...error, message: "Reconnecting... 1/5" } });
      return done("failed", error);
    }
    case "refuse":
      return done("failed", {
        message: "This request was flagged.",
        codexErrorInfo: "cyberPolicy",
      });
    case "turns":
      said(`turns ${thread.turns}`);
      return done("completed");
    case "crash":
      process.stderr.write("fake codex crashed\n");
      process.exit(3);
  }
  said(`unknown: ${words}`);
  done("completed");
}

/** Answers one request, or fails it. */
async function handle(method: string, params: Json): Promise<Json> {
  switch (method) {
    case "initialize":
      log({ initialize: params });
      return { userAgent: "fake", codexHome: home, platformFamily: "unix", platformOs: "macos" };
    case "account/read": {
      const account = read(join(home, "fake-auth.json"));
      return { account: account ?? null, requiresOpenaiAuth: true };
    }
    case "config/read":
      return {
        config: {
          model: null,
          mcp_servers: read(join(home, "fake-config.json"))?.mcp_servers ?? {},
        },
      };
    case "thread/start": {
      await checkServers(params);
      const thread = { id: randomUUID(), params, turns: 0 };
      threads.set(thread.id, thread);
      keep(thread);
      log({ thread: "start", id: thread.id, params });
      return { thread: { id: thread.id } };
    }
    case "thread/resume": {
      const kept = read(threadFile(params?.threadId));
      if (!kept) {
        throw { code: -32600, message: `no rollout found for thread id ${params?.threadId}` };
      }
      await checkServers(params);
      const thread = { id: params.threadId, params, turns: kept.turns };
      threads.set(thread.id, thread);
      log({ thread: "resume", id: thread.id, params });
      return { thread: { id: thread.id } };
    }
    case "turn/start": {
      const thread = threads.get(params?.threadId);
      if (!thread) throw { code: -32600, message: `thread not found: ${params?.threadId}` };
      thread.turns++;
      keep(thread);
      const turnId = randomUUID();
      log({ turn: params.input });
      const words = params.input?.find((i: Json) => i.type === "text")?.text ?? "";
      setTimeout(() => void play(thread, turnId, words), 5);
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    case "turn/interrupt":
      log({ interrupt: params });
      interrupts.get(params?.threadId)?.();
      return {};
  }
  throw { code: -32601, message: `Method not found: ${method}` };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined) {
    log({ answered: message });
    asked.get(message.id)?.(message.result ?? { error: message.error });
    return asked.delete(message.id);
  }
  if (message.id === undefined) return;
  handle(message.method, message.params).then(
    (result) => out({ id: message.id, result }),
    (error) =>
      out({
        id: message.id,
        error: { code: error?.code ?? -32603, message: error?.message ?? String(error) },
      }),
  );
}).on("close", () => process.exit(0));
