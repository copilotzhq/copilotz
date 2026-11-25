/**
 * The computer's engines, as the plugin uses them: a plan's CLI runs an
 * agent's model call, its events streamed step by step; a tool call ends a
 * step and waits, held, for the next one to answer it; sessions go on in
 * the same process, are loaded again when they're gone, and are fixed to
 * what they were made with. Signing in installs a missing CLI first, with
 * the installer it's given; signing out is each CLI's own, in its home. With fake CLIs: Claude Code's stream-json
 * (program-agents-claude.ts), and a native ACP agent (program-agents-acp.ts),
 * and fake installers (never the network).
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { tempDir, test } from "../../../testing/mod.ts";
import { createMcp } from "../computers/program/agents/mcp.ts";
import { alive } from "../computers/program/workloads/processes.ts";
import type { AgentsOptions } from "../computers/program/workloads/agents.ts";
import {
  type EngineStatus,
  type LoginState,
  type PromptEvent,
  type PromptInput,
  WORK,
} from "../computers/shared/workloads.ts";
import { fakeCli } from "./fake-cli.ts";
import { type Setup, setup, until } from "./program-setup.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** POSIX only: the fakes are shell scripts. */
const posix = (name: string, fn: () => Promise<void>) =>
  test({ name, ignore: process.platform === "win32", fn });

type Started = {
  pid: number;
  args: string[];
  /** The MCP servers' timeouts it was given (Claude Code's fake). */
  timeouts?: Record<string, number | undefined>;
  cwd: string;
  env: Record<string, string>;
  home: string;
};

type Engines = Setup & {
  /** What each fake was started with, in order. */
  started(name: "claude" | "agy"): Started[];
  /** Signs an engine's fake in. */
  signIn(engine: "claude" | "antigravity"): void;
  /** One step: its events, until its stream ends. */
  step(input: Partial<PromptInput>): Promise<PromptEvent[]>;
  /** A step's stream, read by hand. */
  open(input: Partial<PromptInput>): Promise<ReadableStreamDefaultReader<Uint8Array>>;
  /** What the computer logged, in order. */
  logged: string[];
};

