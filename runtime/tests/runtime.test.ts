/**
 * What the runtime records: every change to a declared collection is an
 * event committed with it, every action call is started → completed/failed,
 * causes link them, and large values are stored once as blobs.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  type Store,
} from "../mod.ts";
import { fingerprint } from "../registry.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { readFile } from "node:fs/promises";
import { fileBlobs } from "../../stores/blobs/files/mod.ts";
import { env, host, spawn, tempDir, tempFile, temporary, test } from "../../testing/mod.ts";

const object = { type: "object" } as const;

/** How many times action and processor bodies actually ran. */
const runs = { count: 0, flaky: 0, delivery: 0 };

const notes = definePlugin({
  name: "notes",
  events: Object.fromEntries(
    ["note.triggered", "note.before", "note.after", "note.mid", "note.echoed"].map((type) => [
      type,
      { schema: { type: "object" } },
    ]),
  ),
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } } },
      queries: {
        all: (notes) => notes.find({}),
        // Queries compose: this one reads through another, and through other collections.
        count: async (notes, _params, ctx) => ({
          notes: (await notes.query<unknown[]>("all")).length,
          tags: await ctx.db.collection("tag").countDocuments({}),
        }),
        // A query that tries to write is refused.
        sneaky: (notes) =>
          (notes as unknown as { insertOne(d: object): Promise<unknown> }).insertOne({}),
      },
    }),
    quiet: defineCollection({ schema: object, events: false }),
    tag: defineCollection({ schema: object }),
    item: defineCollection({ schema: object }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (ctx, input) =>
        (await ctx.db.collection("note").insertOne({ text: input.text })).insertedId,
    }),
    "note.edit": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, input) =>
        ctx.db.collection("note").updateOne({ _id: input.id }, {
          $set: { n: 1 },
          $unset: { text: 1 },
        }),
    }),
    "note.same": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, input) =>
        ctx.db.collection("note").updateOne({ _id: input.id }, { $set: { n: 1 } }),
    }),
    "note.remove": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, input) => ctx.db.collection("note").deleteOne({ _id: input.id }),
    }),
    "note.fail": defineAction({
      input: object,
      run: async (ctx) => {
        await ctx.db.collection("note").insertOne({ text: "partial" });
        throw Object.assign(new Error("boom"), { code: "broken" });
      },
    }),
    "note.nothing": defineAction({ input: object, run: () => 42 }),
    "note.outer": defineAction({
      input: object,
      run: (ctx) => ctx.call("note.add", { text: "inner" }),
    }),
    "note.silent": defineAction({
      input: object,
      record: false,
      run: async (ctx) => void await ctx.db.collection("note").insertOne({ text: "silent" }),
    }),
    "note.parallel": defineAction({
      input: object,
      // One write fails validation while the other commits.
      run: (ctx) =>
        Promise.allSettled([
          ctx.db.collection("note").insertOne({ text: 5 as unknown as string }),
          ctx.db.collection("note").insertOne({ text: "fine" }),
        ]),
    }),
    "note.slow": defineAction({
      input: object,
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        await ctx.db.collection("note").insertOne({ text: "late" });
      },
    }),
    "note.count": defineAction({
      input: { type: "object", properties: { n: { type: "number" } } },
      run: async (ctx) => {
        runs.count++;
        return (await ctx.db.collection("note").insertOne({ n: runs.count })).insertedId;
      },
    }),
    "note.wait": defineAction({
      input: object,
      run: async () => {
        runs.count++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return runs.count;
      },
    }),
    "note.flaky": defineAction({
      input: object,
      run: () => {
        if (++runs.flaky === 1) throw new Error("first try fails");
        return "ok";
      },
    }),
    "note.trigger": defineAction({
      input: {
        type: "object",
        properties: { changes: { type: "boolean" }, final: { type: "boolean" } },
      },
      run: (ctx, input) =>
        ctx.emit("note.triggered", {
          changes: input.changes ?? false,
          ...(input.final ? { final: true } : {}),
        }),
    }),
    "note.quiet": defineAction({
      input: object,
      record: false,
      run: async (ctx) => void await ctx.db.collection("quiet").insertOne({}),
    }),
    // Ops that need no answer: they all go to the owner with the commit.
    "note.batch": defineAction({
      input: object,
      record: false,
      run: (ctx) =>
        ctx.transaction(async (tx) => {
          tx.emit("note.before");
          const { insertedId } = await tx.db.collection("note").insertOne({ text: "batched" });
          tx.emit("note.after", { note: insertedId });
          return insertedId;
        }),
    }),
    "note.again": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      record: false,
      run: (ctx, input) =>
        ctx.transaction(async (tx) => {
          await tx.db.collection("note").insertOne({ _id: "fresh", text: "fine" });
          await tx.db.collection("note").insertOne({ _id: input.id, text: "taken" });
        }),
    }),
    // Writes whose answers aren't needed: with the insert, one call and one statement.
    "note.touch": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      record: false,
      run: (ctx, input) =>
        ctx.transaction(async (tx) => {
          const touched = await tx.db.collection("note").updateOne(
            { _id: input.id },
            { $inc: { n: 1 } },
            { writeConcern: { w: 0 } },
          );
          await tx.db.collection("quiet").insertOne({ about: input.id });
          return touched;
        }),
    }),
    "note.touchAlone": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      record: false,
      run: (ctx, input) =>
        ctx.db.collection("note").updateOne({ _id: input.id }, { $inc: { n: 1 } }, {
          writeConcern: { w: 0 },
        }),
    }),
    // Writes to different collections, none needing an answer: one statement where the
    // store can. With `same`, two updates hit one collection, so it can't.
    "note.seed": defineAction({
      input: object,
      record: false,
      run: (ctx) =>
        ctx.transaction(async (tx) => ({
          tag: (await tx.db.collection("tag").insertOne({ _id: "t1", names: [] })).insertedId,
          quiet: (await tx.db.collection("quiet").insertOne({})).insertedId,
        })),
    }),
    "note.several": defineAction({
      input: {
        type: "object",
        properties: {
          tag: { type: "string" },
          quiet: { type: "string" },
          same: { type: "boolean" },
        },
        required: ["tag", "quiet"],
      },
      record: false,
      run: (ctx, input) =>
        ctx.transaction(async (tx) => {
          const w0 = { writeConcern: { w: 0 } } as const;
          await tx.db.collection("note").insertOne({ _id: "made", text: "x" });
          tx.emit("note.mid");
          await tx.db.collection("tag").updateOne(
            { _id: input.tag },
            { $push: { names: "a" }, $set: { n: 1 } },
            w0,
          );
          if (input.same) {
            await tx.db.collection("tag").updateOne({ _id: input.tag }, { $inc: { n: 1 } }, w0);
          }
          await tx.db.collection("quiet").deleteOne({ _id: input.quiet }, w0);
          await tx.db.collection("item").updateOne({ _id: "new" }, { $set: { k: 1 } }, {
            upsert: true,
            ...w0,
          });
        }),
    }),
    "note.counted": defineAction({
      input: object,
      record: false,
      run: (ctx) => ctx.db.collection("note").query("count"),
    }),
    "note.twice": defineAction({
      input: object,
      record: false,
      run: (ctx) =>
        ctx.transaction(async (tx) => {
          await tx.db.collection("note").insertOne({ _id: "same", text: "one" });
          await tx.db.collection("note").insertOne({ _id: "same", text: "two" });
          tx.emit("note.after");
        }),
    }),
  },
  processors: {
    // Calls an action, then fails its first delivery: the retry must not call it again.
    "note.retrying": {
      on: "note.triggered",
      run: async (ctx, event) => {
        // `changes` makes the nested call's input differ between deliveries, like changed code.
        const n = event.data.changes ? runs.delivery : 0;
        await ctx.call("note.count", { n });
        // A failure that says trying again won't help.
        if (event.data.final) throw Object.assign(new Error("for good"), { final: true });
        if (++runs.delivery === 1) throw new Error("delivery fails once");
      },
    },
    "note.echo": {
      on: "note.created",
      where: { "doc.text": "echo me" },
      run: (ctx, event) => ctx.emit("note.echoed", { note: event.data._id }),
    },
  },
});

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `t_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

/** Registers a test once per store, so every store records exactly the same events. */
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

async function start(
  store: Store = memoryStore(),
  extra: Partial<Parameters<typeof createRuntime>[0]> = {},
) {
  const runtime = await createRuntime({ store, plugins: [notes], ...extra });
  const log = async () => {
    await runtime.idle();
    return await store.events(0);
  };
  return { runtime, store, log };
}

/** `type ← cause type`, to read causality at a glance. */
const chain = (events: Event[]) => {
  const byId = new Map(events.map((e) => [e.id, e]));
  return events.map((e) => `${e.type}${e.cause ? ` ← ${byId.get(e.cause)?.type ?? "?"}` : ""}`);
};

each("an action's writes are events caused by its start, committed with it", async (make) => {
  const { runtime, log } = await start(await make());
  const id = await runtime.call<string>("note.add", { text: "hello" });
  const events = await log();
  assertEquals(chain(events), [
    "action.started",
    "note.created ← action.started",
    "action.completed ← action.started",
  ]);
  // `started` rode on the insert: one commit, consecutive sequence numbers.
  assertEquals(events[0].seq + 1, events[1].seq);
  const { startedAt, inputHash, ...started } = events[0].data;
  assertEquals(started, { action: "note.add", input: { text: "hello" }, attempt: 1 });
  assertEquals(inputHash, await fingerprint("note.add", { text: "hello" }));
  assert(Date.parse(String(startedAt)) <= Date.parse(events[0].at));
  assertEquals(events[1].data, { _id: id, doc: { _id: id, text: "hello" } });
  const { ms, ...completed } = events[2].data;
  assertEquals(completed, { action: "note.add", result: id, attempt: 1 });
  assert(typeof ms === "number");
  await runtime.close();
});

each(
  "updates carry what changed; deletes carry the last version; no-ops record nothing",
  async (make) => {
    const { runtime, log } = await start(await make());
    const id = await runtime.call<string>("note.add", { text: "hello" });
    await runtime.call("note.edit", { id });
    await runtime.call("note.same", { id });
    await runtime.call("note.remove", { id });
    const events = (await log()).filter((e) => e.type.startsWith("note."));
    assertEquals(events.map((e) => e.type), ["note.created", "note.updated", "note.deleted"]);
    assertEquals(events[1].data, {
      _id: id,
      doc: { _id: id, n: 1 },
      changed: ["n"],
      removed: ["text"],
    });
    assertEquals(events[2].data, { _id: id, doc: { _id: id, n: 1 } });
    await runtime.close();
  },
);

each("failed, empty, nested and unrecorded actions", async (make) => {
  const { runtime, log } = await start(await make());
  const error = await assertRejects(() => runtime.call("note.fail", {}));
  assertEquals((error as Error).message, "boom");
  assertEquals(await runtime.call("note.nothing", {}), 42);
  await runtime.call("note.outer", {});
  await runtime.call("note.silent", {});
  await runtime.call("note.quiet", {});
  const events = await log();
  assertEquals(chain(events), [
    // The insert committed before the failure; the failure is recorded after it.
    "action.started",
    "note.created ← action.started",
    "action.failed ← action.started",
    // No writes: started and completed commit together.
    "action.started",
    "action.completed ← action.started",
    // A nested call is caused by the outer call.
    "action.started",
    "action.started ← action.started",
    "note.created ← action.started",
    "action.completed ← action.started",
    "action.completed ← action.started",
    // record: false — the write is still an event, with no action around it.
    "note.created",
  ]);
  const { ms: _, ...failed } = events[2].data;
  assertEquals(failed, {
    action: "note.fail",
    error: { message: "boom", code: "broken" },
    attempt: 1,
  });
  assertEquals(events[4].seq, events[3].seq + 1);
  await runtime.close();
});

each(
  "a processor's writes are caused by the event it handles; skipped events advance its cursor",
  async (make) => {
    const { runtime, store, log } = await start(await make());
    await runtime.call("note.add", { text: "echo me" });
    await runtime.call("note.add", { text: "not me" });
    const events = await log();
    assert(chain(events).includes("note.echoed ← note.created"));
    assertEquals(events.filter((e) => e.type === "note.echoed").length, 1);
    // Positions are saved shortly after they move.
    const last = events.at(-1)!.seq;
    for (let i = 0; i < 50 && (await store.positions())["note.echo"] !== last; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals((await store.positions())["note.echo"], last);
    await runtime.close();
  },
);

const big = "x".repeat(20_000);

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: large values are stored once, as blobs, and read back whole`, async () => {
    const { runtime, store, log } = await start(await make());
    const first = await runtime.call<string>("note.add", { text: big });
    const second = await runtime.call<string>("note.add", { text: big });
    // Stored: a reference, the same for both documents and their events.
    const stored = await store.find("note");
    const ref = stored[0].text as { $blob: string; size: number };
    assertEquals(ref.size, 20_000);
    assertEquals(stored[1].text, ref);
    const created = (await log()).filter((e) => e.type === "note.created");
    assertEquals(created.map((e) => (e.data.doc as { text: unknown }).text), [ref, ref]);
    assertEquals((created[0].data.doc as { text: unknown }).text, ref);
    assertEquals((await store.blob(ref.$blob))?.data.length, 20_000);
    // Read through the runtime: whole again.
    const docs = await runtime.query<{ _id: string; text: string }[]>("note.all");
    assertEquals(docs.map((d) => [d._id, d.text.length]), [[first, 20_000], [second, 20_000]]);
    await runtime.close();
  });
}

