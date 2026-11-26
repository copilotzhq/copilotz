/**
 * Agents' model calls on their person's plan (`claude-plan/…`), through its
 * CLI on a computer of theirs: a scripted computer stands in for the
 * program (see program-agents.test.ts for that). A turn's tool call ends a
 * step while the CLI waits; the next step sends the result and goes on with
 * the same answer. The next turn goes on in the same session with only
 * what's new. Someone with no plan signed in goes straight to the next model.
 * Signing in asked to install sends the plan's official installer, and only then.
 * A cloud computer signed in to a plan isn't shared with others' agents until it's signed out
 * there; a person's own computer may be. Signed in on one that's shared, the plan doesn't run there.
 * A plan that lists its models runs a model only when its list has it: the next plan does then,
 * and its computer is never asked.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import process from "node:process";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Message, tool } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { computers, type Desk } from "../mod.ts";
import type { PlansConnected } from "../../models/contract.ts";
import {
  type EngineStatus,
  type PromptEvent,
  type PromptInput,
  WORK,
} from "../computers/shared/workloads.ts";
import { startComputer } from "../computers/program/computer.ts";
import { host, tempDir, test } from "../../../testing/mod.ts";
import { fakeCli } from "./fake-cli.ts";
import { fakeComputer } from "./fake-computer.ts";
import { servingOrder } from "../computers/shared/serving.ts";

const ana: Actor = { kind: "person", id: "ana" };
const cy: Actor = { kind: "person", id: "cy" };
const encoder = new TextEncoder();

const text = (i: number, said: string): PromptEvent => ({
  i,
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } },
});

/** What the CLI does with each step it's asked for. */
function cli(asked: PromptInput[]) {
  return (input: PromptInput): PromptEvent[] => {
    asked.push(input);
    if (input.results?.length) {
      // The tool's answer came: the same answer goes on from where it was.
      return [text(3, `Thanks: ${input.results[0].content}`), {
        i: 4,
        type: "done",
        stopReason: "end_turn",
        usage: { input: 100, output: 20 },
      }];
    }
    if (input.session) {
      return [text(0, "Again, from the same session."), {
        i: 1,
        type: "done",
        stopReason: "end_turn",
      }];
    }
    return [
      { i: 0, type: "session", session: "s-1" },
      text(1, "Let me look."),
      { i: 2, type: "call", call: { id: "c-1", name: "lookup", arguments: { who: "on call" } } },
    ];
  };
}

