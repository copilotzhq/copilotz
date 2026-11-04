/**
 * Turns cut short: a step failing after its tools ran, a turn stopped or
 * failing for good mid-step, an executor crashing mid-tool, a runtime
 * closing mid-turn. A retried turn goes on with the step it was taking (its
 * model isn't asked for that step again); a call that returned never runs
 * twice; one cut short runs again as itself (the same `callId`, `retry`
 * true, its recorded Actions answering from the log); a turn that ends
 * without its step keeps it, saying which calls never returned. Closing
 * lets running turns finish for a while, and the next runtime finishes the
 * rest, answering once.
 */
import { assert, assertEquals } from "@std/assert";
import { fileURLToPath } from "node:url";
import { createRuntime, type Event, type Runtime, type Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Message, type Prompt, type Step } from "../chat/mod.ts";
import { CUT_SHORT } from "../chat/collections/intent.ts";
import { env, host, spawn, tempFile, test } from "../../../testing/mod.ts";
import { type Booking, booking, type Run } from "./fixtures/booking.ts";

/** Where a store's data lives, so a later runtime can open it again. */
type Place = { open(): Store | Promise<Store>; done(): Promise<void> };

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const places: Record<string, () => Place> = {
  memory: () => {
    const store = memoryStore();
    return { open: () => store, done: () => Promise.resolve() };
  },
  sqlite: () => {
    const path = tempFile(".sqlite");
    return { open: () => sqliteStore({ path }), done: () => Promise.resolve() };
  },
  ...(POSTGRES
    ? {
      postgres: () => {
        const schema = `resume_${crypto.randomUUID().slice(0, 8)}`;
        return {
          open: () => postgresStore({ url: POSTGRES, schema }),
          done: async () => await (await postgresStore({ url: POSTGRES, schema })).drop(),
        };
      },
    }
    : {}),
};

const each = (name: string, fn: (place: Place) => Promise<void>) => {
  for (const [store, make] of Object.entries(places)) {
    test(`${store}: ${name}`, async () => {
      const place = make();
      try {
        await fn(place);
      } finally {
        await place.done();
      }
    });
  }
};

/** A runtime of the booking app on a place's store. */
async function open(place: Place, options: Booking = {}) {
  const store = await place.open();
  const app = booking(options);
  const runtime = await createRuntime({ store, plugins: [models, chat, app.plugin] });
  return { runtime, store, asked: app.asked };
}

const send = (runtime: Runtime) =>
  runtime.call<{ thread: string; message: string }>("chat.send", {
    text: "A seat, please.",
    from: "ana",
  });

/** A conversation at a glance: who said what; a step, its calls and what they returned. */
async function said(runtime: Runtime, thread: string) {
  const messages = await runtime.query<Message[]>("message.history", { thread });
  return messages.map((m) =>
    m.toolCalls
      ? `${m.from} (step) ${m.text ?? ""}: ${
        (m.toolCalls as Step[]).map((c) => `${c.name} ${c.input.seat} → ${c.output}`).join("; ")
      }`
      : `${m.from}${m.failed ? " (failed)" : ""}${m.stopped ? " (stopped)" : ""}: ${m.text}`
  );
}

/** The tool's runs: a first one, then any run again (stores keep no order of their own). */
const runsOf = async (store: Store) =>
  ((await store.find("run")) as Run[])
    .map((r) => ({ callId: r.callId, retry: r.retry, seat: r.seat }))
    .sort((a, b) => Number(a.retry) - Number(b.retry));

