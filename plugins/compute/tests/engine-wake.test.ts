/**
 * A plan's call on a computer that sleeps (a cloud computer, which the app
 * keeps and wakes): it says it's waking, with what the app estimates, before
 * it waits; once awake, it asks the computer what its plan's CLI is now, and
 * one that isn't signed in any more is passed over for the next; a laptop
 * that's off isn't woken, nor said to be. While a step runs, its computer is
 * touched every minute, and once more when it ends: a running step is use.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmChunk } from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { type Computer, computers, type Desk } from "../mod.ts";
import type { EngineEvent } from "../computers/actions/engine.ts";
import { type PromptEvent, WORK } from "../computers/shared/workloads.ts";
import { keepTouching } from "../computers/shared/wake.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const encoder = new TextEncoder();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One step's answer: a session, a few words, done. */
const ANSWER: PromptEvent[] = [
  { i: 0, type: "session", session: "s-1" },
  {
    i: 1,
    type: "update",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } },
  },
  { i: 2, type: "done", stopReason: "end_turn" },
];

async function setup(
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    /** A computer of hers, connected, signed in to Claude: kept by the app (`cloud`) or not. */
    connect(cloud: boolean): Promise<string>;
    /** It goes to sleep (its machine stops): offline until something wakes it. */
    sleep(computer: string): Promise<void>;
    /** What it will say of its Claude Code once it's woken. */
    after: Map<string, { installed: boolean; signedIn: boolean }>;
    /** What it was asked to run, and what was touched. */
    prompted: string[];
    touched: string[];
    woken: string[];
  }) => Promise<void>,
) {
  const topic = `engine-wake-test.${crypto.randomUUID()}`;
  const after = new Map<string, { installed: boolean; signedIn: boolean }>();
  const prompted: string[] = [];
  const touched: string[] = [];
  const woken: string[] = [];
  const workers = new Map<string, ReturnType<typeof fakeComputer>>();
  const machineOf = (computer: () => string | undefined, credential: string) =>
    fakeComputer(topic, credential, {
      workloads: {
        [WORK.agentsStatus]: () => {
          const said = after.get(computer() ?? "") ?? { installed: true, signedIn: true };
          return encoder.encode(JSON.stringify([{ engine: "claude", ...said }]));
        },
        [WORK.agentsPrompt]: () => {
          prompted.push(computer() ?? "");
          return new ReadableStream<Uint8Array>({
            start(controller) {
              for (const e of ANSWER) controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
              controller.close();
            },
          });
        },
      },
    });
  const app = definePlugin({
    name: "app",
    actions: {
      // The app's wake, for the computers it keeps: its machine starts again, as the computer.
      "test.wake": defineAction({
        record: false,
        input: { type: "object" },
        run: async (ctx, input: { computer: string }) => {
          const records = ctx.as().db.collection<Computer>("computer");
          const asleep = workers.get(input.computer);
          if (!asleep || !(await records.findOne({ _id: input.computer }))?.status) return null;
          woken.push(input.computer);
          const machine = machineOf(() => input.computer, asleep.credential());
          workers.set(input.computer, machine);
          await machine.worker.ready;
          for (let i = 0; i < 300; i++) {
            if ((await records.findOne({ _id: input.computer }))?.online) break;
            await pause(10);
          }
          return { state: "awake" };
        },
      }),
      "test.touch": defineAction({
        record: false,
        input: { type: "object" },
        run: (_, input: { computer: string }) => (touched.push(input.computer), null),
      }),
      // A streaming Action's events, collected as `actor` (a stream comes back only inline).
      "test.collect": defineAction({
        record: false,
        input: { type: "object" },
        run: async (ctx, input: { action: string; input: unknown; actor: Actor }) => {
          const events: unknown[] = [];
          try {
            const stream = await ctx.as(input.actor).call<AsyncIterable<unknown>>(
              input.action,
              input.input,
            );
            for await (const event of stream) events.push(event);
            return { events };
          } catch (error) {
            return { events, code: (error as { code?: string }).code };
          }
        },
      }),
      "test.estimate": defineAction({
        record: false,
        input: { type: "object" },
        run: () => ({ seconds: 40, slower: true }),
      }),
    },
    resources: {
      shared: { thread: {}, message: {} },
      computerWake: { wake: "test.wake", touch: "test.touch", estimate: "test.estimate" },
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const online = async (computer: string, is: boolean) => {
      for (let i = 0; i < 300; i++) {
        const desks = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
        if (desks.find((d) => d.computer === computer)?.online === is) return;
        await pause(10);
      }
    };
    await fn({
      rt,
      after,
      prompted,
      touched,
      woken,
      connect: async (cloud) => {
        const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
        let id: string | undefined;
        const machine = machineOf(() => id, `code:${code}`);
        await machine.worker.ready;
        for (let i = 0; i < 300 && !id; i++) {
          id = (await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana }))
            .find((d) => d.online && !workers.has(d.computer))?.computer;
          if (!id) await pause(10);
        }
        workers.set(id!, machine);
        // Signed in to her Claude plan there, as it says.
        await rt.call("computer.engines", {}, { actor: ana });
        if (cloud) await rt.call("computer.mark", { computer: id, status: { kind: "cloud" } });
        return id!;
      },
      sleep: async (computer) => {
        await workers.get(computer)!.worker.stop();
        await online(computer, false);
      },
    });
  } finally {
    for (const machine of workers.values()) await machine.worker.stop().catch(() => {});
    await rt.close();
  }
}