async function setup(
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    asked: PromptInput[];
    /** What sign-ins and sign-outs the computer was asked for. */
    logins: Record<string, unknown>[];
    logouts: Record<string, unknown>[];
    /** What the computer says of its Claude Code from now on: signed in or not. */
    report(signedIn: boolean): void;
    history: (thread: string, actor: Actor) => Promise<Message[]>;
    send: (said: string, actor: Actor, thread?: string) => Promise<string>;
  }) => Promise<void>,
) {
  const topic = `engines-test.${crypto.randomUUID()}`;
  const app = definePlugin({
    name: "app",
    actions: {
      // Which plans `actor` has connected here, as the tiers ask on each turn.
      "test.connected": defineAction({
        input: { type: "object" },
        run: (ctx, input: { actor: Actor }) => ctx.as(input.actor).call("computer.connected", {}),
      }),
      // Her computer, gone quiet (as it last said: still signed in).
      "test.offline": defineAction({
        input: { type: "object" },
        run: (ctx) =>
          ctx.as().db.collection("computer").updateMany({}, { $set: { online: false } }),
      }),
    },
    resources: {
      shared: { thread: {}, message: {} },
      agents: {
        north: {
          instructions: "Lead.",
          model: ["claude-plan/claude-haiku-5-5", "fake/echo"],
          default: true,
          tools: ["lookup"],
        },
      },
      tools: {
        lookup: tool({ description: "Looks up who's on call.", run: () => "Ana is on call" }),
      },
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const asked: PromptInput[] = [];
  const logins: Record<string, unknown>[] = [];
  const logouts: Record<string, unknown>[] = [];
  let signedIn = true;
  const answer = cli(asked);
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const computer = fakeComputer(topic, `code:${code}`, {
      workloads: {
        [WORK.agentsStatus]: () =>
          encoder.encode(JSON.stringify([
            signedIn
              ? { engine: "claude", installed: true, signedIn, account: "ana@example.com" }
              : { engine: "claude", installed: true, signedIn },
          ])),
        [WORK.agentsLogout]: async ({ input }) => {
          logouts.push(JSON.parse(await new Response(input).text()));
          signedIn = false;
          return encoder.encode(JSON.stringify({ ok: true }));
        },
        [WORK.agentsLogin]: async ({ input }) => {
          logins.push(JSON.parse(await new Response(input).text()));
          return encoder.encode(JSON.stringify({ state: "done", output: "", signedIn: true }));
        },
        [WORK.agentsPrompt]: async ({ input }) => {
          const events = answer(JSON.parse(await new Response(input).text()) as PromptInput);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of events) {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              }
              controller.close();
            },
          });
        },
      },
    });
    await computer.worker.ready;
    for (let i = 0; i < 300; i++) {
      if ((await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana }))[0]?.online) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Her plan, signed in there: what her settings show, and what calls go by.
    const shown = await rt.call<{ engines: Record<string, { signedIn: boolean }> }[]>(
      "computer.engines",
      {},
      { actor: ana },
    );
    assertEquals(shown[0].engines.claude?.signedIn, true);
    await fn({
      rt,
      asked,
      logins,
      logouts,
      report: (said) => signedIn = said,
      history: (thread, actor) => rt.query<Message[]>("message.history", { thread }, { actor }),
      send: async (said, actor, thread) => {
        const where = actor === ana
          ? { in: space }
          : await rt.call<{ space: string }>("space.personal", {}, { actor })
            .then(({ space }) => ({ in: space }));
        const sent = await rt.call<{ thread: string }>("chat.send", {
          text: said,
          ...(thread ? { thread } : where),
        }, { actor });
        await rt.idle();
        return sent.thread;
      },
    });
    await computer.worker.stop();
  } finally {
    await rt.close();
  }
}

test("a turn runs on its person's plan: a tool call ends a step, and the next goes on with its answer", async () => {
  await setup(async (s) => {
    const thread = await s.send("who's on call?", ana);
    const said = (await s.history(thread, ana)).filter((m) => m.from === "north");
    assertStringIncludes(said.map((m) => m.text ?? "").join(" "), "Let me look.");
    assertStringIncludes(said.at(-1)!.text!, "Thanks: ");
    assertStringIncludes(said.at(-1)!.text!, "Ana is on call");

    // Asked once afresh, with the agent's own instructions and tools, then again to go on.
    assertEquals(s.asked.length, 2);
    const [first, second] = s.asked;
    assertEquals([first.engine, first.model, first.session], [
      "claude",
      "claude-haiku-5-5",
      undefined,
    ]);
    assertStringIncludes(first.instructions, "Lead.");
    assert(first.tools.some((t) => t.name === "lookup"), "the agent's tools, as MCP's");
    assertStringIncludes(JSON.stringify(first.prompt), "who's on call?");
    assertEquals([second.session, second.id, second.from], ["s-1", first.id, 3]);
    assertEquals(second.results?.map((r) => r.id), ["c-1"]);
    assertStringIncludes(second.results![0].content, "Ana is on call");

    // The next turn goes on in the same session, given only what's new.
    await s.send("and tomorrow?", ana, thread);
    const third = s.asked[2];
    assertEquals(third.session, "s-1");
    assertStringIncludes(JSON.stringify(third.prompt), "and tomorrow?");
    assert(!JSON.stringify(third.prompt).includes("who's on call?"), "only what's new");
    const last = (await s.history(thread, ana)).at(-1)!;
    assertEquals([last.from, last.text], ["north", "Again, from the same session."]);
  });
});