test("blobs can live outside the store, as files", async () => {
  const dir = tempDir();
  const store = memoryStore();
  const { runtime } = await start(store, { blobs: fileBlobs({ dir }) });
  await runtime.call("note.add", { text: big });
  const ref = (await store.find("note"))[0].text as { $blob: string };
  assertEquals(
    (await readFile(`${dir}/${ref.$blob.slice(7, 9)}/${ref.$blob}`)).length,
    20_000,
  );
  assertEquals(await store.blob(ref.$blob), null);
  const docs = await runtime.query<{ text: string }[]>("note.all");
  assertEquals(docs[0].text, big);
  await runtime.close();
});

each("an action's start precedes all its effects, even when writes race or fail", async (make) => {
  const { runtime, log } = await start(await make());
  await runtime.call("note.parallel", {});
  const events = await log();
  assertEquals(chain(events), [
    "action.started",
    "note.created ← action.started",
    "action.completed ← action.started",
  ]);
  await runtime.close();
});

each("action events carry the call's real start time and duration", async (make) => {
  const { runtime, log } = await start(await make());
  await runtime.call("note.slow", {});
  await assertRejects(() => runtime.call("note.fail", {}));
  const events = await log();
  const [started, , completed] = events;
  const begun = Date.parse(String(started.data.startedAt));
  // The call began before its first write committed, by about the wait.
  assert(Date.parse(started.at) - begun >= 50, `${started.at} vs ${started.data.startedAt}`);
  assert(Number(completed.data.ms) >= 50, `ms = ${completed.data.ms}`);
  const failed = events.find((e) => e.type === "action.failed")!;
  assert(typeof failed.data.ms === "number");
  await runtime.close();
});