const ask = {
  engine: "claude",
  model: "claude-haiku-5-5",
  instructions: "Help.",
  tools: [],
  prompt: [{ type: "text", text: "Hi" }],
  id: "p-1",
};

/** What a streaming Action says as `ana`, as it comes, and the code it failed with. */
const collect = <T>(
  rt: Awaited<ReturnType<typeof createRuntime>>,
  action: string,
  input: unknown,
) => rt.call<{ events: T[]; code?: string }>("test.collect", { action, input, actor: ana });

/** What one step's call says, as it comes; failing, what it failed with. */
async function stepOf(rt: Awaited<ReturnType<typeof createRuntime>>) {
  const { events, code } = await collect<EngineEvent>(rt, "computer.engine", ask);
  if (code) throw Object.assign(new Error(code), { code, events });
  return events;
}

test("asleep: it says it's waking, as the app estimates, then runs there once awake", async () => {
  await setup(async (s) => {
    const cloud = await s.connect(true);
    await s.sleep(cloud);
    const events = await stepOf(s.rt);
    assertEquals(events.slice(0, 2), [
      { type: "waking", seconds: 40, slower: true },
      { type: "computer", computer: cloud },
    ]);
    assertEquals([s.woken, s.prompted], [[cloud], [cloud]]);
    // As a model call: the notice, then at work once it's awake, then its words.
    await s.sleep(cloud);
    const { events: chunks } = await collect<LlmChunk>(s.rt, "llm.stream", {
      model: "claude-plan/claude-haiku-5-5",
      messages: [{ role: "user", text: "Hi" }],
    });
    assertEquals(chunks.slice(0, 3), [
      { type: "waking", seconds: 40, slower: true },
      { type: "thinking" },
      { type: "text", text: "On it." },
    ]);
  });
});

test("awake, its CLI isn't signed in any more: kept so, and the next computer answers at once", async () => {
  await setup(async (s) => {
    const second = await s.connect(true);
    await s.sleep(second);
    const first = await s.connect(true); // seen last: tried first
    await s.sleep(first);
    s.after.set(first, { installed: true, signedIn: false });
    const events = await stepOf(s.rt);
    assertEquals(events.filter((e) => e.type === "computer"), [
      { type: "computer", computer: second },
    ]);
    assertEquals([s.woken, s.prompted], [[first, second], [second]]);
    const kept = await s.rt.call<
      { computer: string; engines: { claude?: { signedIn: boolean } } }[]
    >(
      "computer.engines",
      {},
      { actor: ana },
    );
    assertEquals(kept.find((c) => c.computer === first)?.engines.claude?.signedIn, false);
    // With none left, it fails at once, and a model list moves on to its next.
    await s.sleep(second);
    s.after.set(second, { installed: false, signedIn: false });
    const failed = await assertRejects(() => stepOf(s.rt));
    assertEquals((failed as { code?: string }).code, "engine_signed_out");
    const { events: chunks } = await collect<LlmChunk>(s.rt, "llm.stream", {
      model: ["claude-plan/claude-haiku-5-5", "fake/echo"],
      messages: [{ role: "user", text: "Hi" }],
    });
    const said = chunks.flatMap((c) => c.type === "text" ? [c.text] : []).join("");
    assert(said && !said.includes("On it."), said);
  });
});

test("a laptop that's off isn't woken, nor said to be waking", async () => {
  await setup(async (s) => {
    const laptop = await s.connect(false);
    await s.sleep(laptop);
    const { events, code } = await collect<EngineEvent>(s.rt, "computer.engine", ask);
    assertEquals(code, "engine_offline");
    assertEquals([events, s.woken], [[], []]);
  });
});

test("a running step is use: touched as it starts, as it goes, and as it ends", async () => {
  await setup(async (s) => {
    const cloud = await s.connect(true);
    s.touched.length = 0;
    await stepOf(s.rt);
    assert(s.touched.filter((c) => c === cloud).length >= 2, `${s.touched}`);
  });
  // As it goes: every `every` ms, until it's stopped; then once more.
  const touched: string[] = [];
  const touching = keepTouching(
    {
      resources: { computerWake: { touch: "t" } },
      call: (_: string, input: unknown) => {
        touched.push((input as { computer: string }).computer);
        return Promise.resolve(null);
      },
    } as never,
    "c",
    20,
  );
  await pause(75);
  await touching.stop();
  const count = touched.length;
  assert(count >= 4, `touched ${count} times`);
  await pause(50);
  assertEquals(touched.length, count, "stopped, it doesn't touch again");
});
