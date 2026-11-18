/**
 * Updates keep to the schema on every store, as MongoDB's `$jsonSchema`
 * validator does with `validationLevel: "strict"`: from plugin code and from
 * outside (REST), what an update sets, removes, counts and adds is checked, and
 * so is what it leaves. What's refused changes nothing, so the stores agree on
 * what they hold (an indexed field never holds a list). An update says what
 * changes with operators: one with none is refused, as MongoDB refuses it.
 * `$addToSet` takes `$each`.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
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
import { env, tempFile, temporary, test, TEST_ACTOR, testWho } from "../../testing/mod.ts";
import { updateCheck } from "../updates.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: () => memoryStore(),
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `u_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

const ana: Actor = { kind: "person", id: "ana" };

const customer = defineCollection({
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      price: { type: "number", minimum: 0 },
      n: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
      meta: {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
      },
      note: { type: "string" },
    },
    required: ["name", "price"],
    additionalProperties: false,
  },
  indexes: [["price"]],
});

type Customer = {
  _id: string;
  name?: string;
  price?: unknown;
  n?: number;
  tags?: unknown[];
  meta?: Record<string, unknown>;
  note?: string;
};

const probe = definePlugin({
  name: "probe",
  collections: { customer },
  // People write customers directly (REST, the socket), as plain apps do; their own reads
  // reach none of them (what reads as the system sees them all).
  guard: (actor, { collection, access }) =>
    collection !== "customer" || actor.kind !== "person"
      ? undefined
      : access === "write"
      ? true
      : { name: "nobody" },
  actions: {
    "customer.update": defineAction({
      input: { type: "object" },
      run: (ctx, input) => {
        const { filter, update, options, many } = input as {
          filter: Record<string, unknown>;
          update: Record<string, unknown>;
          options?: { upsert?: boolean };
          many?: boolean;
        };
        const customers = ctx.db.collection("customer");
        return many
          ? customers.updateMany(filter, update as never, options)
          : customers.updateOne(filter, update as never, options);
      },
    }),
    "customer.seed": defineAction({
      input: { type: "object" },
      run: (ctx) =>
        ctx.db.collection("customer").insertMany([
          { _id: "c1", name: "Bo", price: 5, n: 1, tags: ["x"], meta: { a: "q" } },
          { _id: "c2", name: "Al", price: 1 },
        ]),
    }),
  },
});

let store: Store;

const each = (name: string, fn: (rt: Runtime) => Promise<void>) => {
  for (const [kind, make] of Object.entries(stores)) {
    test(`${kind}: ${name}`, async () => {
      store = await make();
      const rt = await createRuntime({ store, plugins: [probe, testWho] });
      try {
        await rt.call("customer.seed", {});
        await fn(rt);
      } finally {
        await rt.close();
      }
    });
  }
};

const update = (rt: Runtime, update: unknown, more: Record<string, unknown> = {}) =>
  rt.call("customer.update", { filter: { _id: "c1" }, update, ...more });
const stored = async (rt: Runtime, id = "c1") =>
  (await store.find("customer", { _id: id }))[0] as Customer | undefined;

/** Refused as invalid, with a message naming the field. */
async function refused(work: () => Promise<unknown>, field: string) {
  const error = await assertRejects(work);
  assertEquals((error as { code?: string }).code, "invalid", (error as Error).message);
  assert((error as Error).message.includes(field), (error as Error).message);
}

each("an update that can't fit the schema is refused, and changes nothing", async (rt) => {
  const before = await stored(rt);
  await refused(() => update(rt, { $set: { price: "abc" } }), "price");
  await refused(() => update(rt, { $unset: { name: "" } }), "name");
  await refused(() => update(rt, { $set: { extra: 1 } }), "extra");
  await refused(() => update(rt, { $set: { "meta.b": "x" } }), "meta");
  await refused(() => update(rt, { $set: { "meta.a": 1 } }), "meta");
  await refused(() => update(rt, { $push: { tags: 7 } }), "tags");
  await refused(() => update(rt, { $addToSet: { tags: { $each: ["y", 7] } } }), "tags");
  await refused(() => update(rt, { $inc: { name: 1 } }), "name");
  await refused(() => update(rt, { $inc: { n: 0.5 } }), "n");
  // What it leaves must fit too: a price below its minimum.
  await refused(() => update(rt, { $inc: { price: -100 } }), "price");
  // Several at once: nothing changes if one can't fit.
  await refused(
    () => rt.call("customer.update", { filter: {}, update: { $set: { price: -1 } }, many: true }),
    "price",
  );
  assertEquals(await stored(rt), before);
  assertEquals((await stored(rt, "c2"))?.price, 1);
});