test("someone with no plan signed in goes straight to the next model, and no computer is asked", async () => {
  await setup(async (s) => {
    const thread = await s.send("hello there", cy);
    const last = (await s.history(thread, cy)).at(-1)!;
    assertEquals(last.from, "north");
    assertStringIncludes(last.text ?? "", "hello there");
    assertEquals(s.asked.length, 0);
  });
});

test("which plans someone has connected: signed in on a computer of theirs that's on or wakes", async () => {
  await setup(async (s) => {
    const plans = (actor: Actor) => s.rt.call<string[]>("test.connected", { actor });
    const north = (person: Actor): Actor => ({ kind: "agent", id: "north", for: person });
    // As her, or an agent working for her; never anyone else's.
    assertEquals(await plans(ana), ["claude-plan"]);
    assertEquals(await plans(north(ana)), ["claude-plan"]);
    assertEquals(await plans(north(cy)), []);
    // A routine's turn, with nobody there: a plan's CLI doesn't run then.
    const routine = { kind: "routine", id: "r1", name: "Morning news", rev: 1 };
    assertEquals(await plans({ ...north(ana), for: { ...ana, origin: routine } }), []);
    // Her laptop, off: not until it's on again. A cloud computer asleep wakes when asked.
    await s.rt.call("test.offline", {});
    assertEquals(await plans(north(ana)), []);
    const [mine] = await s.rt.call<{ computer: string }[]>("computer.engines", {}, { actor: ana });
    await s.rt.call("computer.mark", {
      computer: mine.computer,
      status: { kind: "cloud", state: "asleep" },
    });
    assertEquals(await plans(north(ana)), ["claude-plan"]);
    // Each plan serves its maker's models, by their own names.
    const plansOnly = ["claude-plan/claude-haiku-5-5", "codex-plan/gpt-6-luna"];
    assertEquals(
      await s.rt.call("models.check", {
        model: { model: [...plansOnly, "gemini-plan/gemini-4-neon"], harnesses: ["gemini-plan"] },
        port: "llm",
      }),
      ["gemini-plan/gemini-4-neon"],
    );
    assertEquals(
      await s.rt.call("models.check", {
        model: { model: plansOnly, harnesses: ["codex-plan", "claude-plan"] },
        port: "llm",
      }),
      plansOnly,
    );
    // Until it says its list, Cursor serves every maker's models by the same names, and its own.
    assertEquals(
      await s.rt.call("models.check", {
        model: { model: [...plansOnly, "cursor-plan/composer-2.5"], harnesses: ["cursor-plan"] },
        port: "llm",
      }),
      ["cursor-plan/claude-haiku-5-5", "cursor-plan/gpt-6-luna", "cursor-plan/composer-2.5"],
    );
  });
});

test("signing in asked to install sends the plan's official installer, and only then; done, it says whether the CLI is there", async () => {
  await setup(async (s) => {
    const [mine] = await s.rt.call<{ computer: string }[]>("computer.engines", {}, { actor: ana });
    const login = (more: Record<string, unknown> = {}) =>
      s.rt.call("computer.engine.login", { computer: mine.computer, engine: "codex", ...more }, {
        actor: ana,
      });
    // Done, it says whether the CLI is there now, as the computer says after (of Claude Code).
    assertEquals(
      await s.rt.call("computer.engine.login", { computer: mine.computer, engine: "claude" }, {
        actor: ana,
      }),
      { state: "done", output: "", signedIn: true, installed: true },
    );
    s.logins.length = 0;
    await login();
    await login({ install: true });
    await login({ install: false });
    assertEquals(s.logins, [
      { engine: "codex" },
      { engine: "codex", install: "npm i -g @openai/codex" },
      { engine: "codex" },
    ]);
  });
});

