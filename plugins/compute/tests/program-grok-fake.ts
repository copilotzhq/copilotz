/**
 * A fake `grok`, for the Grok Build adapter's tests (program-grok.test.ts):
 * run as the computer runs `grok`, it says what it was started with (JSON
 * lines to `FAKE_LOG`: its arguments, its environment, the prompt on its
 * stdin, the session folder's MCP config) and answers as `grok -p
 * --output-format streaming-json` does. Each prompt is scripted by what it
 * says:
 *
 * - `say <words>`: thinks a little, then says them, word by word;
 * - `call <tool> <json>`: finds the agent's tool with `search_tool`, calls it
 *   with `use_tool` on the session folder's MCP server (held there until
 *   it's answered), then says `got <result>`;
 * - `recall`: says the prompts its session had before this one;
 * - `wait`: until it's stopped;
 * - `limit`, `badmodel`, `unauthorized`: fails as Grok does;
 * - `shell`: offers its own tools, as Grok does when an allowlist isn't
 *   honored.
 *
 * `models` says whether it's signed in (a file in its `GROK_HOME`,
 * `fake-auth.json`), `logout` deletes it, `login --device-code` shows a link
 * and a code, then signs in. Sessions are kept in its `GROK_HOME`, so a later
 * process resumes them (`-r`); `-s` makes a new one.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

// deno-lint-ignore no-explicit-any
type Json = any;

const args = process.argv.slice(2);
const home = process.env.GROK_HOME ?? join(process.env.HOME ?? "", ".grok");
const log = (entry: unknown) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
};
const auth = join(home, "fake-auth.json");
const out = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

if (args[0] === "--version") {
  console.log("grok 1.0.999 (fake)");
  process.exit(0);
}
if (args[0] === "models") {
  console.log(existsSync(auth) ? "You are logged in with grok.com." : "You are not authenticated.");
  console.log("\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6");
  process.exit(0);
}
if (args[0] === "logout") {
  rmSync(auth, { force: true });
  console.log("Logged out.");
  process.exit(0);
}
if (args[0] === "login") {
  log({ login: args });
  console.log("To sign in, open this URL in your browser:\n");
  console.log("  https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\n");
  console.log("Confirm this code in your browser:\n\n  ABCD-1234\n\nWaiting for authorization...");
  await new Promise((resolve) => setTimeout(resolve, 200));
  mkdirSync(home, { recursive: true });
  writeFileSync(auth, "{}");
  console.log("Signed in.");
  process.exit(0);
}

// `grok -p`: one prompt, its text on stdin.
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const cwd = flag("--cwd") ?? process.cwd();
const configPath = join(cwd, ".grok", "config.toml");
const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
log({
  args,
  env: { HOME: process.env.HOME, GROK_HOME: process.env.GROK_HOME, XAI: process.env.XAI_API_KEY },
  prompt,
  config,
  configMode: existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0,
  system: flag("--system-prompt-file") && readFileSync(flag("--system-prompt-file")!, "utf8"),
});

const fail = (message: string) => {
  out({ type: "error", message });
  console.error(`Error: ${message}`);
  process.exit(1);
};
if (!existsSync(auth)) {
  fail("Not signed in. To authenticate without a browser, run: grok login --device-code");
}

// Its sessions: the prompts each had, kept in its home.
const sessions = join(home, "fake-sessions");
mkdirSync(sessions, { recursive: true });
const id = flag("-s") ?? flag("-r")!;
const kept = join(sessions, `${id}.json`);
if (flag("-r") && !existsSync(kept)) fail(`No saved copy of session ${id} was found remotely.`);
if (flag("-s") && existsSync(kept)) fail(`Session ${id} is already in use`);
const before: string[] = existsSync(kept) ? JSON.parse(readFileSync(kept, "utf8")) : [];
writeFileSync(kept, JSON.stringify([...before, prompt]));

// Its own, as allowed, and the MCP server's tools, as Grok lists them (`<server>__<tool>`).
const server = /\[mcp_servers\.([^\]]+)\]/.exec(config ?? "")?.[1];
const tools = [
  ...(flag("--tools") ?? "").split(",").filter(Boolean),
  ...(server ? [`${server}__lookup`] : []),
];
const [verb, ...rest] = prompt.trim().split(" ");
out({
  type: "available_commands",
  tools: verb === "shell" ? ["run_terminal_command", ...tools] : tools,
  commands: ["compact"],
});

const say = (text: string) => {
  for (const word of text.split(/(?<= )/)) out({ type: "text", data: word });
};
const end = (input: number, cached: number, output: number) =>
  out({
    type: "end",
    stopReason: "end_turn",
    sessionId: id,
    usage: {
      input_tokens: input,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: output,
    },
  });

/** One JSON-RPC exchange with the session's MCP server over HTTP. */
async function mcp(message: Json): Promise<Json> {
  const url = /url = "([^"]+)"/.exec(config ?? "")?.[1];
  const authorization = /"Authorization" = "([^"]+)"/.exec(config ?? "")?.[1];
  if (!url) throw new Error("no MCP server");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.status === 202 ? undefined : await response.json();
}

switch (verb) {
  case "say":
    out({ type: "thought", data: "Thinking" });
    say(rest.join(" "));
    end(100, 40, 7);
    break;
  case "recall":
    say(before.join(" | ") || "nothing");
    end(10, 0, 2);
    break;
  case "call": {
    const [tool, ...json] = rest;
    out({ type: "tool_call", toolName: "search_tool", rawInput: { query: tool } });
    let text = "";
    try {
      await mcp({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      await mcp({ method: "notifications/initialized" });
      const listed = await mcp({ id: 2, method: "tools/list" });
      log({ listed: listed?.result?.tools?.map((t: Json) => t.name) });
      out({
        type: "tool_call",
        toolName: "use_tool",
        rawInput: { tool_name: `copilotz__${tool}`, tool_input: JSON.parse(json.join(" ")) },
      });
      const answer = await mcp({
        id: 3,
        method: "tools/call",
        params: { name: tool, arguments: JSON.parse(json.join(" ")) },
      });
      text = answer?.result?.content?.[0]?.text ?? JSON.stringify(answer?.error);
    } catch (error) {
      text = (error as Error).message;
    }
    say(`got ${text}`);
    end(120, 100, 3);
    break;
  }
  case "shell":
    out({ type: "tool_call", toolName: "run_terminal_command", rawInput: { command: "ls" } });
    say("listed");
    end(1, 0, 1);
    break;
  case "wait":
    // Until it's stopped (a timer keeps it alive: a promise alone wouldn't on every runtime).
    await new Promise((resolve) => setTimeout(resolve, 600_000));
    break;
  case "limit":
    fail("You've reached your usage limit. It resets in 3 hours.");
    break;
  case "badmodel":
    fail(`Model ${flag("-m")} not found`);
    break;
  case "unauthorized":
    fail("Unauthorized: authentication failed");
    break;
  default:
    say("ok");
    end(1, 0, 1);
}
process.exit(0);