const reset = () => Object.assign(runs, { count: 0, flaky: 0, delivery: 0 });
const actions = (events: Event[]) =>
  events.filter((e) => e.type.startsWith("action.")).map((e) =>
    `${e.type} ${e.data.action}#${e.data.attempt}${e.data.after ? ` after ${e.data.after}` : ""}`
  );

each("a repeated call id returns the recorded result without running again", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  const first = await runtime.call("note.count", {}, { id: "k1" });
  const again = await runtime.call("note.count", {}, { id: "k1" });
  assertEquals(again, first);
  assertEquals(runs.count, 1);
  assertEquals(actions(await log()), [
    "action.started note.count#1",
    "action.completed note.count#1",
  ]);
  await runtime.close();
});

each("a call id that is still running is joined, not run twice", async (make) => {
  reset();
  const { runtime } = await start(await make());
  const [a, b] = await Promise.all([
    runtime.call("note.wait", {}, { id: "k2" }),
    runtime.call("note.wait", {}, { id: "k2" }),
  ]);
  assertEquals([a, b, runs.count], [1, 1, 1]);
  await runtime.close();
});

each("a failed call retried with its id runs again as attempt 2", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  await assertRejects(() => runtime.call("note.flaky", {}, { id: "k3" }));
  assertEquals(await runtime.call("note.flaky", {}, { id: "k3" }), "ok");
  assertEquals(actions(await log()), [
    "action.started note.flaky#1",
    "action.failed note.flaky#1",
    "action.retried note.flaky#2 after failed",
    "action.completed note.flaky#2",
  ]);
  await runtime.close();
});

