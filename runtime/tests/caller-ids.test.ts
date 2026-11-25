/**
 * A nested call's id names its caller, the Action, its input, and how many
 * calls of that Action with that input the caller made before it
 * (`<caller>.<action>#<n>.<inputHash>`). So a retry finds every completed call
 * wherever it's made: a call refused or allowed, added or started in another
 * order moves no other. A Processor delivery's caller is `<event>:<processor>`,
 * so two Processors handling one event never share a record or a timer.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  type Context,
  createRuntime,
  defineAction,
  type Event,
  people,
  type Store,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { tempDir, tempFile, test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana", in: "shop" };

const order = {
  type: "object",
  properties: { order: { type: "string" }, line: { type: "integer" } },
} as const;
const placed = { type: "object", properties: { order: { type: "string" } } } as const;
const sales = { sale: { schema: order } };

/** Each store: a new one, and one a later runtime opens again (PGlite in a directory). */
const stores: Record<
  string,
  { fresh: () => Store | Promise<Store>; again: () => () => Store | Promise<Store> }
> = {
  memory: {
    fresh: memoryStore,
    again: () => {
      const store = memoryStore();
      return () => store;
    },
  },
  sqlite: {
    fresh: () => sqliteStore({ path: tempFile(".sqlite") }),
    again: () => {
      const path = tempFile(".sqlite");
      return () => sqliteStore({ path });
    },
  },
  pglite: {
    fresh: () => postgresStore({ url: ":memory:" }),
    again: () => {
      const url = `file://${tempDir()}`;
      return () => postgresStore({ url });
    },
  },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ids of the calls of an Action, as started, in log order. */
const startedOf = async (store: Store, action: string) =>
  (await store.events(0)).filter((e) => e.type === "action.started" && e.data.action === action)
    .map((e) => e.id);

/** Sales of an order. */
const sold = async (store: Store, order: string) => (await store.find("sale", { order })).length;

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: a call refused or allowed on a retry moves no completed call`, async () => {
    const store = await make.fresh();
    let allowed = false;
    let fail = true;
    const sell = (ctx: Context, input: { order: string }) =>
      ctx.call("sell", { order: input.order, line: 1 });
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "shop",
        collections: sales,
        actions: {
          discount: defineAction({
            atomic: true,
            input: order,
            allow: () => allowed,
            run: () => 1,
          }),
          note: defineAction({ atomic: true, input: order, allow: people, run: () => 1 }),
          sell: defineAction({
            atomic: true,
            input: order,
            allow: people,
            run: (ctx, input) => ctx.db.collection("sale").insertOne(input),
          }),
          // A refusal is caught and the sale goes on.
          checkout: defineAction({
            input: order,
            allow: people,
            run: async (ctx, input: { order: string }) => {
              await ctx.call("discount", input).catch(() => {});
              await sell(ctx, input);
              if (fail) throw new Error("boom");
            },
          }),
          // A refusal is caught by making other calls first.
          audited: defineAction({
            input: order,
            allow: people,
            run: async (ctx, input: { order: string }) => {
              await ctx.call("discount", input).catch(async () => {
                await ctx.call("note", { ...input, line: 1 });
                await ctx.call("note", { ...input, line: 2 });
              });
              await sell(ctx, input);
              if (fail) throw new Error("boom");
            },
          }),
          // The same in a transaction, through `tx.call`.
          joined: defineAction({
            input: order,
            allow: people,
            run: async (ctx, input: { order: string }) => {
              await ctx.transaction(async (tx) => {
                await tx.call("discount", input).catch(() => {});
                await tx.call("sell", { order: input.order, line: 1 });
              });
              if (fail) throw new Error("boom");
            },
          }),
        },
      }],
    });
    try {
      for (const parent of ["checkout", "audited", "joined"]) {
        for (const first of [false, true]) {
          const id = `${parent}-${first ? "allowed" : "refused"}-first`;
          allowed = first;
          fail = true;
          await runtime.call(parent, { order: id }, { id, actor: ana }).catch(() => {});
          allowed = !first;
          fail = false;
          await runtime.call(parent, { order: id }, { id, actor: ana });
          assertEquals(await sold(store, id), 1, id);
        }
      }
    } finally {
      await runtime.close();
    }
  });

  test(`${kind}: two Processors handling one event keep their calls apart`, async () => {
    const store = await make.fresh();
    let tries = 0;
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "shop",
        collections: sales,
        events: { "order.placed": { schema: placed } },
        actions: {
          place: defineAction({
            input: placed,
            run: (ctx, input) => ctx.emit("order.placed", input),
          }),
          sell: defineAction({
            input: order,
            run: (ctx, input) => ctx.db.collection("sale").insertOne(input),
          }),
          // Unrecorded: its calls are its caller's.
          resell: defineAction({
            input: order,
            record: false,
            run: (ctx, input) => ctx.call("sell", input),
          }),
        },
        processors: {
          // Fails before its call the first time, once the other Processor has sold.
          "a.sells": {
            on: "order.placed",
            run: async (ctx, event) => {
              if (++tries === 1) {
                while (!await ctx.db.collection("sale").findOne({})) await wait(10);
                throw new Error("not yet");
              }
              await ctx.call("sell", { order: event.data.order });
            },
          },
          "b.sells": {
            on: "order.placed",
            run: async (ctx, event) => void await ctx.call("resell", { order: event.data.order }),
          },
        },
      }],
    });
    try {
      await runtime.call("place", { order: "o1" });
      await runtime.idle();
      assertEquals(tries, 2);
      assertEquals(await sold(store, "o1"), 2);
      const event = (await store.events(0)).find((e) => e.type === "order.placed")!;
      const ids = await startedOf(store, "sell");
      assertEquals(ids.map((id) => id.slice(0, id.lastIndexOf("."))).sort(), [
        `${event.id}:a.sells.sell#1`,
        `${event.id}:b.sells.sell#1`,
      ]);
    } finally {
      await runtime.close();
    }
  });

  test(`${kind}: calls that start in another order on a retry are found again`, async () => {
    const store = await make.fresh();
    let attempt = 0;
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "shop",
        collections: sales,
        actions: {
          sell: defineAction({
            input: order,
            run: (ctx, input) => ctx.db.collection("sale").insertOne(input),
          }),
          checkout: defineAction({
            run: async (ctx) => {
              const first = ++attempt === 1;
              // Each line reads first, for a time that differs between attempts.
              await Promise.all([1, 2].map(async (line) => {
                await wait(first ? line * 15 : (3 - line) * 15);
                return ctx.call("sell", { order: "o1", line });
              }));
              if (first) throw new Error("boom");
            },
          }),
        },
      }],
    });
    try {
      await runtime.call("checkout", {}, { id: "c1" }).catch(() => {});
      await runtime.call("checkout", {}, { id: "c1" });
      assertEquals(await sold(store, "o1"), 2);
    } finally {
      await runtime.close();
    }
  });

  test(`${kind}: two Processors' timers for one event are apart; a retry sets its own again`, async () => {
    const store = await make.fresh();
    let tries = 0;
    const later = { at: "2099-01-01T00:00:00Z" };
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "remind",
        events: { "order.placed": { schema: placed } },
        actions: {
          place: defineAction({
            input: placed,
            run: (ctx, input) => ctx.emit("order.placed", input),
          }),
          nudge: defineAction({ run: () => 1 }),
          audit: defineAction({ run: () => 2 }),
        },
        processors: {
          "a.nudges": {
            on: "order.placed",
            run: async (ctx) => {
              await ctx.schedule("nudge", {}, later);
              if (++tries === 1) throw new Error("once more");
            },
          },
          "b.audits": { on: "order.placed", run: (ctx) => ctx.schedule("audit", {}, later) },
        },
      }],
    });
    try {
      await runtime.call("place", { order: "o1" });
      await runtime.idle();
      assertEquals(tries, 2);
      const event = (await store.events(0)).find((e) => e.type === "order.placed")!;
      const timers = await store.find("sys.timers", {});
      assertEquals(timers.map((t) => [t._id, t.call]).sort(), [
        [`${event.id}:a.nudges:timer.1`, "nudge"],
        [`${event.id}:b.audits:timer.1`, "audit"],
      ]);
    } finally {
      await runtime.close();
    }
  });

  test(`${kind}: a queued delivery runs its own calls after a restart, though another Processor made the same`, async () => {
    const open = make.again();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const plugin = (blocked: boolean) => ({
      name: "shop",
      collections: sales,
      events: { "order.placed": { schema: placed } },
      actions: {
        place: defineAction({
          input: placed,
          run: (ctx, input) => ctx.emit("order.placed", input),
        }),
        sell: defineAction({
          input: order,
          run: (ctx, input) => ctx.db.collection("sale").insertOne(input),
        }),
      },
      processors: {
        // One lane: the first order holds it, so the second waits, never started.
        "a.sells": {
          on: "order.placed",
          key: () => "one",
          run: async (ctx: Context, event: Event) => {
            if (blocked && event.data.order === "o1") {
              await gate;
              throw new Error("stopped");
            }
            await ctx.call("sell", { order: event.data.order });
          },
        },
        "b.sells": {
          on: "order.placed",
          run: async (ctx: Context, event: Event) =>
            void await ctx.call("sell", { order: event.data.order }),
        },
      },
    });
    const held = await open();
    const first = await createRuntime({ store: held, plugins: [plugin(true)] });
    try {
      await first.call("place", { order: "o1" });
      await first.call("place", { order: "o2" });
      // The other Processor sells both; this one holds the first and never starts the second.
      for (let i = 0; i < 300 && (await held.find("sale", {})).length < 2; i++) await wait(10);
      assertEquals((await held.find("sale", {})).length, 2);
    } finally {
      await first.close({ drain: 50 });
      release();
    }
    const store = await open();
    const second = await createRuntime({ store, plugins: [plugin(false)] });
    try {
      await second.idle();
      assertEquals([await sold(store, "o1"), await sold(store, "o2")], [2, 2]);
      assertEquals((await store.events(0)).filter((e) => e.type === "processor.failed"), []);
    } finally {
      await second.close();
    }
  });

  test(`${kind}: the same call made twice is two calls, each found again`, async () => {
    const store = await make.fresh();
    let times = 2;
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "shop",
        collections: sales,
        actions: {
          sell: defineAction({
            input: order,
            run: (ctx, input) => ctx.db.collection("sale").insertOne(input),
          }),
          restock: defineAction({
            run: async (ctx) => {
              for (let i = 0; i < times; i++) await ctx.call("sell", { order: "o1" });
              if (times === 2) throw new Error("boom");
            },
          }),
        },
      }],
    });
    try {
      await runtime.call("restock", {}, { id: "r1" }).catch(() => {});
      assertEquals(await sold(store, "o1"), 2);
      times = 3;
      await runtime.call("restock", {}, { id: "r1" });
      assertEquals(await sold(store, "o1"), 3);
      const ids = await startedOf(store, "sell");
      assertEquals(ids.map((id) => id.slice(0, id.lastIndexOf("."))), [
        "r1.sell#1",
        "r1.sell#2",
        "r1.sell#3",
      ]);
    } finally {
      await runtime.close();
    }
  });

  test(`${kind}: a refused call keeps its number`, async () => {
    const store = await make.fresh();
    // What each permission check answers, in turn.
    const answers: boolean[] = [];
    let runs = 0;
    let fail = true;
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "shop",
        actions: {
          bonus: defineAction({ allow: () => answers.shift()!, run: () => ++runs }),
          later: defineAction({
            allow: () => Promise.resolve(answers.shift()!),
            run: () => ++runs,
          }),
          reward: defineAction({
            input: { type: "object", properties: { call: { type: "string" } } } as const,
            allow: people,
            run: async (ctx, input: { call: string }) => {
              const one = await ctx.call(input.call, {}).catch(() => null);
              const two = await ctx.call(input.call, {}).catch(() => null);
              if (fail) throw new Error("boom");
              return [one, two];
            },
          }),
        },
      }],
    });
    try {
      for (const call of ["bonus", "later"]) {
        runs = 0;
        fail = true;
        // The first is refused; the second runs, as the second call.
        answers.push(false, true);
        await runtime.call("reward", { call }, { id: call, actor: ana }).catch(() => {});
        fail = false;
        answers.push(true, true);
        // The first runs now; the second answers from its record.
        assertEquals(await runtime.call("reward", { call }, { id: call, actor: ana }), [2, 1]);
        assertEquals(runs, 2);
        const ids = await startedOf(store, call);
        assertEquals(ids.map((id) => id.slice(0, id.lastIndexOf("."))), [
          `${call}.${call}#2`,
          `${call}.${call}#1`,
        ]);
      }
    } finally {
      await runtime.close();
    }
  });

  test(`${kind}: calls made at once are numbered in the order made, each answering its own`, async () => {
    const store = await make.fresh();
    let checks = 0;
    let stamps = 0;
    let fail = true;
    const runtime = await createRuntime({
      store,
      plugins: [{
        name: "shop",
        actions: {
          // The first call's check takes longest, so the second runs first.
          stamp: defineAction({
            allow: async () => (await wait(++checks === 1 ? 40 : 0), true),
            run: () => ++stamps,
          }),
          pair: defineAction({
            allow: people,
            run: async (ctx) => {
              const both = await Promise.all([ctx.call("stamp", {}), ctx.call("stamp", {})]);
              if (fail) throw new Error("boom");
              return both;
            },
          }),
        },
      }],
    });
    try {
      await runtime.call("pair", {}, { id: "p1", actor: ana }).catch(() => {});
      fail = false;
      assertEquals(await runtime.call("pair", {}, { id: "p1", actor: ana }), [2, 1]);
      assertEquals(stamps, 2);
      const ids = await startedOf(store, "stamp");
      assert(ids.every((id) => id.startsWith("p1.stamp#")), ids.join());
    } finally {
      await runtime.close();
    }
  });
}
