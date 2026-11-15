/**
 * Atomic Actions, called into a transaction (`tx.call`): another plugin's
 * work that must commit with the caller's, as a sale with the gift card it
 * debits and the points it earns. The callee reads the transaction's writes,
 * its own transaction joins it, and its record (`action.started`,
 * `action.completed`) commits with it, so a retry after a rollback runs it
 * again and one after a commit answers from the record. Each write answers
 * to the call that made it. A callee that isn't atomic is refused before
 * any of it runs; one that fails, or reaches the world, rolls it all back.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createMetrics,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  failure,
  people,
  type Runtime,
  type Store,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempFile, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const object = { type: "object" } as const;
const NOTHING = { _id: { $in: [] } };

/** What the next `sale.complete` does wrong, once: fail inside its transaction, or after it. */
let fault: "in" | "after" | undefined;
/** Said once a stuck callee holds its transaction open; and what it waits for. */
let begun = Promise.withResolvers<void>();
let go = Promise.withResolvers<void>();

/** Gift cards: their balances change only as the system, through their Actions. */
const cards = definePlugin({
  name: "cards",
  collections: {
    card: defineCollection({
      schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    }),
  },
  guard: (_actor, { collection, access }) =>
    collection !== "card" || access === "read" ? undefined : NOTHING,
  actions: {
    "card.debit": defineAction({
      atomic: true,
      allow: people,
      input: {
        type: "object",
        properties: { card: { type: "string" }, amount: { type: "number" } },
        required: ["card", "amount"],
      },
      run: async (ctx, { card, amount }) => {
        const found = await ctx.db.collection<{ value: number }>("card").findOne({ _id: card });
        if (!found) throw failure("card_not_found", `No card ${card}.`, { public: true });
        if (found.value < amount) {
          throw failure("card_short", `Card ${card} has ${found.value}.`, { public: true });
        }
        // Past the person's reach, as a grant of the system's: in the transaction too.
        await ctx.as().db.collection("card").updateOne({ _id: card }, { $inc: { value: -amount } });
        return { left: found.value - amount };
      },
    }),
    // The system's: a card issued with its balance.
    "card.issue": defineAction({
      input: {
        type: "object",
        properties: { card: { type: "string" }, value: { type: "number" } },
        required: ["card", "value"],
      },
      run: (ctx, { card, value }) => ctx.db.collection("card").insertOne({ _id: card, value }),
    }),
    // Not atomic: it may reach the world, so no transaction calls it.
    "card.report": defineAction({ allow: people, input: object, run: () => "reported" }),
    // Atomic, but nobody's from outside: the system's alone.
    "card.audit": defineAction({
      atomic: true,
      allow: (actor) => actor.kind === "system",
      input: object,
      run: () => "audited",
    }),
    // Atomic, yet it reaches the world after a write: refused there, and it all rolls back.
    "card.check": defineAction({
      atomic: true,
      allow: people,
      input: object,
      run: async (ctx) => {
        await ctx.as().db.collection("card").updateOne({ _id: "c1" }, { $set: { value: 0 } });
        await ctx.fetch("https://cards.example/check");
      },
    }),
  },
});