test("an attempt lost with the owner is marked when the call is retried", async () => {
  reset();
  const store = memoryStore();
  // An earlier owner recorded the start of call k4, then died before any outcome.
  const inputHash = await fingerprint("note.count", {});
  const { epoch } = await store.open();
  await store.transaction(epoch, (tx) => {
    tx.emit({
      id: "k4",
      type: "action.started",
      data: { action: "note.count", input: {}, inputHash, attempt: 1 },
    });
    return Promise.resolve();
  });
  const { runtime, log } = await start(store);
  await runtime.call("note.count", {}, { id: "k4" });
  assertEquals(actions(await log()), [
    "action.started note.count#1",
    "action.retried note.count#2 after lost",
    "action.completed note.count#2",
  ]);
  await runtime.close();
});

each("a retried delivery finds the actions it already called", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  await runtime.call("note.trigger", {});
  const events = await log();
  assertEquals(runs.delivery, 2);
  assertEquals(runs.count, 1);
  const nested = events.filter((e) => e.data.action === "note.count");
  assertEquals(nested.map((e) => e.type), ["action.started", "action.completed"]);
  await runtime.close();
});

test("an executor lost mid-call is recorded by the owner, and the call can be retried", async () => {
  const { default: slow } = await import("./fixtures/slow.ts");
  const key = crypto.randomUUID();
  const store = memoryStore();
  const runtime = await createRuntime({
    store,
    plugins: [slow],
    executors: 0,
    key,
    transports: [{ type: "websocket", config: { path: "/executors" } }],
  });
  const listener = await host(runtime.hypervisor);
  const port = new URL(String(listener.url)).port;
  const children: ReturnType<typeof spawn>[] = [];
  const executor = () => {
    const child = spawn(new URL("./fixtures/executor.ts", import.meta.url).pathname, {
      args: [port],
      env: { COPILOTZ_EXECUTOR_KEY: key },
    });
    children.push(child);
    return child;
  };
  const until = async (ready: () => boolean) => {
    while (!ready()) await new Promise((r) => setTimeout(r, 20));
  };
  // A killed executor counts until the owner notices it's gone; the next waits for that.
  const connected = () => until(() => runtime.stats().executors === 1);
  const kill = async (child: ReturnType<typeof spawn>) => {
    child.kill();
    await child.exited;
    await until(() => runtime.stats().executors === 0);
  };

  try {
    const first = executor();
    await connected();
    const call = runtime.call("slow.call", { ms: 600 }, { id: "k5" });
    setTimeout(() => first.kill(), 200);
    const error = await assertRejects(() => call);
    assertEquals((error as { code?: string }).code, "executor_lost");
    await kill(first);

    const second = executor();
    await connected();
    assertEquals(await runtime.call("slow.call", { ms: 600 }, { id: "k5" }), "done");
    await kill(second);

    // A delivery lost with its executor is retried on the next one, and recorded.
    const third = executor();
    await connected();
    await runtime.call("slow.start", { ms: 400 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await kill(third);
    const fourth = executor();
    await runtime.idle();
    await kill(fourth);
    const deliveries = (await store.events(0)).filter((e) =>
      e.type === "processor.retried" || e.type === "slow.done"
    );
    assertEquals(deliveries.map((e) => `${e.type} ${e.data.after ?? ""}`.trim()), [
      "processor.retried lost",
      "slow.done",
    ]);

    const events = (await store.events(0)).filter((e) => e.data.action === "slow.call");
    assertEquals(actions(events), [
      "action.started slow.call#1",
      "action.failed slow.call#1",
      "action.retried slow.call#2 after failed",
      "action.completed slow.call#2",
    ]);
    assertEquals((events[1].data.error as { code: string }).code, "executor_lost");
  } finally {
    // Whatever failed, nothing is left running.
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await listener.shutdown();
    await runtime.close().catch(() => {});
  }
});

each("a call id reused for a different call is refused", async (make) => {
  reset();
  const { runtime } = await start(await make());
  await runtime.call("note.count", { n: 1 }, { id: "k6" });
  const refuse = async (call: Promise<unknown>) =>
    assertEquals(((await assertRejects(() => call)) as { code?: string }).code, "id_conflict");
  await refuse(runtime.call("note.wait", { n: 1 }, { id: "k6" }));
  await refuse(runtime.call("note.count", { n: 2 }, { id: "k6" }));
  // While running, too.
  const running = runtime.call("note.wait", {}, { id: "k7" });
  await refuse(runtime.call("note.wait", { other: true }, { id: "k7" }));
  await running;
  assertEquals(runs.count, 2);
  await runtime.close();
});

each("same input with keys in another order is the same call", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  const first = await runtime.call("note.add", { text: "a", tag: "b" }, { id: "k8" });
  assertEquals(await runtime.call("note.add", { tag: "b", text: "a" }, { id: "k8" }), first);
  assertEquals((await log()).filter((e) => e.type === "note.created").length, 1);
  await runtime.close();
});

each("a retried delivery whose code now calls differently makes a new call", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  await runtime.call("note.trigger", { changes: true });
  const started = (await log()).filter((e) =>
    e.type === "action.started" && e.data.action === "note.count"
  );
  assertEquals(runs.count, 2);
  assertEquals(started.map((e) => e.data.input), [{ n: 0 }, { n: 1 }]);
  await runtime.close();
});