/** Runs `fn` with a computer whose `claude` and `agy` are fakes (and no `codex`). */
function engines(fn: (e: Engines) => Promise<void>, agents: AgentsOptions = {}) {
  return async () => {
    const dir = tempDir();
    const logs = { claude: join(dir, "claude.log"), agy: join(dir, "agy.log") };
    const logged: string[] = [];
    const commands = {
      claude: fakeCli(dir, "claude", "./program-agents-claude.ts", logs.claude),
      antigravity: fakeCli(dir, "agy", "./program-agents-acp.ts", logs.agy),
      codex: null,
    };
    await setup(async (s) => {
      const home = (engine: string) => join(s.root, ".copilotz", "engines", engine);
      const open = async (input: Partial<PromptInput>) => {
        const job = await s.rt.workers.dispatch(
          "computer",
          "c1",
          WORK.agentsPrompt,
          encoder.encode(JSON.stringify(input)),
        );
        return job.output.getReader();
      };
      await fn({
        ...s,
        started: (name) =>
          existsSync(logs[name])
            ? readFileSync(logs[name], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
            : [],
        signIn(engine) {
          mkdirSync(home(engine), { recursive: true });
          if (engine === "claude") {
            writeFileSync(join(home(engine), "fake-auth.json"), '{"email":"ana@example.com"}');
          } else writeFileSync(join(home(engine), ".fake-signed-in"), "yes");
        },
        open,
        step: async (input) => await events(await open(input)),
        logged,
      });
    }, { agents: { commands, ...agents }, log: (line: string) => void logged.push(line) });
  };
}

/** Events from a step's stream, until it ends (or `enough` says so: then it's left). */
async function events(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  enough?: (events: PromptEvent[]) => boolean,
): Promise<PromptEvent[]> {
  const all: PromptEvent[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      all.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    if (enough?.(all)) {
      await reader.cancel();
      break;
    }
  }
  return all;
}

/** What the model said, in order. */
const said = (events: PromptEvent[]) =>
  events.map((e) =>
    e.type === "update" && (e.update as { sessionUpdate: string }).sessionUpdate ===
        "agent_message_chunk"
      ? (e.update as { content: { text: string } }).content.text
      : ""
  ).join("");

const last = (events: PromptEvent[]) => events[events.length - 1];
const sessionOf = (events: PromptEvent[]) =>
  (events.find((e) => e.type === "session") as { session: string } | undefined)?.session;

const LOOKUP = {
  name: "lookup",
  description: "Looks a fact up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};
const base = {
  engine: "claude",
  model: "sonnet",
  instructions: "You are North, the team's planner.",
  tools: [LOOKUP],
};
let ids = 0;
const ask = (prompt: string, more: Partial<PromptInput> = {}): Partial<PromptInput> => ({
  ...base,
  prompt: [{ type: "text", text: prompt }],
  id: `p${++ids}`,
  ...more,
});

posix(
  "a fresh session says which it is, streams what the model says, and ends with its usage",
  engines(async ({ step, started, signIn }) => {
    signIn("claude");
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-the-persons-own";
    let events: PromptEvent[];
    try {
      events = await step(ask("say hello there"));
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
    assertEquals(events.map((e) => e.i), events.map((_, i) => i));
    assertEquals(events[0].type, "session");
    assertEquals(said(events), "hello there");
    assertEquals(last(events), {
      i: events.length - 1,
      type: "done",
      stopReason: "end_turn",
      usage: { input: 10, output: 5, cached: 3, cacheWrite: 2 },
    });
    // Its own home, no provider's key, and only the agent's tools, from a file.
    const [run] = started("claude").filter((s) => s.args[0] === "-p");
    const flag = (name: string) => run.args[run.args.indexOf(name) + 1];
    assertMatch(run.env.CLAUDE_CONFIG_DIR, /\.copilotz\/engines\/claude$/);
    assertEquals(run.env.ANTHROPIC_API_KEY, undefined);
    // A held call waits a day, however long it's silent: Claude Code's idle limit, for its server too.
    assertEquals(run.env.MCP_TOOL_TIMEOUT, "86400000");
    assertEquals(run.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "86400000");
    assertEquals(run.timeouts, { copilotz: 86_400_000 });
    assertEquals(run.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
    assertEquals([flag("--tools"), flag("--setting-sources")], ["", ""]);
    assertEquals(flag("--allowedTools"), "mcp__copilotz");
    assertEquals(flag("--model"), "sonnet");
    assertEquals(flag("--session-id"), sessionOf(events));
    assert(run.args.includes("--strict-mcp-config"));
    assert(!run.args.join(" ").includes("Bearer"), "its token isn't on its command line");
    assertMatch(run.cwd, /\.copilotz\/engines\/claude\/work\/[0-9a-f]{32}$/);
  }),
);

posix(
  "its instructions are its system prompt; the agent's tools are what it sees",
  engines(async ({ step, signIn }) => {
    signIn("claude");
    assertEquals(said(await step(ask("system"))), base.instructions);
    assertEquals(said(await step(ask("tools"))), "lookup");
  }),
);

posix(
  "a tool call ends the step; the same prompt answers it and goes on, numbered on",
  engines(async ({ step, signIn }) => {
    signIn("claude");
    const first = ask('call lookup {"q":"on call"}');
    const one = await step(first);
    const call = last(one);
    assert(call.type === "call");
    assertEquals([call.call.name, call.call.arguments], ["lookup", { q: "on call" }]);
    assertEquals(said(one), "calling ");
    // A tool's progress isn't passed on: the call itself is.
    assert(
      !one.some((e) =>
        e.type === "update" && (e.update as { sessionUpdate: string }).sessionUpdate === "tool_call"
      ),
      "only the call",
    );
    const two = await step({
      ...first,
      session: sessionOf(one),
      prompt: [],
      from: call.i + 1,
      results: [{ id: call.call.id, content: "Ana and Bo" }],
    });
    assertEquals(two[0].i, call.i + 1);
    assertEquals(said(two), "got Ana and Bo");
    assertEquals(last(two).type, "done");
  }),
);

posix(
  "calls that come together are one step; an error answer reaches the model as one",
  engines(async ({ step, signIn }) => {
    signIn("claude");
    const tools = [LOOKUP, { name: "weather", inputSchema: { type: "object" } }];
    const first = ask("calls lookup weather", { tools });
    const one = await step(first);
    const calls = one.filter((e) => e.type === "call");
    assertEquals(calls.map((c) => c.call.name).sort(), ["lookup", "weather"]);
    assertEquals(last(one).type, "call");
    const two = await step({
      ...first,
      session: sessionOf(one),
      prompt: [],
      from: last(one).i + 1,
      results: calls.map((c) => ({
        id: c.call.id,
        content: c.call.name === "lookup" ? "Ana" : "No such city",
        ...(c.call.name === "weather" ? { isError: true } : {}),
      })),
    });
    assertMatch(said(two), /got (Ana and error No such city|error No such city and Ana)/);
  }),
);

posix(
  "a session goes on in the same process; another agent's is stale; a new prompt leaves one still running, and cancel ends one",
  engines(async ({ step, open, signIn, work, logged }) => {
    signIn("claude");
    const first = await step(ask("pid"));
    const session = sessionOf(first)!;
    const again = await step(ask("pid", { session }));
    assertEquals(again.some((e) => e.type === "session"), false);
    assertEquals(said(again), said(first));
    assertEquals(said(await step(ask("history", { session }))), "3");
    for (
      const other of [{ instructions: "You are someone else." }, { model: "opus" }, { tools: [] }]
    ) {
      const failed = last(await step(ask("say hi", { session, ...other })));
      assertEquals(failed.type === "failed" && failed.code, "stale");
    }
    // Why it didn't answer is on the computer's log, for whoever looks into it after.
    assert(
      logged.some((line) =>
        /^claude: prompt .+ failed \(stale\): That session has another engine/.test(line)
      ),
      logged.join("\n"),
    );

    // The conversation went on without an answer still running (its turn stopped): that answer is
    // left, and its session, which has it, with it; the new prompt starts afresh.
    const reader = await open(ask("wait", { session }));
    await until(async () => {
      const left = last(await step(ask("say hi", { session })));
      return left.type === "failed" && left.code === "stale";
    }, "a new prompt leaves the running one");
    const ended = last(await events(reader));
    assertEquals(ended.type === "failed" && ended.code, "stale");

    // Cancelled, a running prompt ends as cancelled, with what it used.
    const other = sessionOf(await step(ask("pid")))!;
    const waiting = await open(ask("wait", { session: other }));
    await new Promise((r) => setTimeout(r, 1000));
    assertEquals(await work(WORK.agentsCancel, { session: other }), { ok: true });
    const cancelled = last(await events(waiting));
    assertEquals(cancelled.type === "done" && cancelled, {
      i: cancelled.i,
      type: "done",
      stopReason: "cancelled",
      usage: { input: 10, output: 5, cached: 3, cacheWrite: 2 },
    });
  }),
);

posix(
  "leaving a step only detaches: the prompt goes on, and the same id comes back for the rest",
  engines(async ({ open, step, signIn, logged }) => {
    signIn("claude");
    const first = ask('call lookup {"q":"x"}');
    const seen = await events(await open(first), (all) => all.length >= 1);
    assertEquals(seen[0].type, "session");
    // Left before it ended: the computer's log says so, and that the prompt runs on.
    await until(
      () =>
        logged.some((line) => /^claude: the app left prompt .+ \(cancelled\) after /.test(line)),
      "the left step logged",
    );
    const rest = await step({ ...first, session: sessionOf(seen), from: 1 });
    assertEquals(rest[0].i, 1);
    const call = last(rest);
    assert(call.type === "call");
    // Coming back again from the same place gives the same events.
    const replay = await step({ ...first, session: sessionOf(seen), from: 1 });
    assertEquals(replay, rest);
    const done = await step({
      ...first,
      session: sessionOf(seen),
      prompt: [],
      from: call.i + 1,
      results: [{ id: call.call.id, content: "yes" }],
    });
    assertEquals([said(done), last(done).type], ["got yes", "done"]);
    // A prompt it doesn't know, come back to: its events are gone.
    const unknown = await step({ ...ask("say hi"), from: 3 });
    assertEquals(unknown, [{
      i: 3,
      type: "failed",
      code: "lost",
      message: "This prompt's events were dropped: start again",
    }]);
  }),
);

posix(
  "a session it no longer has is loaded again with --resume; one Claude Code doesn't keep is stale",
  engines(async ({ step, signIn, started, computer, start }) => {
    signIn("claude");
    const first = await step(ask("say one"));
    const session = sessionOf(first)!;
    await computer.stop();
    const restarted = await start();
    await restarted.ready;
    const again = await step(ask("history", { session }));
    assertEquals(again.some((e) => e.type === "session"), false);
    assertEquals(said(again), "2");
    const resumed = started("claude").filter((s) => s.args.includes("--resume"));
    assertEquals(resumed.map((s) => s.args[s.args.indexOf("--resume") + 1]), [session]);
    const gone = last(
      await step(ask("say hi", { session: "00000000-0000-4000-8000-000000000000" })),
    );
    assertEquals(gone.type === "failed" && gone.code, "stale");
  }),
);

posix(
  "failures are events: signed out, a plan's limit, a model it hasn't, no CLI",
  engines(async ({ step, signIn }) => {
    const code = async (input: Partial<PromptInput>) => {
      const event = last(await step(input));
      return event.type === "failed" ? event.code : event.type;
    };
    assertEquals(await code(ask("say hi")), "signed_out");
    signIn("claude");
    assertEquals(await code(ask("limit")), "limit");
    assertEquals(await code(ask("badmodel")), "model");
    assertEquals(await code(ask("say hi", { engine: "codex" })), "missing");
    assertEquals(await code(ask("say hi", { engine: "nope" })), "failed");
    assertEquals(await code({ id: "x" }), "failed");
  }),
);

posix(
  "status: which engines it has, their versions, and who they're signed in as",
  engines(async ({ work, signIn }) => {
    assertEquals(await work<EngineStatus[]>(WORK.agentsStatus, { engines: ["claude", "codex"] }), [
      { engine: "claude", installed: true, version: "2.1.999", signedIn: false },
      { engine: "codex", installed: false, signedIn: false },
    ]);
    signIn("claude");
    signIn("antigravity");
    const all = await work<EngineStatus[]>(WORK.agentsStatus, {});
    assertEquals(all.map((s) => s.engine), ["claude", "codex", "antigravity"]);
    assertEquals(all[0], {
      engine: "claude",
      installed: true,
      version: "2.1.999",
      signedIn: true,
      account: "ana@example.com",
    });
    assertEquals(all[2], {
      engine: "antigravity",
      installed: true,
      version: "1.4.2",
      signedIn: true,
    });
  }),
);

posix(
  "signing in: its link, then the code pasted, then signed in",
  engines(async ({ work }) => {
    const login = (input: Record<string, unknown>) =>
      work<LoginState>(WORK.agentsLogin, { engine: "claude", ...input });
    let state = await login({});
    let output = state.output;
    while (!state.url) output += (state = await login({})).output;
    assertEquals(state.state, "running");
    assertEquals(state.url, "https://claude.example/oauth?code=true&state=x");
    assertMatch(output, /Paste code here/);
    state = await login({ input: "good-code" });
    while (state.state === "running") state = await login({});
    assertEquals([state.state, state.signedIn], ["done", true]);
    // Stopped, one under way ends signed out.
    const agy = await work<LoginState>(WORK.agentsLogin, { engine: "antigravity" });
    assertEquals(agy.state, "running");
    const stopped = await work<LoginState>(WORK.agentsLogin, { engine: "antigravity", stop: true });
    assertEquals([stopped.state, stopped.signedIn], ["done", false]);
    const none = await work<{ error: { code: string } }>(WORK.agentsLogin, {
      engine: "antigravity",
      input: "x",
    });
    assertEquals(none.error.code, "not_found");
  }),
);

posix(
  "signing in a missing CLI installs it first, in the computer's home; a failed installer says why",
  async () => {
    const dir = tempDir();
    const home = join(tempDir(), "home");
    const agy = fakeCli(dir, "agy", "./program-agents-acp.ts", join(dir, "agy.log"));
    // Antigravity's installer, as a fake: it puts the CLI in ~/.local/bin, saying where.
    const installer = join(dir, "install.sh");
    writeFileSync(
      installer,
      `#!/bin/sh\necho "Installing into $HOME (from https://example.com/agy.tar.gz)"\n` +
        `mkdir -p "$HOME/.local/bin" && cp '${agy}' "$HOME/.local/bin/agy"\necho Installed.\n`,
      { mode: 0o755 },
    );
    // So no Antigravity of this machine's is found: only what's installed in the home.
    const PATH = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      await setup(async ({ work }) => {
        const login = (input: Record<string, unknown>) =>
          work<LoginState>(WORK.agentsLogin, { engine: "antigravity", ...input });
        const poll = async (state: LoginState, done: (state: LoginState) => boolean) => {
          let output = state.output;
          while (!done(state)) output += (state = await login({})).output;
          return { ...state, output };
        };
        const status = async () =>
          (await work<EngineStatus[]>(WORK.agentsStatus, { engines: ["antigravity"] }))[0];

        // Not asked to install: missing, as before.
        const missing = await work<{ error: { code: string } }>(WORK.agentsLogin, {
          engine: "antigravity",
        });
        assertEquals(missing.error.code, "missing");

        // An installer that fails: what it said, and still not installed.
        const failed = await poll(
          await login({ install: "echo 'curl: (6) Could not resolve host' >&2; exit 6" }),
          (state) => state.state === "done",
        );
        assertEquals([failed.signedIn, failed.url], [false, undefined]);
        assertMatch(failed.output, /Could not resolve host/);
        assertEquals((await status()).installed, false);

        // Its installer, then its sign-in: the link is the sign-in's, not the installer's.
        const linked = await poll(
          await login({ install: `'${installer}'` }),
          (state) => !!state.url || state.state === "done",
        );
        assertMatch(linked.output, new RegExp(`Installing into ${home}`));
        assertMatch(linked.output, /Installed\.\nSign in at/);
        assertEquals([linked.state, linked.url], ["running", "https://agy.example/login"]);
        const done = await poll(
          await login({ input: "good-code" }),
          (state) => state.state === "done",
        );
        assertEquals(done.signedIn, true);
        assertEquals(await status(), {
          engine: "antigravity",
          installed: true,
          version: "1.4.2",
          signedIn: true,
        });
        assert(existsSync(join(home, ".local", "bin", "agy")), "installed in the computer's home");
      }, { home, agents: { commands: { claude: null, codex: null } } });
    } finally {
      process.env.PATH = PATH;
    }
  },
);

posix(
  "signing out closes its sessions first, then signs its CLI out; with no CLI there, its home goes",
  engines(async ({ work, root, step, signIn }) => {
    const home = (engine: string) => join(root, ".copilotz", "engines", engine);
    const status = async () =>
      (await work<EngineStatus[]>(WORK.agentsStatus, { engines: ["claude"] }))[0];
    signIn("claude");
    const pid = Number(said(await step(ask("pid"))));
    assertEquals((await status()).signedIn, true);
    assertEquals(await work(WORK.agentsLogout, { engine: "claude" }), { ok: true });
    assert(!alive(pid), "its session's process ended");
    assert(!existsSync(join(home("claude"), "fake-auth.json")), "its sign-in is gone");
    assert(existsSync(home("claude")), "by its own sign-out: its home stays");
    assertEquals(await status(), {
      engine: "claude",
      installed: true,
      version: "2.1.999",
      signedIn: false,
    });
    // No Codex here to sign out: its home, where its sign-in is, goes.
    mkdirSync(home("codex"), { recursive: true });
    writeFileSync(join(home("codex"), "fake-auth.json"), '{"type":"chatgpt"}');
    assertEquals(await work(WORK.agentsLogout, { engine: "codex" }), { ok: true });
    assert(!existsSync(home("codex")), "its home is gone");
    const unknown = await work<{ error: { code: string } }>(WORK.agentsLogout, { engine: "x" });
    assertEquals(unknown.error.code, "invalid");
  }),
);

posix(
  "each CLI signs out in its own home, never the person's own; Antigravity's can't be from here",
  async () => {
    const dir = tempDir();
    const person = join(tempDir(), "home");
    const log = join(dir, "fake.log");
    // The person's own sign-ins, in their own config: never Copilotz's to touch.
    for (const own of [".claude", ".codex"]) {
      mkdirSync(join(person, own), { recursive: true });
      writeFileSync(join(person, own, "fake-auth.json"), '{"type":"chatgpt","email":"ana@x"}');
    }
    const commands = {
      claude: fakeCli(dir, "claude", "./program-agents-claude.ts", log),
      codex: fakeCli(dir, "codex", "./program-codex-fake.ts", log),
      antigravity: fakeCli(dir, "agy", "./program-agents-acp.ts", log),
    };
    await setup(async ({ work, root }) => {
      const home = (engine: string) => join(root, ".copilotz", "engines", engine);
      for (const engine of ["claude", "codex"]) {
        mkdirSync(home(engine), { recursive: true });
        writeFileSync(join(home(engine), "fake-auth.json"), '{"type":"chatgpt","email":"ana@x"}');
      }
      const signed = async () =>
        (await work<EngineStatus[]>(WORK.agentsStatus, { engines: ["claude", "codex"] }))
          .map((s) => s.signedIn);
      assertEquals(await signed(), [true, true]);
      for (const engine of ["claude", "codex"]) {
        assertEquals(await work(WORK.agentsLogout, { engine }), { ok: true });
        assert(existsSync(home(engine)), `${engine} signed out by its own CLI`);
      }
      assertEquals(await signed(), [false, false]);
      for (const own of [".claude", ".codex"]) {
        assert(existsSync(join(person, own, "fake-auth.json")), `the person's own ${own} stays`);
      }
      // Antigravity has no sign-out of its own: it says so, and what to do.
      const agy = await work<{ error: { code: string; message: string } }>(WORK.agentsLogout, {
        engine: "antigravity",
      });
      assertEquals(agy.error.code, "unsupported");
      assertMatch(agy.error.message, /keyring.*Sign out in agy on the computer itself/s);
    }, { home: person, agents: { commands } });
  },
);

posix(
  "a native agent: its rules, its settings and its model; only the agent's tools are allowed",
  engines(async ({ step, signIn, started }) => {
    const agy = (prompt: string, more: Partial<PromptInput> = {}) =>
      ask(prompt, { engine: "antigravity", model: "gemini-3-flash", ...more });
    const out = last(await step(agy("rules")));
    assertEquals(out.type === "failed" && out.code, "signed_out");
    signIn("antigravity");
    const rules = await step(agy("rules"));
    assertEquals(said(rules), base.instructions);
    assertEquals(last(rules), {
      i: last(rules).i,
      type: "done",
      stopReason: "end_turn",
      usage: { input: 7, output: 3 },
    });
    const session = sessionOf(rules)!;
    assertEquals(said(await step(agy("model", { session }))), "gemini-3-flash");
    assertMatch(said(await step(agy("settings", { session }))), /"command\(\*\)"/);
    assertEquals(said(await step(agy("shell", { session }))), "shell: no");
    assertEquals(said(await step(agy("fs", { session }))), "fs: refused");
    const first = agy("call lookup", { session });
    const one = await step(first);
    const call = last(one);
    assert(call.type === "call");
    const two = await step({
      ...first,
      prompt: [],
      from: call.i + 1,
      results: [{ id: call.call.id, content: "Carla" }],
    });
    assertEquals(said(two), "got Carla");
    const [run] = started("agy").filter((s) => s.args[0] === "acp" && s.args.length === 2);
    assertEquals(run.args, ["acp", "--process-per-session"]);
    assertMatch(run.home, /\.copilotz\/engines\/antigravity$/);
    const unknown = last(await step(agy("rules", { model: "gpt-9" })));
    assertEquals(unknown.type === "failed" && unknown.code, "model");
    // It can't load a session: one it no longer has is stale.
    const stale = last(await step(agy("rules", { session: "agy-0-0" })));
    assertEquals(stale.type === "failed" && stale.code, "stale");
  }),
);

posix(
  "a prompt past its buffer is lost, with its session; an idle session's process stops",
  engines(async ({ step, signIn, started }) => {
    signIn("claude");
    const big = ask("big 64");
    const lost = await step(big);
    assertEquals(last(lost).type === "failed" && last(lost), {
      i: last(lost).i,
      type: "failed",
      code: "lost",
      message: "This prompt's events were dropped: start again",
    });
    const again = last(await step({ ...big, from: 1 }));
    assertEquals(again.type === "failed" && again.code, "lost");

    const first = await step(ask("pid"));
    const pid = Number(said(first));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the idle session's process stopped");
    const back = await step(ask("history", { session: sessionOf(first) }));
    assertEquals(said(back), "2");
    assert(started("claude").some((s) => s.args.includes("--resume")));
  }, { maxBuffer: 16 * 1024, idleMs: 300 }),
);

test("the tools' server: its token, its tools, held calls, an unknown tool", async () => {
  const mcp = createMcp();
  try {
    const held: { name: string; settle(r: { content: string }): void }[] = [];
    const door = await mcp.open([LOOKUP], (call) => held.push(call));
    const token = door.server.headers[0].value;
    const post = (body: unknown, headers: Record<string, string> = { authorization: token }) =>
      fetch(door.server.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const rpc = async (method: string, params?: unknown) =>
      await (await post({ jsonrpc: "2.0", id: 1, method, params })).json();
    const status = async (response: Promise<Response>) => {
      const { status, body } = await response;
      await body?.cancel();
      return status;
    };
    assertEquals(await status(post({}, {})), 401);
    assertEquals(await status(post({}, { authorization: "Bearer nope" })), 401);
    assertEquals(
      await status(post({}, { authorization: token, origin: "https://evil.example" })),
      403,
    );
    assertEquals(await status(fetch(door.server.url, { headers: { authorization: token } })), 405);
    assertEquals(await status(post({ jsonrpc: "2.0", method: "notifications/initialized" })), 202);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    assertEquals(init.result.protocolVersion, "2025-06-18");
    assertEquals((await rpc("tools/list")).result.tools, [LOOKUP]);
    assertEquals((await rpc("tools/call", { name: "rm" })).error.code, -32602);
    const answer = rpc("tools/call", { name: "lookup", arguments: { q: "a" } });
    await until(() => held.length === 1, "the call is held");
    held[0].settle({ content: "Ana" });
    assertEquals((await answer).result, { content: [{ type: "text", text: "Ana" }] });
    // Taking an event stream, a held call is one: comments while it waits, then its answer.
    const streamed = await post({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "lookup", arguments: {} },
    }, { authorization: token, accept: "application/json, text/event-stream" });
    assertEquals(streamed.headers.get("content-type"), "text/event-stream");
    const reader = streamed.body!.getReader();
    assertEquals(decoder.decode((await reader.read()).value), ": held\n\n");
    await until(() => held.length === 2, "the streamed call is held");
    held[1].settle({ content: "Bo" });
    let rest = "";
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      rest += decoder.decode(read.value);
    }
    assertEquals(
      rest,
      `event: message\ndata: ${
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          result: { content: [{ type: "text", text: "Bo" }] },
        })
      }\n\n`,
    );
    // A door closed answers what it holds as failed, and opens no more.
    const pending = rpc("tools/call", { name: "lookup", arguments: {} });
    await until(() => held.length === 3, "the third call is held");
    door.close();
    assertEquals((await pending).result.isError, true);
    assertEquals(await status(post({ jsonrpc: "2.0", id: 1, method: "ping" })), 404);
  } finally {
    await mcp.close();
  }
});