/** Customers' reward points, and a counter. */
const points = definePlugin({
  name: "points",
  collections: {
    customer: defineCollection({
      schema: { type: "object", properties: { points: { type: "number" } } },
    }),
  },
  actions: {
    // Points for what a customer bought, read in the transaction that saves their last sale.
    "customer.reward": defineAction({
      atomic: true,
      input: {
        type: "object",
        properties: { customer: { type: "string" } },
        required: ["customer"],
      },
      run: (ctx, { customer }) =>
        ctx.transaction(async (tx) => {
          const sales = await tx.db.collection("sale").countDocuments({ customer });
          await tx.db.collection("customer").updateOne(
            { _id: customer },
            { $set: { points: sales * 10 } },
            { upsert: true },
          );
          return { points: sales * 10 };
        }),
    }),
    // Read, then written: two at once are right only one after the other.
    "counter.bump": defineAction({
      atomic: true,
      input: object,
      run: async (ctx) => {
        const counters = ctx.db.collection<{ points: number }>("customer");
        const n = (await counters.findOne({ _id: "counter" }))?.points ?? 0;
        await counters.updateOne({ _id: "counter" }, { $set: { points: n + 1 } }, {
          upsert: true,
        });
        return n + 1;
      },
    }),
    // Writes, then waits on something that doesn't come: an executor stuck in a callee.
    "customer.stuck": defineAction({
      atomic: true,
      input: object,
      run: async (ctx) => {
        const customers = ctx.db.collection("customer");
        await customers.updateOne({ _id: "stuck" }, { $set: { points: 1 } }, { upsert: true });
        begun.resolve();
        await go.promise;
        await customers.updateOne({ _id: "stuck" }, { $set: { points: 2 } });
      },
    }),
  },
});

type Call = { action: string; input?: Record<string, unknown> };

/** The register: a sale saved with what other plugins do for it, in one transaction. */
const register = definePlugin({
  name: "register",
  collections: {
    sale: defineCollection({
      schema: {
        type: "object",
        properties: { customer: { type: "string" } },
        required: ["customer"],
      },
    }),
  },
  actions: {
    "sale.complete": defineAction({
      allow: people,
      input: {
        type: "object",
        properties: {
          sale: { type: "string" },
          customer: { type: "string" },
          calls: { type: "array", items: { type: "object" } },
        },
        required: ["sale", "customer", "calls"],
      },
      run: async (ctx, input) => {
        const said = await ctx.transaction(async (tx) => {
          // Saved again as it was on a retry.
          await tx.db.collection("sale").replaceOne({ _id: input.sale }, {
            customer: input.customer,
          }, { upsert: true });
          const said: unknown[] = [];
          for (const call of input.calls as Call[]) {
            said.push(await tx.call(call.action, call.input ?? {}));
          }
          if (fault === "in") {
            fault = undefined;
            throw failure("drawer_jammed", "The drawer jammed.");
          }
          return said;
        });
        if (fault === "after") {
          fault = undefined;
          throw failure("printer_jammed", "The printer jammed.");
        }
        return said;
      },
    }),
    // A call that isn't atomic, refused and caught: the transaction goes on, and commits.
    "sale.tries": defineAction({
      allow: people,
      input: object,
      run: (ctx) =>
        ctx.transaction(async (tx) => {
          let refused = "";
          try {
            await tx.call("card.report", {});
          } catch (error) {
            refused = (error as Error).message;
          }
          tx.db.collection("sale").insertOne({ _id: "tried", customer: "cleo" });
          return refused;
        }),
    }),
    // Two calls made at once: they run one after the other, in the order made.
    "sale.bumps": defineAction({
      allow: people,
      input: object,
      run: (ctx) =>
        ctx.transaction((tx) =>
          Promise.all([tx.call<number>("counter.bump", {}), tx.call<number>("counter.bump", {})])
        ),
    }),
  },
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
      fault = undefined;
      begun = Promise.withResolvers();
      go = Promise.withResolvers();
      const store = await make();
      const metrics = createMetrics();
      const runtime = await createRuntime({ store, plugins: [cards, points, register], metrics });
      // How the transactions held open ended, as their metric has them.
      const outcomes = () =>
        metrics.collect().metrics.find((m) => m.name === "copilotz.transaction.duration")
          ?.points.map((p) => p.attributes.outcome) ?? [];
      try {
        await runtime.call("card.issue", { card: "c1", value: 50 });
        await fn({ runtime, store, outcomes });
      } finally {
        go.resolve();
        await runtime.close();
      }
    });
  }
};

/** The sale `s1`, for `cleo`, with these calls into its transaction. */
const sale = (calls: Call[], id = "s1") => ({ sale: id, customer: "cleo", calls });
const debit = (amount: number, card = "c1"): Call => ({
  action: "card.debit",
  input: { card, amount },
});
const reward: Call = { action: "customer.reward", input: { customer: "cleo" } };