each("every failed delivery attempt is recorded before the retry", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  await runtime.call("note.trigger", {});
  const retried = (await log()).filter((e) => e.type === "processor.retried");
  assertEquals(retried.length, 1);
  const { error, ...rest } = retried[0].data;
  assertEquals(rest, {
    processor: "note.retrying",
    event: retried[0].cause,
    attempt: 2,
    after: "failed",
  });
  assertEquals((error as { message: string }).message, "delivery fails once");
  await runtime.close();
});

each("a delivery whose failure is final isn't tried again", async (make) => {
  reset();
  const { runtime, log } = await start(await make());
  await runtime.call("note.trigger", { final: true });
  const events = await log();
  assertEquals(events.filter((e) => e.type === "processor.retried"), []);
  const failed = events.filter((e) => e.type === "processor.failed");
  assertEquals(failed.map((e) => [e.data.attempts, (e.data.error as { final?: true }).final]), [
    [1, true],
  ]);
  await runtime.close();
});

each("a transaction of writes that need no answer commits in one call", async (make) => {
  const { runtime, log } = await start(await make());
  const before = runtime.stats().calls;
  const id = await runtime.call<string>("note.batch", {});
  assertEquals(runtime.stats().calls - before, 1);
  const events = (await log()).map((e) => [e.type, e.data._id ?? e.data.note]);
  // In op order: the emit before the write, the write's own event, the emit after it.
  assertEquals(events, [["note.before", undefined], ["note.created", id], ["note.after", id]]);
  await runtime.close();
});

