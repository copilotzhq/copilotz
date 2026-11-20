/**
 * Codex as an ACP agent (agents/codex.ts): `codex app-server` started with
 * none of its own tools, a session a thread with the agent's instructions,
 * model and MCP server alone, a prompt a turn streamed as ACP updates, the
 * agent's tool held on the MCP server until it's answered, cancelling an
 * interruption, what Codex asks a person declined, and failures that say
 * why. With a fake `codex` (program-codex-fake.ts).
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runtime, tempDir, test } from "../../../testing/mod.ts";
import {
  codex,
  failureOf,
  inputOf,
  lockCatalog,
  overrides,
} from "../computers/program/agents/codex.ts";
import { createEngines } from "../computers/program/agents/engines.ts";
import { createMcp, type HeldCall } from "../computers/program/agents/mcp.ts";
import type { Peer, PromptResponse, SessionUpdate } from "../computers/program/agents/types.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const mkdir = (path: string) => mkdirSync(path, { recursive: true });

/** POSIX only: the fake is a shell script. */
const posix = (name: string, fn: () => Promise<void>) =>
  test({ name, ignore: process.platform === "win32", fn });

const LOOKUP = {
  name: "lookup",
  description: "Looks a fact up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** A fake `codex` in a new folder, its home beside it, signed in with ChatGPT unless told. */
function fake(account: unknown = { type: "chatgpt", email: "ana@example.com" }) {
  const dir = tempDir();
  const log = join(dir, "log.jsonl");
  const home = join(dir, "home");
  const command = join(dir, "codex");
  const source = fileURLToPath(new URL("./program-codex-fake.ts", import.meta.url));
  const run = runtime === "deno"
    ? ["run", "-A", source]
    : runtime === "bun"
    ? ["run", source]
    : ["--no-warnings", source];
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    command,
    `#!/bin/sh\nexport FAKE_LOG=${quote(log)}\nmkdir -p ${quote(home)}\nexec ${
      [process.execPath, ...run].map(quote).join(" ")
    } "$@"\n`,
    { mode: 0o755 },
  );
  const lines: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CODEX_HOME = home;
  const signIn = (as: unknown) => {
    mkdir(home);
    writeFileSync(join(home, "fake-auth.json"), JSON.stringify(as));
  };
  return {
    dir,
    home,
    command,
    env,
    /** What the adapter logged. */
    lines,
    /** Starts the adapter on the fake. */
    start(extra: Record<string, string> = {}): Agent {
      // Its home is there, as the engines make it.
      mkdir(home);
      if (account) signIn(account);
      return agentOf(
        codex({ command, home, env: { ...env, ...extra }, log: (line) => lines.push(line) }),
      );
    },
    signIn,
    /** What the fake said it was started with and asked, in order. */
    logged(): Json[] {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) =>
          JSON.parse(l)
        );
      } catch {
        return [];
      }
    },
  };
}

type Agent = {
  peer: Peer;
  updates: SessionUpdate[];
  /** What it said (text), since the last prompt. */
  said(): string;
  /** What it thought, since the last prompt. */
  thought(): string;
  newSession(params?: Json): Promise<string>;
  prompt(sessionId: string, text: string): Promise<PromptResponse>;
};

function agentOf(peer: Peer): Agent {
  const updates: SessionUpdate[] = [];
  peer.onNotification((method, params) => {
    if (method === "session/update") updates.push(params.update);
  });
  const text = (kind: string) =>
    updates.filter((u) => u.sessionUpdate === kind).map((u) => (u.content as Json).text).join("");
  return {
    peer,
    updates,
    said: () => text("agent_message_chunk"),
    thought: () => text("agent_thought_chunk"),
    async newSession(params?: Json) {
      await peer.request("initialize", { protocolVersion: 1 });
      const answer = await peer.request<{ sessionId: string }>(
        "session/new",
        params ?? {
          cwd: tempDir(),
          mcpServers: [],
          _meta: { copilotz: { instructions: "You are Ada.", model: "fake-model" } },
        },
      );
      return answer.sessionId;
    },
    prompt(sessionId: string, words: string) {
      updates.length = 0;
      return peer.request<PromptResponse>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: words }],
      });
    },
  };
}

