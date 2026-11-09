/**
 * Transactions an executor holds open across its calls. Each holds the
 * store's writer, so none may keep it for long: an op that fails ends its
 * transaction, a write the rules refuse before it gets there included, and
 * one left idle is rolled back. Either way it's closed to its job, which
 * can't write on in it as if nothing had happened.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createMetrics,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
  type Store,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const object = { type: "object" } as const;
const owner = { type: "string" } as const;

/** Said once an Action's transaction is held open; and what a stuck one waits for. */
let begun = Promise.withResolvers<void>();
let go = Promise.withResolvers<void>();

const plugin = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { owner }, required: ["owner"] },
    }),
    // No rule: anyone's code writes it.
    tally: defineCollection({ schema: object }),
  },
  actions: {
    // A note of its own, and a read, so the transaction is held open; then a note for `owner`,
    // sent with the commit: refused there, unless it's the caller's.
    "note.write": defineAction({
      allow: () => true,
      input: { type: "object", properties: { owner }, required: ["owner"] },
      run: (ctx, input) =>
        ctx.transaction(async (tx) => {
          const notes = tx.db.collection("note");
          await notes.insertOne({ owner: ctx.actor!.id });
          await notes.findOne({ _id: "any" });
          begun.resolve();
          await notes.insertOne({ owner: input.owner });
        }),
    }),
    // Writes on after an op that failed, the error caught: one the rules refused as the
    // transaction's first, or later, or one that failed in it (a duplicate _id).
    "note.onward": defineAction({
      allow: () => true,
      input: { type: "object", properties: { fail: { type: "string" } }, required: ["fail"] },
      run: (ctx, input) =>
        ctx.transaction(async (tx) => {
          const notes = tx.db.collection("note");
          const mine = ctx.actor!.id;
          if (input.fail !== "first") {
            await notes.insertOne({ _id: "before", owner: mine });
            await notes.findOne({ _id: "any" });
          }
          try {
            await notes.insertOne(
              input.fail === "duplicate" ? { _id: "before", owner: mine } : { owner: "bob" },
            );
            await notes.findOne({ _id: "any" });
          } catch {
            // As if it hadn't failed.
          }
          await notes.insertOne({ _id: "after", owner: mine });
          await notes.findOne({ _id: "any" });
        }),
    }),
    // Holds its transaction open, then waits: an executor stuck in the middle of one.
    "note.stuck": defineAction({
      input: object,
      run: (ctx) =>
        ctx.transaction(async (tx) => {
          const notes = tx.db.collection("note");
          await notes.insertOne({ owner: "ana" });
          await notes.findOne({ _id: "any" });
          begun.resolve();
          await go.promise;
          await notes.findOne({ _id: "any" });
        }),
    }),
    "tally.bump": defineAction({
      input: object,
      run: (ctx) =>
        ctx.db.collection("tally").updateOne({ _id: "n" }, { $inc: { n: 1 } }, { upsert: true }),
    }),
  },
  // Each person reaches their own notes.
  guard: (actor, { collection }) => collection === "note" ? { owner: actor.id } : undefined,
});

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
};

type Run = { runtime: Runtime; store: Store; outcomes: () => unknown[] };

const each = (name: string, fn: (run: Run) => Promise<void>, only?: string[]) => {
  for (const [kind, make] of Object.entries(stores)) {
    if (only && !only.includes(kind)) continue;
    test(`${kind}: ${name}`, async () => {
      begun = Promise.withResolvers();
      go = Promise.withResolvers();
      const store = await make();
      const metrics = createMetrics();
      const runtime = await createRuntime({ store, plugins: [plugin], metrics });
      // How the transactions held open ended, as their metric has them.
      const outcomes = () =>
        metrics.collect().metrics.find((m) => m.name === "copilotz.transaction.duration")
          ?.points.map((p) => p.attributes.outcome) ?? [];
      try {
        await fn({ runtime, store, outcomes });
      } finally {
        go.resolve();
        await runtime.close();
      }
    });
  }
};

/** Runs `work`, and how long it took (ms). */
const timed = async (work: () => Promise<unknown>) => {
  const started = performance.now();
  await work();
  return performance.now() - started;
};

each("a write the rules refuse ends its transaction at once: no write waits for it", async (
  { runtime, store, outcomes },
) => {
  await runtime.call("note.write", { owner: "ana" }, { actor: ana });
  assertEquals((await store.find("note", {})).length, 2);
  begun = Promise.withResolvers();
  let refused = 0;
  const failing = timed(() =>
    assertRejects(
      () => runtime.call("note.write", { owner: "bob" }, { actor: ana }),
      Error,
      "out of your reach",
    )
  ).then((ms) => refused = ms);
  await begun.promise;
  // A write of nobody's business, made while the refused transaction holds the store's writer.
  const other = await timed(() => runtime.call("tally.bump", {}));
  await failing;
  assert(refused < 1_000, `The refusal came after ${Math.round(refused)} ms`);
  assert(other < 1_000, `The other write waited ${Math.round(other)} ms`);
  // What it wrote before is rolled back; the call is recorded as failed.
  assertEquals((await store.find("note", {})).length, 2);
  await runtime.idle();
  const failed = (await store.events(0)).filter((e) => e.type === "action.failed");
  assertEquals(failed.map((e) => (e.data.error as { code?: string }).code), ["forbidden"]);
  assertEquals(outcomes(), ["commit", "abort"]);
});

for (const fail of ["first", "refused", "duplicate"]) {
  each(
    `after a failed op (${fail}), its transaction is closed: writing on fails, nothing commits`,
    async ({ runtime, store }) => {
      await assertRejects(
        () => runtime.call("note.onward", { fail }, { actor: ana }),
        Error,
        "The transaction is closed.",
      );
      assertEquals(await store.find("note", {}), []);
    },
  );
}

each(
  "a transaction left idle is rolled back after 5 s, freeing the writer, and closed to its job",
  async ({ runtime, store, outcomes }) => {
    const stuck = assertRejects(
      () => runtime.call("note.stuck", {}),
      Error,
      "The transaction is closed.",
    );
    await begun.promise;
    // This write waits for the store's writer until the idle transaction is rolled back.
    const other = await timed(() => runtime.call("tally.bump", {}));
    assert(other > 4_000 && other < 10_000, `The other write waited ${Math.round(other)} ms`);
    go.resolve();
    await stuck;
    assertEquals(await store.find("note", {}), []);
    assertEquals(outcomes(), ["idle"]);
  },
  // Waiting out the idle time once is enough.
  ["memory"],
);
