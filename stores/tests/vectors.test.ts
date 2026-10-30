/**
 * Vector fields: written like any field, kept as the store's vectors (not in
 * documents), searched with `nearest`, and gone with their document. Every
 * store answers alike.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Store,
} from "../../runtime/mod.ts";
import { memoryStore } from "../memory/mod.ts";
import { sqliteStore } from "../sql/sqlite/mod.ts";
import { postgresStore } from "../sql/postgres/mod.ts";
import { env, tempFile, temporary, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `v_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

type Item = { _id: string; text: string; tag?: string; embedding?: number[] | null };
const object = { type: "object" } as const;

const items = definePlugin({
  name: "items",
  collections: {
    item: defineCollection({
      // The schema doesn't know the vector field: it never reaches the document.
      schema: {
        type: "object",
        properties: { text: { type: "string" }, tag: { type: "string" } },
        additionalProperties: false,
      },
      vectors: ["embedding"],
      queries: {
        near: (items, p: { vector: number[]; filter?: Record<string, unknown>; limit?: number }) =>
          items.nearest(p.vector, { filter: p.filter, limit: p.limit }),
      },
    }),
    plain: defineCollection({ schema: object }),
  },
  actions: {
    "item.add": defineAction({
      input: object,
      run: (ctx, input) => ctx.db.collection<Item>("item").insertOne(input as Item),
    }),
    "item.set": defineAction({
      input: object,
      run: (ctx, input: { id: string; set: Record<string, unknown> }) =>
        ctx.db.collection("item").updateOne({ _id: input.id }, { $set: input.set }),
    }),
    "item.unset": defineAction({
      input: object,
      run: (ctx, input: { id: string }) =>
        ctx.db.collection("item").updateOne({ _id: input.id }, { $unset: { embedding: 1 } }),
    }),
    "item.replace": defineAction({
      input: object,
      run: (ctx, input: { id: string; doc: Item }) =>
        ctx.db.collection("item").replaceOne({ _id: input.id }, input.doc),
    }),
    "item.remove": defineAction({
      input: object,
      run: (ctx, input: { id: string }) => ctx.db.collection("item").deleteOne({ _id: input.id }),
    }),
    "plain.near": defineAction({
      input: object,
      run: (ctx) => ctx.db.collection("plain").nearest([1, 0]),
    }),
  },
});

async function start(make: () => Store | Promise<Store>) {
  const store = await make();
  const runtime = await createRuntime({ store, plugins: [items] });
  const near = async (vector: number[], filter?: Record<string, unknown>, limit?: number) =>
    (await runtime.query<(Item & { _score: number })[]>("item.near", { vector, filter, limit }))
      .map((doc) => [doc._id, Math.round(doc._score * 1e5) / 1e5]);
  return { runtime, store, near };
}

each("nearest ranks by cosine similarity, among the documents the filter keeps", async (make) => {
  const { runtime, store, near } = await start(make);
  for (
    const [_id, embedding, tag] of [
      ["a", [1, 0, 0], "x"],
      ["b", [0.6, 0.8, 0], "y"],
      ["c", [0, 1, 0], "y"],
      ["d", [0, 0, 2], "x"],
      ["e", [1, 0], "x"], // another length: only 2-dimensional queries see it
    ] as const
  ) await runtime.call("item.add", { _id, text: _id, tag, embedding });
  assertEquals(await near([1, 0, 0]), [["a", 1], ["b", 0.6], ["c", 0], ["d", 0]]);
  assertEquals(await near([1, 0, 0], { tag: "y" }), [["b", 0.6], ["c", 0]]);
  assertEquals(await near([0, 1, 0], {}, 2), [["c", 1], ["b", 0.8]]);
  assertEquals(await near([3, 0]), [["e", 1]]);
  // Documents don't carry their vectors.
  assertEquals(await store.find("item", { _id: "a" }), [{ _id: "a", text: "a", tag: "x" }]);
  await runtime.close();
});

each("vectors follow their documents: set, unset, replaced, deleted", async (make) => {
  const { runtime, near } = await start(make);
  for (const [_id, embedding] of [["a", [1, 0]], ["b", [0, 1]], ["c", [1, 1]]] as const) {
    await runtime.call("item.add", { _id, text: _id, embedding });
  }
  // $set the vector alone, or with other fields.
  await runtime.call("item.set", { id: "b", set: { embedding: [1, 0] } });
  await runtime.call("item.set", { id: "c", set: { embedding: [-1, 0], tag: "far" } });
  assertEquals(await near([1, 0]), [["a", 1], ["b", 1], ["c", -1]]);
  // $unset removes it; a replacement keeps only the vectors it gives.
  await runtime.call("item.unset", { id: "a" });
  await runtime.call("item.replace", { id: "b", doc: { text: "b again" } });
  assertEquals(await near([1, 0]), [["c", -1]]);
  await runtime.call("item.replace", { id: "b", doc: { text: "b", embedding: [0.6, 0.8] } });
  // A deleted document takes its vectors: the same id comes back without one.
  await runtime.call("item.remove", { id: "c" });
  await runtime.call("item.add", { _id: "c", text: "c" });
  assertEquals(await near([1, 0]), [["b", 0.6]]);
  await runtime.close();
});

each("a vector must be numbers, and nearest needs a vector field", async (make) => {
  const { runtime } = await start(make);
  await assertRejects(
    () => runtime.call("item.add", { _id: "x", text: "x", embedding: ["no"] }),
    Error,
    '"embedding" must be an array of numbers',
  );
  await assertRejects(
    () => runtime.call("plain.near", {}),
    Error,
    'Name the vector field of "plain"',
  );
  const nothing = await runtime.query<unknown[]>("item.near", { vector: [1, 0] });
  assert(Array.isArray(nothing) && nothing.length === 0);
  await runtime.close();
});
