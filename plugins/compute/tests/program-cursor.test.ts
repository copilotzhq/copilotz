/**
 * A person's Cursor plan (`cursor`): Cursor's SDK, installed into the
 * engine's home, run by a runner the program writes beside it, with Node.
 * Its version, sign-in (a link, nothing pasted back), status and sign-out
 * are the runner's; a missing SDK is installed into its home first. A
 * session is a Cursor agent: the agent's instructions as its folder's one
 * rule, no tools but MCP, the session's MCP server alone, its key from the
 * engine's home; a prompt streams what it says and answers with what it
 * used; the agent's tool is held until it's answered; a later process
 * resumes a session; failures say why; cancelling stops a run. With a fake
 * SDK (program-cursor-sdk-fake.js), never the network.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runtime, tempDir, test } from "../../../testing/mod.ts";
import { createEngines } from "../computers/program/agents/engines.ts";
import { createMcp, type HeldCall } from "../computers/program/agents/mcp.ts";
import type { Peer, PromptResponse, SessionUpdate } from "../computers/program/agents/types.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** Node, which runs the runner: this runtime's, or the PATH's. */
const node = runtime === "node"
  ? process.execPath
  : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "node"))
    .find((path) => existsSync(path));

/** POSIX only (a shell installer), and where there's a Node to run the runner. */
const posix = (name: string, fn: () => Promise<void>) =>
  test({ name, ignore: process.platform === "win32" || !node, fn });

const FAKE = fileURLToPath(new URL("./program-cursor-sdk-fake.js", import.meta.url));

/** Puts the fake SDK where the installer would: `<dir>/node_modules/@cursor/sdk`. */
function installed(dir: string) {
  const sdk = join(dir, "node_modules", "@cursor", "sdk");
  mkdirSync(sdk, { recursive: true });
  cpSync(FAKE, join(sdk, "index.js"));
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@cursor/sdk",
      version: "1.5.0",
      type: "module",
      exports: "./index.js",
    }),
  );
}

