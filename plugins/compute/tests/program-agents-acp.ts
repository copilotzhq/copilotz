/**
 * A fake native ACP agent (as `agy acp`), for the engine tests
 * (program-agents.test.ts): it says what it was started with (a JSON line
 * to `FAKE_LOG`), and answers ACP v1 on stdio, scripted by what each prompt
 * says:
 *
 * - `rules`, `settings`, `model`: its session folder's `AGENTS.md`, its
 *   settings, its model;
 * - `call <tool>`: asks to call the agent's tool, calls it over MCP, says `got <result>`;
 * - `shell`: asks to run a command, and says what it was told;
 * - `fs`: asks the client for a file, and says what it was told.
 *
 * Signed in is a file in its home (`.fake-signed-in`): `acp --login` writes
 * it when given the code `good-code`. It can't load sessions.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

// deno-lint-ignore no-explicit-any
type Json = any;

const args = process.argv.slice(2);
const home = process.env.HOME ?? "";
const signed = join(home, ".fake-signed-in");
if (process.env.FAKE_LOG) {
  appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), home }) + "\n",
  );
}

if (args[0] === "--version") {
  console.log("agy 1.4.2");
} else if (args[0] === "acp" && args.includes("--login")) {
  process.stdout.write("Sign in at https://agy.example/login then paste the code: ");
  createInterface({ input: process.stdin }).once("line", (code) => {
    if (code.trim() === "good-code") writeFileSync(signed, "yes");
    process.exit(code.trim() === "good-code" ? 0 : 1);
  });
} else if (args[0] === "acp") {
  agent();
} else process.exit(2);

function agent() {
  const send = (message: unknown) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message as object }) + "\n");
  let asked = 0;
  const waiting = new Map<number, (message: Json) => void>();
  const request = (method: string, params: unknown) =>
    new Promise<Json>((resolve) => {
      waiting.set(++asked, resolve);
      send({ id: asked, method, params });
    });
  const sessions = new Map<string, { cwd: string; mcp: Json; model: string }>();
  let made = 0;

  const chunk = (sessionId: string, text: string) =>
    send({
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    });

  const mcpCall = async (mcp: Json, name: string) => {
    const headers = Object.fromEntries(mcp.headers.map((h: Json) => [h.name, h.value]));
    const post = (id: number, method: string, params: unknown) =>
      fetch(mcp.url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }).then((r) => r.json());
    await post(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const answer = await post(2, "tools/call", { name, arguments: {} });
    return answer.result?.content?.[0]?.text ?? answer.error?.message;
  };

  const handle = async (method: string, params: Json): Promise<unknown> => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false } },
          authMethods: [{ id: "terminal-login", name: "Sign in" }],
        };
      case "session/new": {
        if (!existsSync(signed)) throw { code: -32000, message: "Authentication required" };
        const sessionId = `agy-${process.pid}-${++made}`;
        const mcp = params.mcpServers.find((s: Json) => s.type === "http");
        sessions.set(sessionId, { cwd: params.cwd, mcp, model: "gemini-3-pro" });
        return {
          sessionId,
          models: {
            availableModels: [
              { modelId: "gemini-3-pro", name: "Gemini 3 Pro" },
              { modelId: "gemini-3-flash", name: "Gemini 3 Flash" },
            ],
            currentModelId: "gemini-3-pro",
          },
        };
      }
      case "session/set_model":
        sessions.get(params.sessionId)!.model = params.modelId;
        return {};
      case "session/prompt": {
        const id = params.sessionId;
        const session = sessions.get(id)!;
        const [command, tool] = params.prompt.map((b: Json) => b.text ?? "").join("").split(" ");
        if (command === "rules") chunk(id, readFileSync(join(session.cwd, "AGENTS.md"), "utf8"));
        else if (command === "settings") {
          chunk(
            id,
            readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
          );
        } else if (command === "model") chunk(id, session.model);
        else if (command === "call") {
          const told = await request("session/request_permission", {
            sessionId: id,
            toolCall: { toolCallId: `${tool}-${Date.now()}`, title: tool, kind: "other" },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          if (told.result?.outcome?.optionId !== "yes") chunk(id, "refused");
          else chunk(id, `got ${await mcpCall(session.mcp, tool)}`);
        } else if (command === "shell") {
          const told = await request("session/request_permission", {
            sessionId: id,
            toolCall: { toolCallId: "lookup-1", title: "rm -rf ~", kind: "execute" },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          chunk(id, `shell: ${told.result?.outcome?.optionId ?? told.result?.outcome?.outcome}`);
        } else if (command === "fs") {
          const told = await request("fs/read_text_file", { sessionId: id, path: "/etc/hosts" });
          chunk(id, `fs: ${told.error ? "refused" : "read"}`);
        }
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        };
      }
      default:
        throw { code: -32601, message: `Method not found: ${method}` };
    }
  };

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      handle(message.method, message.params).then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error }),
      );
    } else if (!message.method) waiting.get(message.id)?.(message);
  }).on("close", () => process.exit(0));
}