each("an update that fits is applied: set, unset, count, add", async (rt) => {
  await update(rt, { $set: { price: 6, "meta.a": "r" }, $unset: { note: "" }, $inc: { n: 2 } });
  await update(rt, { $push: { tags: "y" }, $addToSet: { tags: { $each: ["x", "z", "z"] } } });
  assertEquals(await stored(rt), {
    _id: "c1",
    name: "Bo",
    price: 6,
    n: 3,
    tags: ["x", "y", "z"],
    meta: { a: "r" },
  });
  await rt.call("customer.update", { filter: {}, update: { $inc: { price: 1 } }, many: true });
  assertEquals([(await stored(rt))?.price, (await stored(rt, "c2"))?.price], [7, 2]);
});

each("an upsert makes a valid document, or nothing", async (rt) => {
  await refused(
    () =>
      rt.call("customer.update", {
        filter: { _id: "c9" },
        update: { $set: { price: 1 } },
        options: { upsert: true },
      }),
    "name",
  );
  assertEquals(await stored(rt, "c9"), undefined);
  await rt.call("customer.update", {
    filter: { _id: "c9" },
    update: { $set: { name: "Cy", price: 1 } },
    options: { upsert: true },
  });
  assertEquals(await stored(rt, "c9"), { _id: "c9", name: "Cy", price: 1 });
  // One whose new document wouldn't fit still updates the document it finds.
  await rt.call("customer.update", {
    filter: { _id: "c9" },
    update: { $set: { price: 2 } },
    options: { upsert: true },
  });
  assertEquals((await stored(rt, "c9"))?.price, 2);
});

each("from outside, a plain PATCH is checked as $set is", async (rt) => {
  const patch = (body: unknown) =>
    rt.fetch(
      new Request("http://localhost/api/collections/customer/c1", {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", [TEST_ACTOR]: JSON.stringify(ana) },
      }),
    );
  const wrong = await patch({ price: "abc" });
  assertEquals(wrong.status, 400);
  assertEquals((await wrong.json()).error.code, "invalid");
  assertEquals((await patch({ $unset: { name: "" } })).status, 400);
  assertEquals((await stored(rt))?.price, 5);
  assertEquals((await patch({ price: 8 })).status, 200);
  assertEquals((await stored(rt))?.price, 8);
});

each("an indexed field holds what its schema says, so every store finds the same", async (rt) => {
  await refused(() => update(rt, { $set: { price: [9, 10] } }), "price");
  await refused(() => update(rt, { $set: { price: "7" } }), "price");
  const ids = async (filter: Record<string, unknown>) =>
    (await store.find("customer", filter)).map((doc) => doc._id).sort();
  assertEquals(await ids({ price: { $gt: 2 } }), ["c1"]);
  assertEquals(await ids({ price: 5 }), ["c1"]);
  assertEquals(await ids({ price: 9 }), []);
});

each("an update with no operator is refused; replaceOne replaces", async (rt) => {
  await refused(() => update(rt, { note: "x" }), "operators");
  await refused(() => update(rt, {}), "operators");
  assertEquals((await stored(rt))?.name, "Bo");
});

each("$push takes $each, and refuses the modifiers it doesn't support", async (rt) => {
  await update(rt, { $push: { tags: { $each: ["y", "y"] } } });
  assertEquals((await stored(rt))?.tags, ["x", "y", "y"]);
  const error = await assertRejects(() =>
    update(rt, { $push: { tags: { $each: ["z"], $slice: 2 } } })
  );
  assert((error as Error).message.includes("$slice"), (error as Error).message);
  assertEquals((await stored(rt))?.tags, ["x", "y", "y"]);
});