/** The log from the first call after the card was issued. */
const since = async (store: Store) => {
  const all = await store.events(0);
  const from = all.findIndex((e) => e.type === "action.started" && e.data.action !== "card.issue");
  return from < 0 ? [] : all.slice(from);
};
/** Each event as its type, and its Action or its document. */
const told = (events: Event[]) =>
  events.map((e) => [e.type, (e.data.action ?? e.data._id) as string]);
const card = async (store: Store) => (await store.findOne("card", { _id: "c1" }))?.value;

each(
  "an atomic Action commits with the transaction that called it, each write answering to its call",
  async ({ runtime, store }) => {
    assertEquals(await runtime.call("sale.complete", sale([debit(20), reward]), { actor: ana }), [
      { left: 30 },
      { points: 10 },
    ]);
    assertEquals(await card(store), 30);
    // The reward read the sale the same transaction saved.
    assertEquals((await store.findOne("customer", { _id: "cleo" }))?.points, 10);
    const events = await since(store);
    assertEquals(told(events), [
      ["action.started", "sale.complete"],
      ["sale.created", "s1"],
      ["action.started", "card.debit"],
      ["card.updated", "c1"],
      ["action.completed", "card.debit"],
      ["action.started", "customer.reward"],
      ["customer.created", "cleo"],
      ["action.completed", "customer.reward"],
      ["action.completed", "sale.complete"],
    ]);
    const [started, created, debitStarted, updated, , rewardStarted, rewarded] = events;
    // Each call is the sale's; each write, its own call's; the card's, as the system for Ana.
    assertEquals([debitStarted.cause, rewardStarted.cause], [started.id, started.id]);
    assertEquals(
      [created.cause, updated.cause, rewarded.cause],
      [started.id, debitStarted.id, rewardStarted.id],
    );
    assertEquals([updated.actor?.kind, (updated.actor?.via as Actor)?.id], ["system", "ana"]);
    assertEquals(rewarded.actor, ana);
    // The sale's commit carried every one of them.
    const seqs = events.slice(0, -1).map((e) => e.seq);
    assertEquals(seqs.at(-1)! - seqs[0], seqs.length - 1);
  },
);

each(
  "a callee's failure rolls back the caller's writes, and another callee's own transaction, joined",
  async (
    { runtime, store },
  ) => {
    await assertRejects(
      () => runtime.call("sale.complete", sale([reward, debit(80)]), { actor: ana }),
      Error,
      "Card c1 has 50.",
    );
    assertEquals(await store.find("sale", {}), []);
    assertEquals(await store.find("customer", {}), []);
    assertEquals(await card(store), 50);
    // The failed call is on record, apart; nothing of the reward is.
    assertEquals(told(await since(store)), [
      ["action.started", "sale.complete"],
      ["action.started", "card.debit"],
      ["action.failed", "card.debit"],
      ["action.failed", "sale.complete"],
    ]);
  },
  ["memory"],
);

each("a callee that reaches the world is refused there, and it all rolls back", async (
  { runtime, store },
) => {
  await assertRejects(
    () => runtime.call("sale.complete", sale([{ action: "card.check" }]), { actor: ana }),
    Error,
    "ctx.fetch isn't for an atomic Action",
  );
  assertEquals([await card(store), await store.find("sale", {})], [50, []]);
}, ["memory"]);