/** Her computer, its plans as it says, a shared space, and sharing it there. */
async function sharing(s: Parameters<Parameters<typeof setup>[0]>[0]) {
  const engines = () =>
    s.rt.call<{ computer: string; engines: Record<string, { signedIn: boolean }> }[]>(
      "computer.engines",
      {},
      { actor: ana },
    );
  const [mine] = await engines();
  const { space: launch } = await s.rt.call<{ space: string }>("space.create", {
    name: "Launch",
  }, { actor: ana });
  const share = (more: Record<string, unknown> = {}) =>
    s.rt.call("computer.share", { computer: mine.computer, in: launch, ...more }, { actor: ana });
  /** Her plan runs elsewhere (the next model), and doesn't sign in there either. */
  const notHere = async () => {
    const before = s.asked.length;
    const thread = await s.send("hello there", ana);
    assertStringIncludes((await s.history(thread, ana)).at(-1)!.text ?? "", "hello there");
    assertEquals(s.asked.length, before);
    await assertRejects(
      () =>
        s.rt.call("computer.engine.login", { computer: mine.computer, engine: "claude" }, {
          actor: ana,
        }),
      Error,
      "Others' agents work on this computer as you",
    );
  };
  return { engines, computer: mine.computer, share, notHere };
}

test("a cloud computer signed in to a plan isn't shared with others' agents until it's signed out there", async () => {
  await setup(async (s) => {
    const { engines, computer, share, notHere } = await sharing(s);
    await s.rt.call("computer.mark", { computer, status: { kind: "cloud", state: "awake" } });

    // Signed in to her Claude plan: refused, saying how to go on.
    const refused = await assertRejects(() => share());
    assertEquals((refused as { code?: string }).code, "plan_signed_in");
    assertEquals(
      (refused as Error).message,
      "testbox is signed in to your Claude plan. Sign out of it first: a computer shared with " +
        "others can't keep plan sign-ins.",
    );
    // Kept to her own answers there, it isn't others' agents' to use: it goes, but not further.
    await share({ answers: "owner" });
    await assertRejects(() => share({ answers: "asker" }), Error, "Sign out of it first");

    // Signed out there: the computer signs its CLI out, and what it says is kept.
    await s.rt.call("computer.engine.logout", { computer, engine: "claude" }, { actor: ana });
    assertEquals(s.logouts, [{ engine: "claude" }]);
    assertEquals((await engines())[0].engines.claude?.signedIn, false);
    await share({ answers: "asker" });

    // Signed in again on it from its terminal: her plan still doesn't run there.
    s.report(true);
    assertEquals((await engines())[0].engines.claude?.signedIn, true);
    await notHere();
  });
});

test("a person's own computer signed in to a plan may be shared, and then doesn't run it", async () => {
  await setup(async (s) => {
    const { engines, share, notHere } = await sharing(s);
    await share();
    assertEquals((await engines())[0].engines.claude?.signedIn, true);
    await notHere();
  });
});

