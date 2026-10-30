/**
 * Rollups: closing a day rolls its records up, and totals take whole closed
 * days from the rollups and the rest from the records, with the same result
 * as the records alone, for any filter and grouping they can serve. The
 * daily schedule closes what's due, and closes again a day whose records
 * came late.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  definePlugin,
  type Filter,
  manualClock,
  type ReadCollection,
  type Store,
} from "../../../runtime/mod.ts";
import { merge } from "../../../runtime/registry.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../stores/sql/postgres/mod.ts";
import usage, { type Totals, totals, type UsageRecord, type Use } from "../usage/mod.ts";
import { env, tempFile, temporary, test } from "../../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `u_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

/** Uses over eight days (Oct 10–17), from a seeded generator: the same every run. */
function uses(count: number, days: number[], seed: number): Use[] {
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return Array.from({ length: count }, () => {
    const day = days[Math.floor(random() * days.length)];
    const at = new Date(Date.UTC(2026, 9, day) + Math.floor(random() * 86_400_000)).toISOString();
    return {
      meter: random() < 0.8 ? "llm" : "tool",
      // m/b has no cost: its uses are unpriced.
      subject: random() < 0.7 ? "m/a" : "m/b",
      quantities: {
        input: Math.floor(random() * 1000),
        output: Math.floor(random() * 100),
        ...(random() < 0.2 ? { seconds: Math.round(random() * 1000) / 100 } : {}),
      },
      tags: {
        thread: `t${Math.floor(random() * 5)}`,
        ...(random() < 0.8 ? { agent: random() < 0.5 ? "a1" : "a2" } : {}),
        purpose: random() < 0.3 ? "memory" : "chat",
      },
      at,
    };
  });
}

const app = definePlugin({
  name: "app",
  resources: {
    cost: { "m/a": { input: 1, output: 2, seconds: 0.001, per: 1 } },
    price: { "*": { markup: 0.5 } },
  },
  actions: {
    "seed.uses": defineAction({
      input: { type: "object", properties: { uses: { type: "array" } }, required: ["uses"] },
      run: async (ctx, input) => {
        for (const use of input.uses as Use[]) await ctx.call("usage.record", use);
      },
    }),
    // Changes one rollup, to see which totals read them.
    "rollup.tamper": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("usageRollup").updateOne(
          { day: "2026-10-13", meter: "llm" },
          { $inc: { "quantities.input": 1_000_000 } },
        ),
    }),
    // Totals from the records alone, to compare with.
    "raw.totals": defineAction({
      input: { type: "object" },
      run: (ctx, params) =>
        totals(ctx.db.collection("usage") as unknown as ReadCollection<UsageRecord>, params),
    }),
  },
});

/** Totals in a stable order, numbers to a millionth (sums in another order round apart). */
const settled = (list: Totals[]) =>
  JSON.stringify(
    [...list].sort((a, b) => JSON.stringify(a.key) < JSON.stringify(b.key) ? -1 : 1),
    (_, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v,
  );

const CASES: { filter?: Filter; by?: string[]; units?: string[] }[] = [
  {},
  { by: ["day"] },
  { by: ["month", "meter"] },
  { filter: { meter: "llm" }, by: ["tags.agent"] },
  // Bounds inside days: their parts come from the records.
  {
    filter: { at: { $gte: "2026-10-12T13:00:00.000Z", $lt: "2026-10-16T05:00:00.000Z" } },
    by: ["day", "subject"],
  },
  { filter: { at: { $gt: "2026-10-12", $lte: "2026-10-17" } }, by: ["tags.purpose"] },
  { filter: { "tags.agent": "a1", subject: { $in: ["m/a"] } }, by: ["day", "kind"] },
  { filter: { at: { $gte: "2026-10-14", $lt: "2026-10-15" } }, units: ["input"] },
  // What rollups don't keep: from the records.
  { by: ["tags.thread"] },
  { filter: { "tags.thread": "t1" }, by: ["day"] },
];

async function compare(runtime: Awaited<ReturnType<typeof createRuntime>>) {
  for (const params of CASES) {
    const [rolled, raw] = await Promise.all([
      runtime.query<Totals[]>("usage.totals", params),
      runtime.call<Totals[]>("raw.totals", params),
    ]);
    assert(raw.length, `no totals for ${JSON.stringify(params)}`);
    assertEquals(settled(rolled), settled(raw), JSON.stringify(params));
  }
}

each("totals from rollups and records are the totals of the records", async (make) => {
  const store = await make();
  const runtime = await createRuntime({ store, plugins: [usage, app] });
  try {
    await runtime.call("seed.uses", { uses: uses(400, [10, 11, 12, 13, 14, 15, 16, 17], 42) });
    const closed = await runtime.call<{ days: number; rollups: number }>("usage.close", {
      through: "2026-10-16",
    });
    assertEquals(closed.days, 7);
    assert(closed.rollups > 0 && closed.rollups < 400);
    await compare(runtime);

    // Rollups really are read: changing one changes the totals that use them, and only those.
    await runtime.call("rollup.tamper", {});
    const [all] = await runtime.query<Totals[]>("usage.totals", {});
    const [raw] = await runtime.call<Totals[]>("raw.totals", {});
    assertEquals(all.quantities.input! - raw.quantities.input!, 1_000_000);
    const byThread = await runtime.query<Totals[]>("usage.totals", { by: ["tags.thread"] });
    assertEquals(
      settled(byThread),
      settled(await runtime.call<Totals[]>("raw.totals", { by: ["tags.thread"] })),
    );
  } finally {
    await runtime.close();
  }
});

each("the daily close catches up, and closes again a day whose records came late", async (make) => {
  const store = await make();
  const clock = manualClock("2026-10-15T12:00:00.000Z");
  const runtime = await createRuntime({ store, plugins: [usage, app], clock });
  try {
    await runtime.call("seed.uses", { uses: uses(300, [10, 11, 12, 13, 14, 15], 7) });
    // 00:10 UTC: every day through yesterday closes, from the ledger's first.
    clock.set("2026-10-16T00:10:00.000Z");
    await runtime.idle();
    const days = async () =>
      (await store.find("usageClosed", {}, { sort: { _id: 1 } })).map((d) =>
        [d._id, d.records as number] as const
      );
    const first = await days();
    assertEquals(first.map(([day]) => day), [
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
    ]);
    assertEquals(
      first.reduce((n, [, records]) => n + records, 0),
      300,
    );
    await compare(runtime);

    // Records for a closed day arrive late, with the next day's.
    await runtime.call("seed.uses", { uses: uses(40, [13, 16], 9) });
    clock.set("2026-10-17T00:10:00.000Z");
    await runtime.idle();
    const second = new Map(await days());
    assertNotEquals(second.get("2026-10-13"), new Map(first).get("2026-10-13"));
    assert(second.has("2026-10-16"));
    await compare(runtime);
  } finally {
    await runtime.close();
  }
});

test("rollups are optional, and their dimensions must be fields they can keep", async () => {
  const { usagePlugin } = await import("../usage/mod.ts");
  // Off: the app removes the schedule that closes days.
  const off = merge([
    usagePlugin,
    definePlugin({ name: "app", schedules: { "usage.close": null } }),
  ]);
  assertEquals(off.schedules, {});
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: [
          usagePlugin,
          definePlugin({
            name: "app",
            resources: { usage: { rollups: { dimensions: ["quantities.input"] } } },
          }),
        ],
      }),
    Error,
    "not tags.<name> or catalog",
  );
});
