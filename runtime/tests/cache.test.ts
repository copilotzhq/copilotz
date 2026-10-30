/**
 * The owner's cache never returns what the store wouldn't. A seeded random
 * sequence of inserts, upserts, updates (including sort keys and ties) and
 * deletes runs through the runtime; after every write, each query read
 * through the owner (cached) must equal the same query read straight from the
 * store, on every store.
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime, defineAction, defineCollection, definePlugin, type Store } from "../mod.ts";
import type { Filter, FindOptions } from "../store.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, temporary, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `c_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

const QUERIES: { filter: Filter; options: FindOptions }[] = [
  { filter: { group: "a" }, options: { sort: { rank: 1 }, limit: 3 } },
  { filter: { group: "b" }, options: { sort: { rank: -1 } } },
  { filter: { rank: { $gte: 5 } }, options: { sort: { rank: 1, label: 1 }, limit: 5 } },
  { filter: {}, options: { sort: { label: 1 }, limit: 4 } },
  { filter: { tags: "x" }, options: { sort: { rank: 1 } } },
  { filter: { group: { $in: ["a", "c"] }, rank: { $lt: 6 } }, options: {} },
  { filter: {}, options: { sort: { rank: -1 }, limit: 2 } },
];
const COUNTS: Filter[] = [{ group: "a" }, { rank: { $gt: 3 } }, {}];

const object = { type: "object" } as const;
const items = definePlugin({
  name: "items",
  collections: {
    item: defineCollection({
      schema: {
        type: "object",
        properties: {
          group: { type: "string" },
          rank: { type: "number" },
          label: { type: "string" },
          tags: { type: "array" },
        },
      },
      queries: {
        find: (items, { filter, options }: { filter: Filter; options: FindOptions }) =>
          items.find(filter, options),
        findOne: (items, { id }: { id: string }) => items.findOne({ _id: id }),
        count: (items, { filter }: { filter: Filter }) => items.countDocuments(filter),
      },
    }),
  },
  actions: {
    "item.add": defineAction({
      input: object,
      run: (ctx, input) => ctx.db.collection("item").insertOne(input as never),
    }),
    "item.put": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, { id, ...doc }) =>
        ctx.db.collection("item").replaceOne({ _id: id }, doc, { upsert: true }),
    }),
    "item.patch": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, { id, ...set }) => ctx.db.collection("item").updateOne({ _id: id }, { $set: set }),
    }),
    "item.push": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, { id }) =>
        ctx.db.collection("item").updateOne({ _id: id }, { $push: { tags: "x" } }),
    }),
    "item.drop": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, { id }) => ctx.db.collection("item").deleteOne({ _id: id }),
    }),
  },
});

/** A small deterministic generator, so a failure replays exactly. */
function random(seed: number) {
  return () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

for (const [name, make] of Object.entries(stores)) {
  for (const seed of [42, 7, 2026]) {
    test(`${name}: cached reads always equal the store's (seed ${seed})`, async () => {
      const store = await make();
      const runtime = await createRuntime({ store, plugins: [items] });
      const next = random(seed);
      const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
      const ids = Array.from({ length: 12 }, (_, i) => `i${i}`);
      const doc = () => ({
        group: pick(["a", "b", "c"]),
        rank: Math.floor(next() * 9),
        label: pick(["p", "q", "r", "s"]),
        ...(next() < 0.3 ? { tags: [pick(["x", "y"])] } : {}),
      });

      const check = async (step: number) => {
        for (const query of QUERIES) {
          const cached = await runtime.query("item.find", query);
          const direct = await store.find("item", query.filter, query.options);
          assertEquals(cached, direct, `step ${step}: ${JSON.stringify(query)}`);
        }
        for (const filter of COUNTS) {
          assertEquals(
            await runtime.query("item.count", { filter }),
            await store.count("item", filter),
          );
        }
        for (const id of ids.slice(0, 4)) {
          assertEquals(
            await runtime.query("item.findOne", { id }),
            await store.findOne("item", { _id: id }),
          );
        }
      };

      await check(0);
      for (let step = 1; step <= 300; step++) {
        const id = pick(ids);
        const roll = next();
        try {
          if (roll < 0.25) await runtime.call("item.add", { _id: id, ...doc() });
          else if (roll < 0.45) await runtime.call("item.put", { id, ...doc() });
          else if (roll < 0.7) {
            await runtime.call("item.patch", {
              id,
              ...(next() < 0.5
                ? { rank: Math.floor(next() * 9) }
                : { label: pick(["p", "q", "z"]) }),
            });
          } else if (roll < 0.8) await runtime.call("item.push", { id });
          else await runtime.call("item.drop", { id });
        } catch (error) {
          // Inserting an existing _id is refused; the cache must not change either.
          assertEquals((error as { code?: string }).code, "duplicate_key", String(error));
        }
        await check(step);
      }
      const { hits, misses } = runtime.stats();
      assert(hits > misses, `the cache served most reads (${hits} hits, ${misses} misses)`);
      await runtime.close();
    });
  }
}

test("a write to one collection leaves other collections' cached queries alone", async () => {
  const other = definePlugin({
    name: "other",
    collections: { note: defineCollection({ schema: { type: "object" } }) },
    actions: {
      "note.add": defineAction({
        input: { type: "object" },
        run: (ctx) => ctx.db.collection("note").insertOne({}),
      }),
    },
  });
  const runtime = await createRuntime({ store: memoryStore(), plugins: [items, other] });
  await runtime.call("item.add", { group: "a", rank: 1, label: "p" });
  const query = { filter: { group: "a" }, options: { sort: { rank: 1 } } };
  await runtime.query("item.find", query);
  await runtime.call("note.add", {});
  const before = runtime.stats();
  await runtime.query("item.find", query);
  assertEquals(runtime.stats().hits - before.hits, 1);
  await runtime.close();
});