test({
  name:
    "the computer program, end to end: she signs her plan in from the app, and north's turn runs on it, its tool call held",
  // The fake CLI is a shell script.
  ignore: process.platform === "win32",
  fn: async () => {
    const app = definePlugin({
      name: "app",
      resources: {
        shared: { thread: {}, message: {} },
        agents: {
          north: {
            instructions: "Lead.",
            model: ["claude-plan/claude-haiku-5-5", "fake/echo"],
            default: true,
            tools: ["lookup"],
          },
        },
        tools: {
          lookup: tool({ description: "Looks up who's on call.", run: () => "Ana is on call" }),
        },
      },
    });
    const rt = await createRuntime({
      store: memoryStore(),
      plugins: [models, chat, ...access, computers, app],
      transports: [{ type: "websocket", config: { path: "/oxian" } }],
    });
    const listener = await host(rt.hypervisor);
    const dir = tempDir();
    let computer: Awaited<ReturnType<typeof startComputer>> | undefined;
    try {
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
      computer = await startComputer({
        url: `http://127.0.0.1:${new URL(String(listener.url)).port}`,
        root: join(dir, "Copilotz"),
        statePath: join(dir, "computer.json"),
        code,
        name: "laptop",
        chromium: null,
        log: () => {},
        agents: {
          commands: {
            claude: fakeCli(dir, "claude", "./program-agents-claude.ts", join(dir, "claude.log")),
            codex: null,
            antigravity: null,
          },
        },
      });
      await computer.ready;
      const engines = () =>
        rt.call<
          { computer: string; online: boolean; engines: Record<string, { signedIn: boolean }> }[]
        >("computer.engines", {}, { actor: ana });
      for (let i = 0; i < 500 && !(await engines())[0]?.online; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const [laptop] = await engines();
      assertEquals(laptop.engines.claude?.signedIn, false);

      // Signing in from the app: the CLI's own sign-in runs there; the code she pastes goes to it.
      const login = (input?: Record<string, unknown>) =>
        rt.call<{ state: string; signedIn: boolean; url?: string }>("computer.engine.login", {
          computer: laptop.computer,
          engine: "claude",
          ...input,
        }, { actor: ana });
      let state = await login();
      for (let i = 0; i < 100 && !state.url && state.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        state = await login();
      }
      assert(state.url, "it said where to sign in");
      state = await login({ input: "good-code" });
      for (let i = 0; i < 100 && state.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        state = await login();
      }
      assertEquals([state.state, state.signedIn], ["done", true]);
      assertEquals((await engines())[0].engines.claude?.signedIn, true);

      // North's turn, on her plan: the CLI calls north's tool, which the turn runs, and goes on.
      const { thread } = await rt.call<{ thread: string }>("chat.send", {
        text: "call lookup {}",
        in: space,
      }, { actor: ana });
      await rt.idle();
      const last = (await rt.query<Message[]>("message.history", { thread }, { actor: ana }))
        .at(-1)!;
      assertEquals(last.from, "north");
      assertStringIncludes(last.text ?? "", "got ");
      assertStringIncludes(last.text ?? "", "Ana is on call");
    } finally {
      await computer?.stop();
      await rt.close();
      await listener.shutdown();
    }
  },
});

test("two conversations that start alike are two answers: their prompts' ids differ", async () => {
  await setup(async (s) => {
    await s.send("who's on call?", ana);
    await s.send("who's on call?", ana);
    const fresh = s.asked.filter((input) => !input.session);
    assertEquals(fresh.length, 2);
    assert(fresh[0].id !== fresh[1].id, "each conversation's own");
  });
});

test("a plan that lists its models runs one only when its list has it: the next plan does, and the first's computer is never asked", async () => {
  const topic = `engines-test.${crypto.randomUUID()}`;
  const neon = [{ model: "google/gemini-4-neon", effort: "high" }, "fake/echo"];
  const app = definePlugin({
    name: "app",
    actions: {
      // Which plans `actor` has connected here.
      "test.connected": defineAction({
        input: { type: "object" },
        run: (ctx, input: { actor: Actor }) => ctx.as(input.actor).call("computer.connected", {}),
      }),
      // A turn's chain, with her plans as the tiers plugin gives them: in the plans' own order,
      // each that said its models with them.
      "test.model": defineAction({
        record: false,
        input: { type: "object" },
        run: async (ctx) => {
          const plans = await ctx.call<PlansConnected>("computer.connected", {});
          return {
            model: neon,
            harnesses: plans.map((p) => typeof p === "string" ? p : p.plan),
            served: Object.fromEntries(
              plans.flatMap((p) => typeof p === "string" ? [] : [[p.plan, p.models]]),
            ),
          };
        },
      }),
    },
    resources: {
      shared: { thread: {}, message: {} },
      // Google's API, offline.
      provider: { google: { adapter: "fake" } },
      agentModel: { test: { action: "test.model" } },
      agents: { north: { instructions: "Lead.", model: "fake/echo", default: true } },
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  // Her laptop runs Antigravity, which names its models with their effort and has no Gemini 4
  // Neon; her other computer, Cursor, which has it. Each says what its plan runs.
  const agy: EngineStatus = {
    engine: "antigravity",
    installed: true,
    signedIn: true,
    models: ["gemini-4-hydrogen-high", "gemini-3.8-flash-low", "claude-opus-4-6-thinking"],
  };
  const cursor: EngineStatus = {
    engine: "cursor",
    installed: true,
    signedIn: true,
    models: ["claude-opus-5-5", "gemini-4-neon"],
  };
  const asked: Record<string, PromptInput[]> = { antigravity: [], cursor: [] };
  const started: ReturnType<typeof fakeComputer>[] = [];
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    for (const status of [agy, cursor]) {
      const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
      const computer = fakeComputer(topic, `code:${code}`, {
        workloads: {
          [WORK.agentsStatus]: () => encoder.encode(JSON.stringify([status])),
          [WORK.agentsPrompt]: async ({ input }) => {
            asked[status.engine].push(JSON.parse(await new Response(input).text()));
            const events: PromptEvent[] = [
              { i: 0, type: "session", session: "s-1" },
              text(1, `From ${status.engine}.`),
              { i: 2, type: "done", stopReason: "end_turn" },
            ];
            return encoder.encode(events.map((event) => JSON.stringify(event) + "\n").join(""));
          },
        },
      });
      started.push(computer);
      await computer.worker.ready;
    }
    type Shown = { online: boolean; engines: Record<string, { models?: string[] }> }[];
    const engines = () => rt.call<Shown>("computer.engines", {}, { actor: ana });
    for (let i = 0; i < 300 && (await engines()).filter((c) => c.online).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Each computer's record keeps what its plan said it runs.
    const seen = Object.assign({}, ...(await engines()).map((c) => c.engines));
    assertEquals([seen.antigravity.models, seen.cursor.models], [agy.models, cursor.models]);
    const plans = () => rt.call<PlansConnected>("test.connected", { actor: ana });
    assertEquals(await plans(), [
      { plan: "gemini-plan", models: agy.models! },
      { plan: "cursor-plan", models: cursor.models! },
    ]);

    // Antigravity comes first among her plans, but has no Gemini 4 Neon: Cursor answers.
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const last = (await rt.query<Message[]>("message.history", { thread }, { actor: ana })).at(-1)!;
    assertEquals([last.from, last.text], ["north", "From cursor."]);
    assertEquals(asked.antigravity, []);
    assertEquals(asked.cursor.map((input) => input.model), ["gemini-4-neon"]);

    // Said without its list (a program older than rc.68), it's kept without one: a name again.
    delete agy.models;
    await engines();
    assertEquals(await plans(), ["gemini-plan", { plan: "cursor-plan", models: cursor.models! }]);
  } finally {
    for (const computer of started) await computer.worker.stop();
    await rt.close();
  }
});

test("which computer a plan runs on: online, then one the app keeps (it wakes), then one that's off; where the session is first in each", () => {
  const seen = (s: string) => `2026-11-25T${s}:00.000Z`;
  const signed = { claude: { installed: true, signedIn: true, at: seen("09:00") } };
  const laptop = { _id: "laptop", online: false, seen: seen("10:00"), engines: signed };
  const cloud = {
    _id: "cloud",
    online: false,
    seen: seen("08:00"),
    status: { kind: "cloud", state: "asleep" },
    engines: signed,
  };
  const desk = { _id: "desk", online: true, seen: seen("07:00"), engines: signed };
  const old = { _id: "old", online: true, seen: seen("06:00"), engines: signed };
  const unsigned = { _id: "unsigned", online: true, seen: seen("11:00"), engines: {} };
  const ids = (list: { _id: string }[]) => list.map((c) => c._id);

  // A laptop that's off, seen last, comes after a cloud computer asleep: that one wakes.
  assertEquals(ids(servingOrder([laptop, cloud], "claude")), ["cloud", "laptop"]);
  // Online first, the most recently seen first; not signed in, not at all.
  assertEquals(ids(servingOrder([laptop, cloud, old, desk, unsigned], "claude")), [
    "desk",
    "old",
    "cloud",
    "laptop",
  ]);
  // Where the session is goes first among its own, never before one that's online.
  assertEquals(ids(servingOrder([desk, old], "claude", "old")), ["old", "desk"]);
  assertEquals(ids(servingOrder([desk, cloud], "claude", "cloud")), ["desk", "cloud"]);
  assertEquals(servingOrder([desk], "codex"), []);
});