each(
  "a callee that isn't atomic, or doesn't let the caller in, is refused before any of it runs",
  async (
    { runtime, store, outcomes },
  ) => {
    for (
      const [action, said] of [["card.report", "isn't atomic"], ["card.audit", "may not call"]]
    ) {
      await assertRejects(
        () => runtime.call("sale.complete", sale([{ action }]), { actor: ana }),
        Error,
        said,
      );
    }
    await assertRejects(
      () => runtime.call("sale.complete", sale([{ action: "card.nope" }]), { actor: ana }),
      Error,
      'Unknown action "card.nope"',
    );
    const started = (await since(store)).filter((e) => e.type === "action.started");
    assertEquals(started.map((e) => e.data.action), [
      "sale.complete",
      "sale.complete",
      "sale.complete",
    ]);
    assertEquals(await store.find("sale", {}), []);
    // Refused before anything of it ran, it ends nothing: caught, the transaction goes on.
    assertEquals(
      await runtime.call("sale.tries", {}, { actor: ana }),
      '"card.report" isn\'t atomic: a transaction calls only Actions declared `atomic: true`. ' +
        "Call it once the transaction has committed, or have it hear an event the transaction emits.",
    );
    assertEquals((await store.find("sale", {})).map((s) => s._id), ["tried"]);
    // Nothing of those refusals was ever held open but the sale's own transactions.
    assertEquals(outcomes(), ["abort"]);
  },
  ["memory"],
);

each("calls made at once run one after the other, in the order made", async (
  { runtime, store },
) => {
  assertEquals(await runtime.call("sale.bumps", {}, { actor: ana }), [1, 2]);
  assertEquals((await store.findOne("customer", { _id: "counter" }))?.points, 2);
  const bumps = (await since(store)).filter((e) => e.data.action === "counter.bump");
  assertEquals(bumps.map((e) => e.type), [
    "action.started",
    "action.completed",
    "action.started",
    "action.completed",
  ]);
  // Numbered as they were made: 1, then 2.
  assertEquals(bumps.map((e) => (e.type === "action.started" ? e.id : e.cause!).split(".")[1]), [
    "1",
    "1",
    "2",
    "2",
  ]);
}, ["memory"]);

each(
  "a retry after a rollback runs the callee again; after a commit, answers from its record",
  async (
    { runtime, store },
  ) => {
    // Rolled back after the debit ran: nothing of it is kept, so the retry debits, once.
    fault = "in";
    await assertRejects(
      () => runtime.call("sale.complete", sale([debit(20)]), { actor: ana, id: "r1" }),
      Error,
      "The drawer jammed.",
    );
    assertEquals(await card(store), 50);
    assertEquals(await runtime.call("sale.complete", sale([debit(20)]), { actor: ana, id: "r1" }), [
      { left: 30 },
    ]);
    assertEquals(await card(store), 30);
    // Committed, then failed: the retry finds the debit done, and answers as it did.
    fault = "after";
    await assertRejects(
      () => runtime.call("sale.complete", sale([debit(10)], "s2"), { actor: ana, id: "r2" }),
      Error,
      "The printer jammed.",
    );
    assertEquals(await card(store), 20);
    assertEquals(
      await runtime.call("sale.complete", sale([debit(10)], "s2"), { actor: ana, id: "r2" }),
      [{ left: 20 }],
    );
    assertEquals(await card(store), 20);
    const debits = (await since(store)).filter((e) =>
      e.type === "action.completed" && e.data.action === "card.debit"
    );
    assertEquals(debits.map((e) => (e.data.result as { left: number }).left), [30, 20]);
  },
  ["memory", "sqlite"],
);

each(
  "a transaction whose callee sits idle is rolled back after 5 s, as any is",
  async ({ runtime, store, outcomes }) => {
    const stuck = assertRejects(
      () => runtime.call("sale.complete", sale([{ action: "customer.stuck" }]), { actor: ana }),
      Error,
      "The transaction is closed.",
    );
    await begun.promise;
    // This waits for the store's writer until the idle transaction is rolled back.
    const started = performance.now();
    await runtime.call("card.issue", { card: "c2", value: 5 });
    const waited = performance.now() - started;
    assert(waited > 4_000 && waited < 10_000, `The other write waited ${Math.round(waited)} ms`);
    go.resolve();
    await stuck;
    assertEquals([await store.find("sale", {}), await store.find("customer", {})], [[], []]);
    assertEquals(outcomes(), ["idle"]);
  },
  ["memory"],
);