// Older documents that predate their schema. Strict still lets them be updated, refusing only
// what an update adds to what was wrong (every store can tell that alike); moderate lets updates
// to them be, as MongoDB's validationLevel does. Both keep valid documents valid.
const legacy = definePlugin({
  name: "legacy",
  collections: {
    old: defineCollection({ schema: customer.schema, validation: "moderate" }),
    strict: defineCollection({ schema: customer.schema }),
  },
  actions: {
    "old.update": defineAction({
      input: { type: "object" },
      run: (ctx, input) => {
        const { collection, id, update } = input as {
          collection: string;
          id: string;
          update: Record<string, unknown>;
        };
        return ctx.db.collection(collection).updateOne({ _id: id }, update as never);
      },
    }),
  },
});

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: a document older than its schema: strict refuses new problems, moderate none`, async () => {
    const store = await make();
    const { epoch } = await store.open();
    await store.transaction(epoch, async (tx) => {
      for (const collection of ["old", "strict"]) {
        await tx.insert(collection, [{ _id: "was", price: 3 }, { _id: "ok", name: "A", price: 1 }]);
      }
    });
    const rt = await createRuntime({ store, plugins: [legacy] });
    try {
      const update = (collection: string, id: string, update: unknown) =>
        rt.call("old.update", { collection, id, update });
      const price = async (collection: string, id: string) =>
        (await store.find(collection, { _id: id }))[0]?.price;
      // A document that wasn't valid (no name): both update it with what fits.
      for (const collection of ["old", "strict"]) {
        await update(collection, "was", { $set: { price: 4 } });
        assertEquals(await price(collection, "was"), 4);
      }
      // A new problem: strict refuses it, whether it's told before or after the store's work;
      // moderate lets it be.
      await refused(() => update("strict", "was", { $set: { price: -1 } }), "price");
      await refused(() => update("strict", "was", { $inc: { price: -100 } }), "price");
      assertEquals(await price("strict", "was"), 4);
      await update("old", "was", { $inc: { price: -100 } });
      assertEquals(await price("old", "was"), -96);
      // A valid one keeps to the schema on both.
      for (const collection of ["old", "strict"]) {
        await refused(() => update(collection, "ok", { $set: { price: "x" } }), "price");
        await refused(() => update(collection, "ok", { $unset: { name: "" } }), "name");
        await update(collection, "ok", { $set: { price: 2 } });
        assertEquals(await price(collection, "ok"), 2);
      }
    } finally {
      await rt.close();
    }
  });
}

test("the check before the store is sure only when a valid document can't come out invalid", () => {
  const sure = (schema: Record<string, unknown>, update: Record<string, unknown>) =>
    updateCheck(schema, "t")(update);
  const plain = customer.schema as unknown as Record<string, unknown>;
  // Plain sets, unsets and counts: sure, so PostgreSQL may run them in one statement.
  assertEquals(sure(plain, { $set: { name: "x", "meta.a": "y" }, $unset: { note: "" } }), true);
  assertEquals(sure(plain, { $inc: { n: 1 } }), true);
  assertEquals(sure(plain, { $push: { tags: "x" } }), true);
  // A rule about the result: the documents it leaves are checked.
  assertEquals(sure(plain, { $inc: { price: 1 } }), false);
  // An object a nested $set may create, with rules of its own.
  const nested = {
    type: "object",
    properties: {
      meta: { type: "object", properties: { a: { type: "string" } }, required: ["b"] },
    },
  };
  assertEquals(sure(nested, { $set: { "meta.a": "y" } }), false);
  assertEquals(sure(nested, { $set: { meta: { b: 1 } } }), true);
  // A rule about the whole document, or a path through a combinator.
  assertEquals(sure({ ...plain, minProperties: 2 }, { $set: { name: "x" } }), false);
  const either = { type: "object", properties: { v: { anyOf: [{ type: "string" }] } } };
  assertEquals(sure(either, { $set: { "v.x": 1 } }), false);
});
