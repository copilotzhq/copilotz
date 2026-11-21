/**
 * A fake Claude Code, for the engine tests (program-agents.test.ts): run as
 * the computer runs `claude`, it says what it was started with (a JSON
 * line to `FAKE_LOG`) and answers as Claude Code does, scripted by what
 * each user message says:
 *
 * - `say <words>`: says them, word by word; `think <words>` thinks them first;
 * - `call <tool> <json>`: calls the agent's tool over MCP, then says `got <result>`;
 * - `calls <tool> <tool>…`: calls them all at once, then says what each gave;
 * - `pid`, `system`, `history`, `tools`, `model`: its process, its system
 *   prompt, how many messages its session has had, the tools it sees, its model;
 * - `limit`, `badmodel`: fails as a plan's limit, or a model it doesn't have;
 * - `big <KiB>`: says that much at once; `wait`: until it's interrupted;
 *   `crash`: exits.
 *
 * Signed in is a file in its config dir (`fake-auth.json`): `auth login`
 * writes it when it's given the code `good-code`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

// deno-lint-ignore no-explicit-any
type Json = any;

const args = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR ?? "";
const auth = join(home, "fake-auth.json");
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const out = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");

if (process.env.FAKE_LOG) {
  appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({
      pid: process.pid,
      args,
      // The MCP config it was given, its servers' timeouts (its headers hold a token: never logged).
      timeouts: args.includes("--mcp-config")
        ? Object.fromEntries(
          Object.entries(
            (JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")) as {
              mcpServers: Record<string, { timeout?: number }>;
            }).mcpServers,
          ).map(([name, server]) => [name, server.timeout]),
        )
        : undefined,
      cwd: process.cwd(),
      env: {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT,
        CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        CLAUDECODE: process.env.CLAUDECODE,
      },
    }) + "\n",
  );
}

if (args[0] === "--version") {
  console.log("2.1.999 (Claude Code)");
} else if (args[0] === "auth" && args[1] === "status") {
  const signed = existsSync(auth) ? JSON.parse(readFileSync(auth, "utf8")) : undefined;
  console.log(JSON.stringify(
    signed
      ? { loggedIn: true, authMethod: "claude.ai", email: signed.email }
      : { loggedIn: false, authMethod: "none" },
  ));
} else if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(
    "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.example/oauth?code=true&state=x\nPaste code here if prompted > ",
  );
  createInterface({ input: process.stdin }).once("line", (code) => {
    if (code.trim() !== "good-code") {
      console.log("\nThat code didn't work.");
      process.exit(1);
    }
    mkdirSync(home, { recursive: true });
    writeFileSync(auth, JSON.stringify({ email: "ana@example.com" }));
    console.log("\nLogin successful.");
    process.exit(0);
  });
} else if (args[0] === "-p") {
  session();
} else {
  console.error(`fake claude: ${args.join(" ")}?`);
  process.exit(2);
}

function session() {
  const resumed = flag("--resume");
  const id = resumed ?? flag("--session-id") ?? crypto.randomUUID();
  const transcript = join(
    home,
    "projects",
    process.cwd().replace(/[^a-zA-Z0-9]/g, "-"),
    `${id}.jsonl`,
  );
  if (resumed && !existsSync(transcript)) {
    console.error(`No conversation found with session ID: ${id}`);
    process.exit(1);
  }
  const system = readFileSync(flag("--system-prompt-file")!, "utf8");
  const config = JSON.parse(readFileSync(flag("--mcp-config")!, "utf8"));
  const [server, mcp] = Object.entries(config.mcpServers ?? {})[0] as [string, Json] ?? [];
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  };

  let asked = 0;
  const ask = async (method: string, params?: unknown) => {
    const response = await fetch(mcp.url, {
      method: "POST",
      headers: {
        ...mcp.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++asked, method, params }),
    });
    if (!response.ok) throw new Error(`MCP answered ${response.status}`);
    // JSON, or (a held call) an event stream whose one event is the answer.
    const text = await response.text();
    const body = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6))
      : JSON.parse(text);
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  let tools: string[] = [];
  let status = "connected";
  const connected = (async () => {
    if (!mcp) return;
    try {
      await ask("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fake-claude", version: "0" },
      });
      await fetch(mcp.url, {
        method: "POST",
        headers: { ...mcp.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).then((r) => r.body?.cancel());
      tools = (await ask("tools/list")).tools.map((tool: Json) => tool.name);
    } catch {
      status = "failed";
    }
  })();

  const delta = (delta: unknown) =>
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta },
      parent_tool_use_id: null,
      session_id: id,
    });
  const say = (text: string) => {
    for (const word of text.split(/(?<= )/)) delta({ type: "text_delta", text: word });
  };
  const result = (more: Json = {}) =>
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      session_id: id,
      result: "",
      usage,
      ...more,
    });
  const call = async (name: string, input: unknown, n: number) => {
    out({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: `toolu_${n}`, name: `mcp__${server}__${name}`, input }],
      },
      parent_tool_use_id: null,
      session_id: id,
    });
    const answer = await ask("tools/call", { name, arguments: input }).catch((error) => ({
      content: [{ type: "text", text: error.message }],
      isError: true,
    }));
    out({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, is_error: !!answer.isError }],
      },
      parent_tool_use_id: null,
      session_id: id,
    });
    return `${answer.isError ? "error " : ""}${answer.content?.[0]?.text}`;
  };

  let interrupted: (() => void) | undefined;
  const turn = async (message: Json) => {
    await connected;
    mkdirSync(dirname(transcript), { recursive: true });
    appendFileSync(transcript, JSON.stringify(message) + "\n");
    out({
      type: "system",
      subtype: "init",
      session_id: id,
      tools: [],
      mcp_servers: mcp ? [{ name: server, status }] : [],
      model: flag("--model"),
    });
    if (!existsSync(auth)) {
      out({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Not logged in · Please run /login" }],
        },
        error: "authentication_failed",
        parent_tool_use_id: null,
        session_id: id,
      });
      return result({ is_error: true, result: "Not logged in · Please run /login" });
    }
    // A person's message, as chat words it for a model, starts with who said it ("ana: say hi").
    const text = (message.message?.content ?? []).map((b: Json) => b.text ?? "").join("")
      .replace(/^\w+: /, "");
    const [command, ...rest] = text.split(" ");
    switch (command) {
      case "say":
        say(rest.join(" "));
        return result();
      case "think":
        delta({ type: "thinking_delta", thinking: "hmm" });
        say(rest.join(" "));
        return result();
      case "pid":
        say(String(process.pid));
        return result();
      case "system":
        say(system);
        return result();
      case "history":
        say(String(readFileSync(transcript, "utf8").split("\n").filter(Boolean).length));
        return result();
      case "tools":
        say(tools.join(","));
        return result();
      case "model":
        say(String(flag("--model")));
        return result();
      case "call": {
        say("calling ");
        say(`got ${await call(rest[0], JSON.parse(rest.slice(1).join(" ") || "{}"), 1)}`);
        return result();
      }
      case "calls": {
        const got = await Promise.all(rest.map((name: string, n: number) => call(name, {}, n)));
        say(`got ${got.join(" and ")}`);
        return result();
      }
      case "limit":
        out({ type: "rate_limit_event", rate_limit_info: { status: "rejected" }, session_id: id });
        return result({ is_error: true, result: "Claude AI usage limit reached" });
      case "badmodel":
        return result({
          is_error: true,
          result:
            "There's an issue with the selected model (x). It may not exist or you may not have access to it.",
        });
      case "big":
        delta({ type: "text_delta", text: "x".repeat(Number(rest[0]) * 1024) });
        return result();
      case "wait":
        await new Promise<void>((resolve) => interrupted = resolve);
        interrupted = undefined;
        return result({ subtype: "error_during_execution", is_error: true });
      case "crash":
        process.exit(3);
        break;
      default:
        say(`echo ${text}`);
        return result();
    }
  };

  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request?.subtype === "interrupt") {
      out({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id },
      });
      interrupted?.();
    } else if (message.type === "user") queue = queue.then(async () => void await turn(message));
  });
  lines.on("close", () => void queue.then(() => process.exit(0)));
}