each("a write that fails at the commit fails the whole transaction", async (make) => {
  const { runtime, log } = await start(await make());
  const error = await assertRejects(() => runtime.call("note.twice", {}));
  assertEquals((error as { code?: string }).code, "duplicate_key");
  assertEquals((error as Error).message, 'Duplicate _id "same" in "note"');
  assertEquals(await log(), []);
  // Against a stored document too, not only one in the same transaction.
  await runtime.call("note.add", { text: "first" });
  const stored = (await log()).find((e) => e.type === "note.created")!.data._id as string;
  await assertRejects(() => runtime.call("note.again", { id: stored }), Error, `"${stored}"`);
  await runtime.close();
});

each("w: 0 writes in a transaction go with the commit, unacknowledged", async (make) => {
  const { runtime, store, log } = await start(await make());
  const id = await runtime.call<string>("note.add", { text: "count me" });
  const before = runtime.stats().calls;
  assertEquals(await runtime.call("note.touch", { id }), { acknowledged: false });
  assertEquals(runtime.stats().calls - before, 1);
  // Outside a transaction there is nothing to batch with: it is acknowledged.
  assertEquals(await runtime.call("note.touchAlone", { id }), {
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  assertEquals((await store.find("note", { _id: id }))[0].n, 2);
  const types = (await log()).map((e) => e.type).filter((t) => !t.startsWith("action."));
  assertEquals(types, ["note.created", "note.updated", "note.updated"]);
  await runtime.close();
});

for (const same of [false, true]) {
  each(
    `several writes in one transaction${same ? ", two on one collection," : ""} record alike`,
    async (make) => {
      const { runtime, store, log } = await start(await make());
      const ids = await runtime.call<{ tag: string; quiet: string }>("note.seed", {});
      const events = (await log()).length;
      const statements = store.roundTrips();
      await runtime.call("note.several", { ...ids, same });
      // On Postgres: one statement, unless two writes share a collection (then a transaction).
      if (store.command) {
        const sent = store.roundTrips() - statements;
        assert(same ? sent > 1 : sent === 1, `${sent} statements`);
      }
      const recorded = (await log()).slice(events).map((e) => [
        e.type,
        e.data._id ?? null,
        e.data.changed ?? null,
      ]);
      assertEquals(recorded, [
        ["note.created", "made", null],
        ["note.mid", null, null],
        ["tag.updated", ids.tag, ["n", "names"]],
        ...(same ? [["tag.updated", ids.tag, ["n"]]] : []),
        ["item.created", "new", null],
      ]);
      assertEquals(await store.find("tag", {}), [{ _id: ids.tag, names: ["a"], n: same ? 2 : 1 }]);
      assertEquals(await store.find("item", {}), [{ _id: "new", k: 1 }]);
      assertEquals(await store.find("quiet", {}), []);
      await runtime.close();
    },
  );
}

test("a Processor whose where filter can't be evaluated fails at start", async () => {
  const bad = definePlugin({
    name: "bad",
    processors: { "bad.p": { on: "x", where: { "doc.text": { $regex: "a" } }, run: () => {} } },
  });
  await assertRejects(
    () => createRuntime({ store: memoryStore(), plugins: [bad] }),
    Error,
    'Processor "bad.p" where: Unsupported filter operator $regex',
  );
});

each("queries are named reads on collections, from clients and from plugin code", async (make) => {
  const { runtime } = await start(await make());
  await runtime.call("note.add", { text: "one" });
  await runtime.call("note.add", { text: "two" });
  assertEquals((await runtime.query<{ text: string }[]>("note.all")).map((n) => n.text), [
    "one",
    "two",
  ]);
  assertEquals(await runtime.query("note.count"), { notes: 2, tags: 0 });
  assertEquals(await runtime.call("note.counted", {}), { notes: 2, tags: 0 });
  await assertRejects(() => runtime.query("note.sneaky"), Error, "Queries are read-only");
  await assertRejects(() => runtime.query("note.nothing"), Error, 'Unknown query "note.nothing"');
  await assertRejects(() => runtime.query("nope.all"), Error, 'Unknown query "nope.all"');
  await runtime.close();
});