/** The `data.code` a failure carries. */
const codeOf = (error: unknown) => (error as { data?: { code?: string } })?.data?.code;

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<Error & { data?: Json }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { data?: Json };
  }
  throw new Error("It didn't fail");
}

// What's done by functions alone, on every platform.

test("Codex's settings go as -c arguments, TOML values with dotted keys", () => {
  assertEquals(
    overrides({ a: { b: false, c: "x", d: [] }, e: [1, "y"], f: {}, g: { h: { i: 2 } } }),
    [
      "-c",
      "a.b=false",
      "-c",
      'a.c="x"',
      "-c",
      "a.d=[]",
      "-c",
      'e=[1,"y"]',
      "-c",
      "f={}",
      "-c",
      "g.h.i=2",
    ],
  );
});

test("Its models' catalog brings none of their own tools", () => {
  const locked = lockCatalog({
    models: [{
      slug: "m",
      tool_mode: "code_mode_only",
      apply_patch_tool_type: "freeform",
      supports_search_tool: true,
      context_window: 9,
    }],
    etag: "x",
  });
  assertEquals(locked.etag, "x");
  assertEquals(locked.models[0].slug, "m");
  assertEquals(locked.models[0].context_window, 9);
  assert(!("tool_mode" in locked.models[0]));
  assertEquals(locked.models[0].apply_patch_tool_type, null);
  assertEquals(locked.models[0].supports_search_tool, false);
  assertEquals(locked.models[0].experimental_supported_tools, []);
  assertEquals(lockCatalog({ models: [] }), undefined);
  assertEquals(lockCatalog("nope"), undefined);
});

test("A turn's failure says why: a sign-in, a limit, a model", () => {
  assertEquals(failureOf({ codexErrorInfo: "unauthorized" }), "signed_out");
  assertEquals(
    failureOf({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }),
    "signed_out",
  );
  assertEquals(failureOf({ codexErrorInfo: "usageLimitExceeded" }), "limit");
  assertEquals(failureOf({ codexErrorInfo: "rateLimitExceeded" }), "limit");
  assertEquals(
    failureOf({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } }),
    "limit",
  );
  assertEquals(failureOf({ codexErrorInfo: "modelNotFound" }), "model");
  assertEquals(
    failureOf({
      message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
    }),
    "model",
  );
  assertEquals(failureOf({ message: "You've hit your usage limit. Try again later." }), "limit");
  assertEquals(failureOf({ codexErrorInfo: "internalServerError", message: "boom" }), "failed");
  assertEquals(failureOf(undefined), "failed");
});