const until = async (ready: () => boolean | Promise<boolean>, ms = 20_000) => {
  const by = Date.now() + ms;
  while (!await ready()) {
    if (Date.now() > by) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

each(
  "a turn that runs a tool writes its step's calls first, and keeps nothing of them",
  async (place) => {
    const { runtime, store, asked } = await open(place);
    const { thread, message } = await send(runtime);
    await runtime.idle();
    const turn = `${message}:clerk`;
    assertEquals(await said(runtime, thread), [
      "ana: A seat, please.",
      "clerk (step) Booking it.: book 1 → booked 1",
      "clerk: done: booked 1",
    ]);
    assertEquals(asked(), 2);
    // Its call has an id of its own, and never ran before.
    assertEquals(await runsOf(store), [{ callId: `${turn}:0:0`, retry: false, seat: 1 }]);
    // What was written of the step went with its commit, and recorded no events.
    assertEquals(await store.find("intent"), []);
    assertEquals(
      (await store.events(0)).map((e) => e.type).filter((t) => !t.startsWith("action.")),
      [
        "thread.created",
        "message.created", // ana → clerk
        "turn.requested",
        "message.created", // the step
        "message.created", // the answer
        "thread.updated",
      ],
    );
    await runtime.close();
  },
);

for (const keeps of [true, false]) {
  each(
    `a step failing after its tools ran goes on with them, running nothing twice (its model ${
      keeps ? "keeps" : "changes"
    } its input when asked again)`,
    async (place) => {
      let fails = 2;
      const { runtime, store, asked } = await open(place, {
        failView: () => fails-- > 0,
        ...(keeps ? { seat: () => 7 } : {}),
      });
      const { thread, message } = await send(runtime);
      await runtime.idle();
      const seat = keeps ? 7 : 1;
      // Tried three times; the model was asked for the step once, then for the answer.
      assertEquals(
        (await store.events(0)).filter((e) => e.type === "processor.retried").length,
        2,
      );
      assertEquals(asked(), 2);
      // The tool ran once; its recorded Action, once.
      assertEquals(await runsOf(store), [{ callId: `${message}:clerk:0:0`, retry: false, seat }]);
      assertEquals((await store.find("charge")).length, 1);
      assertEquals(await said(runtime, thread), [
        "ana: A seat, please.",
        `clerk (step) Booking it.: book ${seat} → booked ${seat}`,
        `clerk: done: booked ${seat}`,
      ]);
      assertEquals(await store.find("intent"), []);
      await runtime.close();
    },
  );
}

each(
  "a turn failing for good after its tools ran keeps its step, for its later turns",
  async (place) => {
    let fails = 3;
    const { runtime, store } = await open(place, { failView: () => fails-- > 0 });
    const { thread } = await send(runtime);
    await runtime.idle();
    assertEquals(await said(runtime, thread), [
      "ana: A seat, please.",
      "clerk (step) Booking it.: book 1 → booked 1",
      "clerk (failed): clerk failed: something went wrong, so it couldn't answer. Try again in a moment.",
    ]);
    assertEquals((await store.find("charge")).length, 1);
    // Its next turn is told the seat was booked.
    const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "clerk" });
    assert(
      prompt.history.some((m) => m.role === "tool" && m.text === "booked 1"),
      JSON.stringify(prompt.history),
    );
    assertEquals(await store.find("intent"), []);
    await runtime.close();
  },
);

each("a turn stopped mid-tool keeps its step, saying the call never returned", async (place) => {
  const started = Promise.withResolvers<void>();
  const { runtime, store } = await open(place, {
    hold: () => (started.resolve(), new Promise(() => {})),
  });
  const { thread } = await send(runtime);
  await started.promise;
  assertEquals(await runtime.call("chat.stop", { thread }), { stopped: 1 });
  await runtime.idle();
  // The step's own text stays the step's: the answer doesn't repeat it.
  assertEquals(await said(runtime, thread), [
    "ana: A seat, please.",
    `clerk (step) Booking it.: book 1 → ${CUT_SHORT}`,
    "clerk (stopped): (stopped)",
  ]);
  assertEquals(await store.find("intent"), []);
  await runtime.close();
});

each("a closing runtime lets a running turn finish first", async (place) => {
  const first = await open(place, { delayMs: 200 });
  const { thread } = await send(first.runtime);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await first.runtime.close({ drain: 5_000 });
  assertEquals(first.asked(), 2);
  // The next runtime has nothing left to do.
  const next = await open(place);
  await next.runtime.idle();
  assertEquals(await said(next.runtime, thread), [
    "ana: A seat, please.",
    "clerk (step) Booking it.: book 1 → booked 1",
    "clerk: done: booked 1",
  ]);
  assertEquals(next.asked(), 0);
  await next.runtime.close();
});

