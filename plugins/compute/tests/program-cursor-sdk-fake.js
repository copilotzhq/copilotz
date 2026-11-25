/**
 * A fake `@cursor/sdk`, for the Cursor runner's tests (program-cursor.test.ts):
 * copied into an engine's home as `node_modules/@cursor/sdk`, it answers as
 * the SDK does, and says what it was given (JSON lines to `FAKE_LOG`: an
 * agent's options, its rule file, its environment). Never the network.
 *
 * - `Cursor.auth`: `login` shows a link and signs in, `status` and `logout`
 *   read and clear the store (`FileCredentialStore`, a JSON file).
 * - `Agent.create` and `Agent.resume` (agents kept in `HOME`, so a later
 *   process resumes them): each send is scripted by what it says: `say
 *   <words>`, `call <tool> <json>` (on the agent's MCP server, held there
 *   until it's answered), `recall` (the sends before it), `wait` (until
 *   cancelled), `limit`, `badmodel`, `unauthorized`.
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

const log = (entry) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
};
const read = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;

/** A store of the sign-in, in a JSON file. */
export function FileCredentialStore(path) {
  return {
    path,
    load: () => Promise.resolve(read(path)),
    save: (credentials) => Promise.resolve(writeFileSync(path, JSON.stringify(credentials))),
    clear: () => Promise.resolve(rmSync(path, { force: true })),
  };
}

export const Cursor = {
  auth: {
    async login({ store, onLoginUrl, apiKeyName }) {
      log({ login: { apiKeyName } });
      onLoginUrl?.("https://cursor.com/loginDeepControl?challenge=c&uuid=u-1&redirectTarget=sdk");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await store.save({
        version: 1,
        backendUrl: "https://api2.cursor.sh",
        apiKey: "key_fake",
        email: "ana@example.com",
        createdAtMs: Date.now(),
      });
      return { apiKey: "key_fake", email: "ana@example.com", apiKeyExpiresAtMs: Date.now() + 1e9 };
    },
    async status({ store }) {
      const saved = await store.load();
      return saved
        ? { status: "logged-in", backendUrl: saved.backendUrl, email: saved.email }
        : { status: "logged-out" };
    },
    async logout({ store }) {
      await store.clear();
    },
  },
};

const kept = (id) => join(process.env.HOME ?? ".", "fake-agents", `${id}.json`);

/** What an agent was given, as the test reads it. */
function told(how, id, options) {
  const rule = join(options.local?.cwd ?? ".", ".cursor", "rules", "agent.mdc");
  log({
    [how]: id,
    options: { ...options, apiKey: options.apiKey ? "given" : undefined },
    key: options.apiKey,
    rule: existsSync(rule) ? readFileSync(rule, "utf8") : undefined,
    env: { HOME: process.env.HOME, CURSOR_API_KEY: process.env.CURSOR_API_KEY },
  });
}

/** One JSON-RPC exchange with the agent's MCP server over HTTP. */
async function mcp(server, message) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.status === 202 ? undefined : await response.json();
}

const USED = {
  inputTokens: 100,
  outputTokens: 7,
  cacheReadTokens: 40,
  cacheWriteTokens: 5,
  totalTokens: 152,
};

function agentOf(id, options) {
  return {
    agentId: id,
    send(text) {
      const before = read(kept(id)) ?? [];
      writeFileSync(kept(id), JSON.stringify([...before, text]));
      const [verb, ...rest] = text.trim().split(" ");
      if (verb === "unauthorized") {
        return Promise.reject(new Error("Unauthenticated: the API key is invalid or expired"));
      }
      let result = { id: "run-1", status: "finished", usage: USED };
      let cancelled;
      const stopped = new Promise((resolve) => cancelled = resolve);
      const says = (words) => ({
        type: "assistant",
        agent_id: id,
        run_id: "run-1",
        message: { role: "assistant", content: [{ type: "text", text: words }] },
      });
      return Promise.resolve({
        async *stream() {
          if (verb === "say") {
            yield { type: "thinking", agent_id: id, run_id: "run-1", text: "Thinking" };
            yield says(rest.join(" "));
          } else if (verb === "recall") {
            yield says(before.join(" | ") || "nothing");
          } else if (verb === "call") {
            const [tool, ...json] = rest;
            const server = Object.values(options.mcpServers ?? {})[0];
            let got = "";
            try {
              await mcp(server, {
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18" },
              });
              await mcp(server, { method: "notifications/initialized" });
              const listed = await mcp(server, { id: 2, method: "tools/list" });
              log({ listed: listed?.result?.tools?.map((t) => t.name) });
              yield {
                type: "tool_call",
                agent_id: id,
                run_id: "run-1",
                call_id: "c1",
                name: "mcp",
                status: "running",
              };
              const answer = await mcp(server, {
                id: 3,
                method: "tools/call",
                params: { name: tool, arguments: JSON.parse(json.join(" ")) },
              });
              got = answer?.result?.content?.[0]?.text ?? JSON.stringify(answer?.error);
            } catch (error) {
              got = error.message;
            }
            yield says(`got ${got}`);
          } else if (verb === "wait") {
            await stopped;
          } else if (verb === "limit") {
            result = {
              id: "run-1",
              status: "error",
              error: { message: "You've hit your usage limit" },
            };
          } else if (verb === "badmodel") {
            result = {
              id: "run-1",
              status: "error",
              error: { message: `Model ${options.model?.id} is not available on your plan` },
            };
          } else {
            yield says("ok");
          }
        },
        wait: () => Promise.resolve(result),
        cancel() {
          result = { id: "run-1", status: "cancelled" };
          cancelled();
          return Promise.resolve();
        },
      });
    },
  };
}

export const Agent = {
  create(options) {
    const id = `agent-${randomUUID()}`;
    mkdirSync(join(process.env.HOME ?? ".", "fake-agents"), { recursive: true });
    writeFileSync(kept(id), "[]");
    told("created", id, options);
    return Promise.resolve(agentOf(id, options));
  },
  resume(id, options) {
    told("resumed", id, options);
    if (!existsSync(kept(id))) return Promise.reject(new Error(`Agent ${id} not found`));
    return Promise.resolve(agentOf(id, options));
  },
};