test("ACP content becomes a turn's input", () => {
  assertEquals(
    inputOf([
      { type: "text", text: "hi" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "image", uri: "https://example.com/a.png" },
      { type: "image", uri: "file:///etc/passwd" },
      { type: "resource", resource: { uri: "file:///a.md", text: "# A" } },
      { type: "resource_link", uri: "https://example.com/b", name: "b" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
    ]),
    [
      { type: "text", text: "hi", text_elements: [] },
      { type: "image", url: "data:image/jpeg;base64,AAAA" },
      { type: "image", url: "https://example.com/a.png" },
      { type: "text", text: "# A", text_elements: [] },
      { type: "text", text: "b: https://example.com/b", text_elements: [] },
    ],
  );
});

// With the fake.

posix("Codex starts with none of its own tools, its models without theirs", async () => {
  const codex = fake();
  const agent = codex.start();
  try {
    const init: Json = await agent.peer.request("initialize", { protocolVersion: 1 });
    assertEquals(init.protocolVersion, 1);
    assertEquals(init.agentCapabilities.loadSession, true);
    assertEquals(init.agentCapabilities.mcpCapabilities.http, true);
    const logged = codex.logged();
    const { args, env } = logged.find((l) => l.started).started;
    assertEquals(args[0], "app-server");
    const set = args.filter((_: string, i: number) => args[i - 1] === "-c");
    for (
      const setting of [
        "features.shell_tool=false",
        "features.unified_exec=false",
        "features.view_image=false",
        "features.multi_agent=false",
        "features.apps=false",
        "features.plugins=false",
        "features.computer_use=false",
        "features.browser_use=false",
        'web_search="disabled"',
        "tools.experimental_request_user_input.enabled=false",
        "skills.bundled.enabled=false",
        "include_environment_context=false",
        "include_permissions_instructions=false",
        "project_doc_max_bytes=0",
        "notify=[]",
        'forced_login_method="chatgpt"',
      ]
    ) assert(set.includes(setting), `${setting} in ${set.join(" ")}`);
    const catalog = join(codex.home, "copilotz-models.json");
    assert(set.includes(`model_catalog_json=${JSON.stringify(catalog)}`));
    const model = JSON.parse(readFileSync(catalog, "utf8")).models[0];
    assertEquals(model.slug, "fake-model");
    assert(!("tool_mode" in model));
    assertEquals(model.apply_patch_tool_type, null);
    assertEquals(env.CODEX_HOME, codex.home);
    const { initialize } = logged.find((l) => l.initialize);
    assertEquals(initialize.clientInfo.name, "copilotz");
    assertEquals(initialize.capabilities.experimentalApi, true);
  } finally {
    await agent.peer.close();
  }
});

posix("Codex without a catalog to read still starts, and says so", async () => {
  const codex = fake();
  const agent = codex.start({ FAKE_NO_CATALOG: "1" });
  try {
    await agent.peer.request("initialize", { protocolVersion: 1 });
    const { args } = codex.logged().find((l) => l.started).started;
    assert(!args.some((a: string) => a.startsWith("model_catalog_json=")));
    assert(codex.lines.some((l) => /couldn't read Codex's models/.test(l)), codex.lines.join("\n"));
  } finally {
    await agent.peer.close();
  }
});

posix(
  "A session is a thread with the agent's instructions, model and MCP server alone",
  async () => {
    const codex = fake();
    mkdir(codex.home);
    writeFileSync(
      join(codex.home, "fake-config.json"),
      JSON.stringify({
        mcp_servers: {
          theirs: { url: "http://127.0.0.1:9/mcp", enabled: true, tool_timeout_sec: null },
          local: { command: "node", args: ["x.js"], env: { A: "1" } },
        },
      }),
    );
    const mcp = createMcp();
    const endpoint = await mcp.open([LOOKUP], () => {});
    const agent = codex.start();
    try {
      const cwd = tempDir();
      const sessionId = await agent.newSession({
        cwd,
        mcpServers: [endpoint.server],
        _meta: { copilotz: { instructions: "You are Ada.", model: "gpt-x" } },
      });
      const { id, params } = codex.logged().find((l) => l.thread === "start");
      assertEquals(id, sessionId);
      assertEquals(params.baseInstructions, "You are Ada.");
      assertEquals(params.model, "gpt-x");
      assertEquals(params.cwd, cwd);
      assertEquals(params.approvalPolicy, "never");
      assertEquals(params.sandbox, "read-only");
      const servers = params.config.mcp_servers;
      const ours = servers[endpoint.server.name];
      assertEquals(ours.url, endpoint.server.url);
      assertEquals(ours.http_headers, { Authorization: endpoint.server.headers[0].value });
      assertEquals(ours.omit_tools_from, ["code_mode", "deferred"]);
      assertEquals(ours.default_tools_approval_mode, "approve");
      assertEquals(ours.tool_timeout_sec, 86_400);
      assertEquals(ours.required, true);
      // The home's own servers are off, given whole (Codex wants a server's transport).
      assertEquals(servers.theirs, { url: "http://127.0.0.1:9/mcp", enabled: false });
      assertEquals(servers.local, {
        command: "node",
        args: ["x.js"],
        env: { A: "1" },
        enabled: false,
      });
    } finally {
      await agent.peer.close();
      endpoint.close();
      await mcp.close();
    }
  },
);

posix("A prompt streams what it says and thinks, and answers with what it used", async () => {
  const codex = fake();
  const agent = codex.start();
  try {
    const session = await agent.newSession();
    const answer = await agent.prompt(session, "say hello there");
    assertEquals(answer.stopReason, "end_turn");
    assertEquals(answer._meta?.copilotz?.usage, { input: 100, output: 7, cached: 40 });
    assertEquals(agent.said(), "hello there");
    assertEquals(agent.thought(), "Thinking\n\nMore");
    assertEquals(
      agent.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").length,
      2,
    );
    assertEquals(codex.logged().find((l) => l.turn).turn, [
      { type: "text", text: "say hello there", text_elements: [] },
    ]);
  } finally {
    await agent.peer.close();
  }
});

posix(
  "The agent's tool is called on its MCP server and held there until it's answered",
  async () => {
    const codex = fake();
    const mcp = createMcp();
    const held: HeldCall[] = [];
    const endpoint = await mcp.open([LOOKUP], (call) => held.push(call));
    const agent = codex.start();
    try {
      const session = await agent.newSession({
        cwd: tempDir(),
        mcpServers: [endpoint.server],
        _meta: { copilotz: { instructions: "You are Ada.", model: "fake-model" } },
      });
      let answered = false;
      const answer = agent.prompt(session, 'call lookup {"q":"mascot"}').finally(() =>
        answered = true
      );
      const end = Date.now() + 10_000;
      while (!held.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assertEquals(held.length, 1);
      assertEquals(held[0].name, "lookup");
      assertEquals(held[0].arguments, { q: "mascot" });
      await new Promise((r) => setTimeout(r, 300));
      assert(!answered, "it waits for the held call");
      const call = agent.updates.find((u) => u.sessionUpdate === "tool_call") as Json;
      assertEquals(call.title, "lookup");
      assertEquals(call.rawInput, { q: "mascot" });
      held[0].settle({ content: "A heron named Ada" });
      const done = await answer;
      assertEquals(done.stopReason, "end_turn");
      assertEquals(agent.said(), "got A heron named Ada");
      // Both of the turn's model requests.
      assertEquals(done._meta?.copilotz?.usage, { input: 220, output: 8, cached: 100 });
      const ended = agent.updates.find((u) => u.sessionUpdate === "tool_call_update") as Json;
      assertEquals(ended.toolCallId, call.toolCallId);
      assertEquals(ended.status, "completed");
      assertEquals(codex.logged().find((l) => l.listed).listed, ["lookup"]);
    } finally {
      await agent.peer.close();
      endpoint.close();
      await mcp.close();
    }
  },
);

posix("Cancelling interrupts the turn; another prompt meanwhile is refused", async () => {
  const codex = fake();
  const agent = codex.start();
  try {
    const session = await agent.newSession();
    const answer = agent.prompt(session, "wait");
    await new Promise((r) => setTimeout(r, 200));
    const busy = await failure(agent.peer.request("session/prompt", {
      sessionId: session,
      prompt: [{ type: "text", text: "say no" }],
    }));
    assertEquals(codeOf(busy), "failed");
    agent.peer.notify("session/cancel", { sessionId: session });
    assertEquals((await answer).stopReason, "cancelled");
    assert(codex.logged().some((l) => l.interrupt?.threadId === session));
    // The session goes on.
    assertEquals((await agent.prompt(session, "say again")).stopReason, "end_turn");
  } finally {
    await agent.peer.close();
  }
});

posix("What Codex asks a person is declined", async () => {
  const codex = fake();
  const agent = codex.start();
  try {
    const session = await agent.newSession();
    await agent.prompt(session, "ask");
    assertEquals(agent.said(), 'answered {"decision":"decline"}');
    assert(codex.lines.some((l) => /declined .*requestApproval/.test(l)), codex.lines.join("\n"));
  } finally {
    await agent.peer.close();
  }
});

posix("A failed turn says why; a refusal is an answer", async () => {
  const codex = fake();
  const agent = codex.start();
  try {
    const session = await agent.newSession();
    for (
      const [words, code] of [
        ["limit", "limit"],
        ["badmodel", "model"],
        ["unauthorized", "signed_out"],
      ]
    ) {
      const error = await failure(agent.prompt(session, words));
      assertEquals(codeOf(error), code, `${words}: ${error.message}`);
    }
    assert(codex.lines.some((l) => /retrying/.test(l)));
    assertEquals((await agent.prompt(session, "refuse")).stopReason, "refusal");
  } finally {
    await agent.peer.close();
  }
});

posix("Signed out, or signed in with a key, no session starts", async () => {
  const codex = fake(null);
  const agent = codex.start();
  try {
    assertEquals(codeOf(await failure(agent.newSession())), "signed_out");
    codex.signIn({ type: "apiKey" });
    const error = await failure(agent.newSession());
    assertEquals(codeOf(error), "signed_out");
    assertMatch(error.message, /key/);
  } finally {
    await agent.peer.close();
  }
});

posix("An MCP server Codex can't reach fails the session", async () => {
  const codex = fake();
  const agent = codex.start();
  try {
    const error = await failure(agent.newSession({
      cwd: tempDir(),
      mcpServers: [{
        type: "http",
        name: "copilotz",
        url: "http://127.0.0.1:9/mcp/x",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      }],
      _meta: { copilotz: { instructions: "You are Ada.", model: "fake-model" } },
    }));
    assertEquals(codeOf(error), "failed");
    assertMatch(error.message, /couldn't reach the agent's tools/);
  } finally {
    await agent.peer.close();
  }
});

posix("A later process takes a session up again; one Codex doesn't have fails", async () => {
  const codex = fake();
  const mcp = createMcp();
  const endpoint = await mcp.open([LOOKUP], () => {});
  const params = {
    cwd: tempDir(),
    mcpServers: [endpoint.server],
    _meta: { copilotz: { instructions: "You are Ada.", model: "fake-model" } },
  };
  const first = codex.start();
  let session: string;
  try {
    session = await first.newSession(params);
    await first.prompt(session, "say one");
  } finally {
    await first.peer.close();
  }
  const ended = await first.peer.closed;
  assertEquals(ended.error, undefined);
  const second = codex.start();
  try {
    await second.peer.request("initialize", { protocolVersion: 1 });
    assertEquals(await second.peer.request("session/load", { ...params, sessionId: session }), {});
    const resumed = codex.logged().find((l) => l.thread === "resume");
    assertEquals(resumed.id, session);
    assertEquals(resumed.params.baseInstructions, "You are Ada.");
    assertEquals(resumed.params.config.mcp_servers.copilotz.url, endpoint.server.url);
    await second.prompt(session, "turns");
    assertEquals(second.said(), "turns 2");
    const missing = await failure(
      second.peer.request("session/load", { ...params, sessionId: "no-such-thread" }),
    );
    assertEquals(codeOf(missing), "failed");
  } finally {
    await second.peer.close();
    endpoint.close();
    await mcp.close();
  }
});

posix("Codex stopping fails the prompt, and the peer is closed", async () => {
  const codex = fake();
  const agent = codex.start();
  const session = await agent.newSession();
  const error = await failure(agent.prompt(session, "crash"));
  assertEquals(codeOf(error), "failed");
  assertMatch(error.message, /Codex stopped/);
  const ended = await agent.peer.closed;
  assertEquals(ended.code, 3);
  assertMatch(ended.error ?? "", /crashed/);
  await assertRejects(() => agent.peer.request("session/new", {}));
});

posix("Codex is signed in only with ChatGPT, as the engines say", async () => {
  const codex = fake(null);
  const root = tempDir();
  const engines = createEngines({ root, commands: { codex: codex.command }, log: () => {} });
  const home = join(root, ".copilotz", "engines", "codex");
  const status = async () => (await engines.status(["codex"]))[0];
  try {
    assertEquals(await status(), {
      engine: "codex",
      installed: true,
      version: "0.999.0",
      signedIn: false,
    });
    mkdir(home);
    writeFileSync(join(home, "fake-auth.json"), JSON.stringify({ type: "apiKey" }));
    assertEquals((await status()).signedIn, false);
    writeFileSync(join(home, "fake-auth.json"), JSON.stringify({ type: "chatgpt" }));
    assertEquals((await status()).signedIn, true);
    // Started by the engines: its home is its own.
    const found = await engines.find("codex");
    const agent = agentOf(engines.launch(found));
    try {
      await agent.newSession();
      const started = codex.logged().filter((l) => l.started).at(-1).started;
      assertEquals(started.env.CODEX_HOME, home);
    } finally {
      await agent.peer.close();
    }
  } finally {
    await engines.stop();
  }
});
