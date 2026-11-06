/**
 * Closing a runtime: browsers still connected are let go, not waited on (a
 * host closing an idle org, or moving one); running Processor deliveries get
 * a while to finish (`drain`) and nothing new starts; what didn't finish
 * keeps its Processor's cursor before it, so the next runtime delivers it
 * again, as a retry.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Store } from "../mod.ts";
import { connect } from "../client.ts";
import { listen } from "../../hosts/web/node/serve.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { tempFile, test, testWho, ticketFor } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

test("a runtime closes promptly with a browser still connected", async () => {
  const topic = `close-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [testWho],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const client = connect({
    transport: { type: "in-process", config: { topic } },
    ticket: () => ticketFor(rt, ana),
    plugins: [],
  });
  try {
    for (let i = 0; i < 200 && rt.stats().browsers === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(rt.stats().browsers === 1, "the browser connected");
    const started = performance.now();
    await rt.close();
    const took = performance.now() - started;
    assert(took < 3_000, `closed in ${Math.round(took)} ms`);
  } finally {
    await client.close();
  }
});

test("a runtime closes promptly with a browser connected over a socket", async () => {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [testWho],
  });
  const listener = await listen(rt.fetch);
  const client = connect({
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${new URL(String(listener.url)).port}/oxian`,
        allowInsecureLoopback: true,
      },
    },
    ticket: () => ticketFor(rt, ana),
    plugins: [],
  });
  try {
    for (let i = 0; i < 300 && rt.stats().browsers === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(rt.stats().browsers === 1, "the browser connected");
    const started = performance.now();
    await rt.close();
    const took = performance.now() - started;
    assert(took < 3_000, `closed in ${Math.round(took)} ms`);
  } finally {
    await client.close();
    await listener.shutdown();
  }
});

/** Work taking `ms`, then saying so (`work.went`), and what follows; each run's `retry`. */
function work(ms: number) {
  const runs = { slow: [] as boolean[], next: [] as boolean[] };
  const plugin = definePlugin({
    name: "work",
    events: {
      "work.go": { schema: { type: "object" } },
      "work.went": { schema: { type: "object" } },
    },
    processors: {
      "work.slow": {
        on: "work.go",
        run: async (ctx) => {
          runs.slow.push(ctx.retry);
          await new Promise((resolve) => setTimeout(resolve, ms));
          await ctx.emit("work.went");
        },
      },
      "work.next": { on: "work.went", run: (ctx) => void runs.next.push(ctx.retry) },
    },
  });
  return { plugin, runs };
}

/** A store a later runtime opens again. */
const places: Record<string, () => () => Store | Promise<Store>> = {
  memory: () => {
    const store = memoryStore();
    return () => store;
  },
  sqlite: () => {
    const path = tempFile(".sqlite");
    return () => sqliteStore({ path });
  },
};

for (const [name, place] of Object.entries(places)) {
  test(`${name}: closing lets running deliveries finish, and starts none`, async () => {
    const open = place();
    const first = work(150);
    const a = await createRuntime({ store: await open(), plugins: [first.plugin] });
    await a.emit("work.go");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await a.close({ drain: 5_000 });
    // The running one finished; what it caused waits for the next runtime.
    assertEquals(first.runs, { slow: [false], next: [] });
    const second = work(150);
    const b = await createRuntime({ store: await open(), plugins: [second.plugin] });
    await b.idle();
    assertEquals(second.runs, { slow: [], next: [true] });
    await b.close();
  });

  test(`${name}: a delivery closing cut short is delivered again by the next runtime`, async () => {
    const open = place();
    const first = work(5_000);
    const a = await createRuntime({ store: await open(), plugins: [first.plugin] });
    await a.emit("work.go");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = performance.now();
    await a.close({ drain: 100 });
    const took = performance.now() - started;
    assert(took < 2_000, `closed in ${Math.round(took)} ms`);
    assertEquals(first.runs, { slow: [false], next: [] });
    const second = work(0);
    const store = await open();
    const b = await createRuntime({ store, plugins: [second.plugin] });
    await b.idle();
    // Not past its cursor: delivered again, as a retry, and once.
    assertEquals(second.runs, { slow: [true], next: [false] });
    assertEquals((await store.events(0)).filter((e) => e.type === "work.went").length, 1);
    await b.close();
  });
}