const LOOKUP = {
  name: "lookup",
  description: "Looks a fact up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** A computer's engines, with Cursor's SDK installed in its home unless told, and signed in unless told. */
async function cursorOn(more: { sdk?: boolean; signedIn?: boolean } = {}) {
  const dir = tempDir();
  const root = join(dir, "root");
  const home = join(root, ".copilotz", "engines", "cursor");
  const log = join(dir, "log.jsonl");
  process.env.FAKE_LOG = log;
  if (more.sdk !== false) installed(home);
  const engines = createEngines({ root, commands: { cursor: node! }, log: () => {} });
  if (more.signedIn !== false && more.sdk !== false) {
    let step = await engines.login({ engine: "cursor" });
    while (step.state === "running") step = await engines.login({ engine: "cursor" });
  }
  const logged = (): Json[] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { dir, home, engines, logged };
}

type Agent = {
  peer: Peer;
  updates: SessionUpdate[];
  said(): string;
  thought(): string;
  newSession(params?: Json): Promise<string>;
  prompt(sessionId: string, text: string): Promise<PromptResponse>;
};

function agentOf(peer: Peer, cwd: string): Agent {
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
      const answer = await peer.request<{ sessionId: string }>("session/new", {
        cwd,
        mcpServers: [],
        _meta: { copilotz: { instructions: "You are Ada.", model: "claude-sonnet-5-5" } },
        ...params,
      });
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

/** The `data.code` a failure carries, or "done". */
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "done",
    (error) => (error as { data?: { code?: string } })?.data?.code ?? "thrown",
  );

posix(
  "Its version and sign-in are the runner's: a link, nothing pasted back; then its sign-out",
  async () => {
    const c = await cursorOn({ signedIn: false });
    try {
      const status = async () => (await c.engines.status(["cursor"]))[0];
      assertEquals(await status(), {
        engine: "cursor",
        installed: true,
        version: "1.5.0",
        signedIn: false,
      });
      let step = await c.engines.login({ engine: "cursor" });
      assertStringIncludes(step.url ?? "", "https://cursor.com/loginDeepControl");
      while (step.state === "running") step = await c.engines.login({ engine: "cursor" });
      assertEquals(step.signedIn, true);
      assertEquals(c.logged().find((l) => l.login).login, { apiKeyName: "Copilotz" });
      assertEquals(await status(), {
        engine: "cursor",
        installed: true,
        version: "1.5.0",
        signedIn: true,
        account: "ana@example.com",
      });
      // Its sign-in is a file in its home, apart from the person's own Cursor.
      assert(existsSync(join(c.home, "auth.json")));
      await c.engines.logout({ engine: "cursor" });
      assertEquals((await status()).signedIn, false);
    } finally {
      await c.engines.stop();
    }
  },
);

posix("Without its SDK it isn't installed; Sign in installs it into its home first", async () => {
  const c = await cursorOn({ sdk: false });
  try {
    assertEquals((await c.engines.status(["cursor"]))[0], {
      engine: "cursor",
      installed: false,
      signedIn: false,
    });
    // The installer runs knowing the engine's home, as Cursor's (`npm install --prefix`) needs.
    const fake = join(c.dir, "fake-installer.sh");
    writeFileSync(
      fake,
      `mkdir -p "$ENGINE_HOME/node_modules/@cursor/sdk" && cp ${JSON.stringify(FAKE)} ` +
        `"$ENGINE_HOME/node_modules/@cursor/sdk/index.js" && printf '%s' ` +
        `'{"name":"@cursor/sdk","version":"1.5.0","type":"module","exports":"./index.js"}' ` +
        `> "$ENGINE_HOME/node_modules/@cursor/sdk/package.json"`,
    );
    let step = await c.engines.login({ engine: "cursor", install: `sh ${JSON.stringify(fake)}` });
    while (step.state === "running") step = await c.engines.login({ engine: "cursor" });
    assertEquals(step.signedIn, true);
    assert(existsSync(join(c.home, "node_modules", "@cursor", "sdk", "package.json")));
  } finally {
    await c.engines.stop();
  }
});

posix(
  "A session is a Cursor agent: the agent's instructions as its rule, MCP's tools alone",
  async () => {
    const c = await cursorOn();
    const mcp = createMcp();
    const endpoint = await mcp.open([LOOKUP], () => {});
    const found = await c.engines.find("cursor");
    const cwd = await c.engines.folder(found, "You are Ada.");
    const agent = agentOf(c.engines.launch(found), cwd);
    try {
      const session = await agent.newSession({ mcpServers: [endpoint.server] });
      const made = c.logged().find((l) => l.created === session);
      assertEquals(made.options.tools, ["mcp"]);
      assertEquals(made.options.model, { id: "claude-sonnet-5-5" });
      assertEquals(made.options.local, { cwd, settingSources: ["project"] });
      assertEquals(made.options.mcpServers, {
        [endpoint.server.name]: {
          type: "http",
          url: endpoint.server.url,
          headers: { Authorization: endpoint.server.headers[0].value },
        },
      });
      // Its key, from its home's sign-in; its home is its HOME; no key the person keeps.
      assertEquals(made.key, "key_fake");
      assertEquals(made.env, { HOME: c.home });
      // The agent's instructions, over Cursor's own prompt: the folder's one rule, always applied.
      assertEquals(made.rule, "---\nalwaysApply: true\n---\nYou are Ada.\n");
      const answer = await agent.prompt(session, "say hello there");
      assertEquals(answer.stopReason, "end_turn");
      assertEquals(agent.said(), "hello there");
      assertEquals(agent.thought(), "Thinking");
      // What it used, as Copilotz counts it: every input token, the cache's among them.
      assertEquals(answer._meta?.copilotz?.usage, {
        input: 145,
        output: 7,
        cached: 40,
        cacheWrite: 5,
      });
    } finally {
      await agent.peer.close();
      endpoint.close();
      await mcp.close();
      await c.engines.stop();
    }
  },
);

posix(
  "The agent's tool is called on its MCP server and held there until it's answered",
  async () => {
    const c = await cursorOn();
    const mcp = createMcp();
    const held: HeldCall[] = [];
    const endpoint = await mcp.open([LOOKUP], (call) => held.push(call));
    const found = await c.engines.find("cursor");
    const agent = agentOf(c.engines.launch(found), await c.engines.folder(found, "You are Ada."));
    try {
      const session = await agent.newSession({ mcpServers: [endpoint.server] });
      let answered = false;
      const answer = agent.prompt(session, 'call lookup {"q":"mascot"}').finally(() =>
        answered = true
      );
      for (let i = 0; i < 300 && !held.length; i++) await new Promise((r) => setTimeout(r, 20));
      assertEquals([held[0].name, held[0].arguments], ["lookup", { q: "mascot" }]);
      await new Promise((r) => setTimeout(r, 300));
      assert(!answered, "it waits for the held call");
      held[0].settle({ content: "A heron named Ada" });
      assertEquals((await answer).stopReason, "end_turn");
      assertEquals(agent.said(), "got A heron named Ada");
      assertEquals(c.logged().find((l) => l.listed).listed, ["lookup"]);
    } finally {
      await agent.peer.close();
      endpoint.close();
      await mcp.close();
      await c.engines.stop();
    }
  },
);

posix("A later process resumes a session; failures say why; cancelling stops a run", async () => {
  const c = await cursorOn();
  const found = await c.engines.find("cursor");
  const cwd = await c.engines.folder(found, "You are Ada.");
  const first = agentOf(c.engines.launch(found), cwd);
  let session = "";
  try {
    session = await first.newSession();
    await first.prompt(session, "say one");
    assertEquals(await outcome(first.prompt(session, "limit")), "limit");
    assertEquals(await outcome(first.prompt(session, "badmodel")), "model");
    assertEquals(await outcome(first.prompt(session, "unauthorized")), "signed_out");
    // Stopped: it ends cancelled; another prompt meanwhile is refused.
    const waiting = first.prompt(session, "wait");
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(await outcome(first.prompt(session, "say again")), "failed");
    first.peer.notify("session/cancel", { sessionId: session });
    assertEquals((await waiting).stopReason, "cancelled");
  } finally {
    await first.peer.close();
  }
  const again = agentOf(c.engines.launch(found), cwd);
  try {
    await again.peer.request("initialize", { protocolVersion: 1 });
    const params = {
      cwd,
      mcpServers: [],
      _meta: { copilotz: { instructions: "You are Ada.", model: "claude-sonnet-5-5" } },
    };
    await again.peer.request("session/load", { ...params, sessionId: session });
    assertEquals(c.logged().find((l) => l.resumed === session).options.tools, ["mcp"]);
    await again.prompt(session, "recall");
    assertStringIncludes(again.said(), "say one");
    // One Cursor doesn't have: its loading fails (the conversation starts afresh, given it all).
    assertEquals(
      await outcome(again.peer.request("session/load", { ...params, sessionId: "agent-gone" })),
      "failed",
    );
    // Signed out: no session starts.
    await c.engines.logout({ engine: "cursor" });
    assertEquals(
      await outcome(again.peer.request("session/new", params)),
      "signed_out",
    );
  } finally {
    await again.peer.close();
    await c.engines.stop();
  }
});
