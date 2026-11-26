/**
 * Grok Build as an ACP agent (agents/grok.ts): `grok -p`, a process per
 * prompt, started with the agent's instructions as its whole system prompt,
 * none of its own tools, no memory, subagents, plan mode or web search; a
 * session Grok's own (`-s`, then `-r`), in a folder of its own whose MCP
 * config names the session's server alone (its token there only while a
 * prompt runs); what it says streamed as ACP updates, with what it used; the
 * agent's tool held until it's answered; tools of its own failing the prompt;
 * a session it doesn't have `stale`; failures that say why; cancelling; and
 * its sign-in, status and sign-out, in a home of its own. With a fake `grok`
 * (program-grok-fake.ts).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { tempDir, test } from "../../../testing/mod.ts";
import { createEngines } from "../computers/program/agents/engines.ts";
import { createMcp, type HeldCall } from "../computers/program/agents/mcp.ts";
import type { Peer, PromptResponse, SessionUpdate } from "../computers/program/agents/types.ts";
import { fakeCli } from "./fake-cli.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** POSIX only: the fake is a shell script. */
const posix = (name: string, fn: () => Promise<void>) =>
  test({ name, ignore: process.platform === "win32", fn });

const LOOKUP = {
  name: "lookup",
  description: "Looks a fact up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** Grok Build's engine, on a fake `grok`, in a computer of its own: signed in unless told. */
async function grokOn(signedIn = true) {
  const dir = tempDir();
  const log = join(dir, "log.jsonl");
  const root = join(dir, "root");
  const command = fakeCli(dir, "grok", "./program-grok-fake.ts", log);
  const lines: string[] = [];
  const engines = createEngines({ root, commands: { grok: command }, log: (l) => lines.push(l) });
  const found = await engines.find("grok");
  if (signedIn) {
    let step = await engines.login({ engine: "grok" });
    while (step.state === "running") step = await engines.login({ engine: "grok" });
  }
  const logged = (): Json[] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { engines, found, logged, lines, home: found.home };
}

/** Waits for something to hold. */
async function until(holds: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await holds()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out");
}

type Agent = {
  peer: Peer;
  updates: SessionUpdate[];
  said(): string;
  thought(): string;
  newSession(params?: Json): Promise<string>;
  prompt(sessionId: string, text: string): Promise<PromptResponse>;
};

function agentOf(peer: Peer, cwd = tempDir()): Agent {
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
          cwd,
          mcpServers: [],
          _meta: { copilotz: { instructions: "You are Ada.", model: "grok-4.7" } },
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

/** The `data.code` a failure carries, or "done". */
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "done",
    (error) => (error as { data?: { code?: string } })?.data?.code ?? "thrown",
  );

posix(
  "A prompt runs `grok -p` as only the engine: the agent's prompt, none of its tools",
  async () => {
    const g = await grokOn();
    const cwd = tempDir();
    const agent = agentOf(g.engines.launch(g.found), cwd);
    try {
      const session = await agent.newSession();
      const answer = await agent.prompt(session, "say hello there");
      assertEquals(answer.stopReason, "end_turn");
      assertEquals(agent.said(), "hello there");
      assertEquals(agent.thought(), "Thinking");
      // What it used, as Copilotz counts it: every input token, the cache's among them.
      assertEquals(answer._meta?.copilotz?.usage, { input: 140, output: 7, cached: 40 });
      const run = g.logged().filter((l) => l.args).at(-1);
      const flag = (name: string) => run.args[run.args.indexOf(name) + 1];
      assertEquals(run.args.slice(0, 3), ["-p", "-s", session]);
      assertEquals(flag("--output-format"), "streaming-json");
      assertEquals(flag("--tools"), "search_tool,use_tool");
      assertEquals(flag("-m"), "grok-4.7");
      assertEquals(flag("--cwd"), join(cwd, session));
      for (const off of ["--no-memory", "--no-subagents", "--no-plan", "--disable-web-search"]) {
        assert(run.args.includes(off), off);
      }
      assert(run.args.includes("--trust") && run.args.includes("--always-approve"));
      assertEquals(run.system, "You are Ada.");
      assertEquals(run.prompt, "say hello there");
      // Its own home: never the person's, and no xAI key.
      assertEquals(run.env.HOME, g.home);
      assertEquals(run.env.GROK_HOME, join(g.home, ".grok"));
      assertEquals(run.env.XAI, undefined);
      // Its system prompt's file is gone with the process.
      assert(!existsSync(flag("--system-prompt-file")), "the prompt's file is removed");
    } finally {
      await agent.peer.close();
      await g.engines.stop();
    }
  },
);

posix("The agent's tool is the session's MCP server alone, held until it's answered", async () => {
  const g = await grokOn();
  const mcp = createMcp();
  const held: HeldCall[] = [];
  const endpoint = await mcp.open([LOOKUP], (call) => held.push(call));
  const cwd = tempDir();
  const agent = agentOf(g.engines.launch(g.found), cwd);
  try {
    const session = await agent.newSession({
      cwd,
      mcpServers: [endpoint.server],
      _meta: { copilotz: { instructions: "You are Ada.", model: "grok-4.7" } },
    });
    let answered = false;
    const answer = agent.prompt(session, 'call lookup {"q":"mascot"}').finally(() =>
      answered = true
    );
    await until(() => held.length > 0);
    assertEquals([held[0].name, held[0].arguments], ["lookup", { q: "mascot" }]);
    await new Promise((r) => setTimeout(r, 300));
    assert(!answered, "it waits for the held call");
    held[0].settle({ content: "A heron named Ada" });
    const done = await answer;
    assertEquals(done.stopReason, "end_turn");
    assertEquals(agent.said(), "got A heron named Ada");
    const run = g.logged().filter((l) => l.args).at(-1);
    // The session's server alone, its token in a file only its user reads, a held call waiting a day.
    assertEquals(run.configMode, 0o600);
    assertStringIncludes(run.config, `[mcp_servers.${endpoint.server.name}]`);
    assertStringIncludes(run.config, `url = "${endpoint.server.url}"`);
    assertStringIncludes(run.config, endpoint.server.headers[0].value);
    assertStringIncludes(run.config, "tool_timeout_sec = 86400");
    assertEquals(g.logged().find((l) => l.listed).listed, ["lookup"]);
    // The token is gone with the process.
    assert(!existsSync(join(cwd, session, ".grok", "config.toml")), "the config is removed");
  } finally {
    await agent.peer.close();
    endpoint.close();
    await mcp.close();
    await g.engines.stop();
  }
});

posix("A session goes on in a later process; one Grok doesn't have is stale", async () => {
  const g = await grokOn();
  const cwd = tempDir();
  const first = agentOf(g.engines.launch(g.found), cwd);
  let session = "";
  try {
    session = await first.newSession();
    await first.prompt(session, "say one");
    await first.prompt(session, "recall");
    assertEquals(first.said(), "say one");
  } finally {
    await first.peer.close();
  }
  // After a restart: the same session, taken up again (`-r`).
  const again = agentOf(g.engines.launch(g.found), cwd);
  try {
    await again.peer.request("initialize", { protocolVersion: 1 });
    const params = {
      cwd,
      mcpServers: [],
      _meta: { copilotz: { instructions: "You are Ada.", model: "grok-4.7" } },
    };
    await again.peer.request("session/load", { ...params, sessionId: session });
    await again.prompt(session, "recall");
    assertEquals(again.said(), "say one | recall");
    assertEquals(g.logged().filter((l) => l.args).at(-1).args.slice(0, 3), ["-p", "-r", session]);
    // One it never had: stale, so the conversation starts afresh, given it all.
    const gone = crypto.randomUUID();
    await again.peer.request("session/load", { ...params, sessionId: gone });
    assertEquals(await outcome(again.prompt(gone, "recall")), "stale");
  } finally {
    await again.peer.close();
    await g.engines.stop();
  }
});

posix("Tools of its own, offered anyway, fail the prompt before the model acts", async () => {
  const g = await grokOn();
  const agent = agentOf(g.engines.launch(g.found));
  try {
    const session = await agent.newSession();
    assertEquals(await outcome(agent.prompt(session, "shell")), "failed");
    assertEquals(agent.said(), "");
    assert(
      g.lines.some((l) => /tools of its own: run_terminal_command/.test(l)),
      g.lines.join("\n"),
    );
  } finally {
    await agent.peer.close();
    await g.engines.stop();
  }
});

posix("A failed prompt says why: a sign-in, a limit, a model; cancelling stops it", async () => {
  const g = await grokOn();
  const agent = agentOf(g.engines.launch(g.found));
  try {
    const session = await agent.newSession();
    assertEquals(await outcome(agent.prompt(session, "limit")), "limit");
    assertEquals(await outcome(agent.prompt(session, "badmodel")), "model");
    assertEquals(await outcome(agent.prompt(session, "unauthorized")), "signed_out");
    // Stopped: it ends cancelled, and the process with it.
    const waiting = agent.prompt(session, "wait");
    await until(() => g.logged().some((l) => l.prompt === "wait"));
    assertEquals(await outcome(agent.prompt(session, "say again")), "failed");
    agent.peer.notify("session/cancel", { sessionId: session });
    assertEquals((await waiting).stopReason, "cancelled");
    await g.engines.logout({ engine: "grok" });
    assertEquals(await outcome(agent.prompt(session, "say hi")), "signed_out");
  } finally {
    await agent.peer.close();
    await g.engines.stop();
  }
});

posix(
  "Its sign-in is a device code; its status, and its plan's models, are what `grok models` says; sign-out its own",
  async () => {
    const g = await grokOn(false);
    try {
      const status = async () => (await g.engines.status(["grok"]))[0];
      assertEquals(await status(), {
        engine: "grok",
        installed: true,
        version: "1.0.999",
        signedIn: false,
      });
      let step = await g.engines.login({ engine: "grok" });
      assertEquals(step.url, "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
      while (step.state === "running") step = await g.engines.login({ engine: "grok" });
      assertEquals(step.signedIn, true);
      assertEquals(g.logged().find((l) => l.login).login, ["login", "--device-code"]);
      assertEquals(await status(), {
        engine: "grok",
        installed: true,
        version: "1.0.999",
        signedIn: true,
        models: ["grok-4.7", "grok-4.6"],
      });
      await g.engines.logout({ engine: "grok" });
      assertEquals((await status()).signedIn, false);
      assertMatch(g.home, /\.copilotz\/engines\/grok$/);
    } finally {
      await g.engines.stop();
    }
  },
);