each(
  "a turn the drain's deadline cut short goes on in the next runtime, and answers once",
  async (place) => {
    const first = await open(place, { delayMs: 2_000 });
    const { thread } = await send(first.runtime);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = performance.now();
    await first.runtime.close({ drain: 200 });
    const took = performance.now() - closing;
    assert(took >= 150 && took < 1_500, `closed in ${Math.round(took)} ms`);
    const next = await open(place);
    await next.runtime.idle();
    assertEquals(await said(next.runtime, thread), [
      "ana: A seat, please.",
      "clerk (step) Booking it.: book 1 → booked 1",
      "clerk: done: booked 1",
    ]);
    assertEquals((await runsOf(next.store)).length, 1);
    await next.runtime.close();
  },
);

each("a tool closing cut short runs again as itself in the next runtime", async (place) => {
  const started = Promise.withResolvers<void>();
  const first = await open(place, { hold: () => (started.resolve(), new Promise(() => {})) });
  const { thread, message } = await send(first.runtime);
  await started.promise;
  await first.runtime.close({ drain: 0 });
  const next = await open(place);
  await next.runtime.idle();
  // Not asked for the step again: only for the answer.
  assertEquals(next.asked(), 1);
  // The same call, run again as itself; its charge answered from the log.
  const callId = `${message}:clerk:0:0`;
  assertEquals(await runsOf(next.store), [
    { callId, retry: false, seat: 1 },
    { callId, retry: true, seat: 1 },
  ]);
  assertEquals((await next.store.find("charge")).length, 1);
  assertEquals(await said(next.runtime, thread), [
    "ana: A seat, please.",
    "clerk (step) Booking it.: book 1 → booked 1",
    "clerk: done: booked 1",
  ]);
  assertEquals(await next.store.find("intent"), []);
  await next.runtime.close();
});

test("memory: a tool its executor's crash cut short runs again as itself", async () => {
  const key = crypto.randomUUID();
  const store = memoryStore();
  // The owner runs no tool: its copy of the app only declares what executors run.
  const runtime = await createRuntime({
    store,
    plugins: [models, chat, booking().plugin],
    executors: 0,
    key,
    transports: [{ type: "websocket", config: { path: "/executors" } }],
  });
  const listener = await host(runtime.hypervisor);
  const port = new URL(String(listener.url)).port;
  const children: ReturnType<typeof spawn>[] = [];
  const executor = () => {
    const child = spawn(fileURLToPath(new URL("./fixtures/executor.ts", import.meta.url)), {
      args: [port],
      env: { COPILOTZ_EXECUTOR_KEY: key },
    });
    children.push(child);
    return child;
  };
  try {
    const first = executor();
    await until(() => runtime.stats().executors === 1);
    const { thread, message } = await send(runtime);
    // The tool charged, then hangs: its executor dies there. The charge is on
    // record once its Action completed, which is a commit after the charge's
    // own: before that, a retry may charge again (outside effects key on `callId`).
    await until(async () =>
      (await store.events(0)).some((e: Event) =>
        e.type === "action.completed" && e.data.action === "booking.charge"
      )
    );
    first.kill();
    await first.exited;
    await until(() => runtime.stats().executors === 0);
    executor();
    await runtime.idle();
    const runs = await runsOf(store);
    const callId = `${message}:clerk:0:0`;
    // Its model picks a seat at random: the same seat both times is the same step.
    const { seat } = runs[0];
    assertEquals(runs, [{ callId, retry: false, seat }, { callId, retry: true, seat }]);
    assertEquals((await store.find("charge")).length, 1);
    assertEquals(await said(runtime, thread), [
      "ana: A seat, please.",
      `clerk (step) Booking it.: book ${seat} → booked ${seat}`,
      `clerk: done: booked ${seat}`,
    ]);
    const retried = (await store.events(0)).filter((e: Event) => e.type === "processor.retried");
    assertEquals(retried.map((e) => e.data.after), ["lost"]);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await listener.shutdown();
    await runtime.close({ drain: 0 }).catch(() => {});
  }
});
