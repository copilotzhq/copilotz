/**
 * The field paths a write may name. A part that starts with `$` would let
 * an update build what plugin code can't write whole (`{ $set: { "a.$blob":
 * … } }` makes a blob reference), and one through `__proto__` would change
 * every object's prototype (Node and Bun follow it; Deno has no `__proto__`).
 * So no part of an update's path, or an upsert's seed, may start with `$`, or
 * be `__proto__`, `constructor` or `prototype`; and reads follow only a
 * document's own fields.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { createRuntime, defineAction, defineCollection, definePlugin, type Store } from "../mod.ts";
import { applyUpdate, get, matches, seedOf } from "../mongo.ts";
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
        temporary(postgresStore({ url: POSTGRES, schema: `p_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

const code = (error: unknown) => (error as { code?: string }).code;
const polluted = () => (({}) as Record<string, unknown>).polluted;

/** Paths no write may name, and what each would do. */
const BAD = [
  "bio.$blob",
  "list.0.$blob",
  "$blob",
  "a.$",
  "__proto__.polluted",
  "a.__proto__.polluted",
  "constructor.prototype.polluted",
  "prototype.polluted",
];

/** An update naming `path` with each operator. */
const updates = (path: string) => [
  { $set: { [path]: "yes" } },
  { $unset: { [path]: true } },
  { $inc: { [path]: 1 } },
  { $push: { [path]: "yes" } },
  { $addToSet: { [path]: "yes" } },
  { $pull: { [path]: "yes" } },
];

test("an update names no $ field and never the prototype, with any operator", () => {
  for (const path of BAD) {
    for (const update of updates(path)) {
      // As it comes over the wire: JSON, where `__proto__` is an ordinary key.
      const parsed = JSON.parse(JSON.stringify(update));
      const error = assertThrows(() => applyUpdate({ _id: "a", list: [{}] }, parsed));
      assertEquals(code(error), "invalid", JSON.stringify(update));
      assertEquals(polluted(), undefined, JSON.stringify(update));
    }
  }
  // An upsert's seed is written too.
  for (const path of ["__proto__", "a.__proto__", "constructor", "a.$blob"]) {
    const filter = JSON.parse(`{"${path}": {"$eq": {"polluted": "yes"}}, "_id": "a"}`);
    assertEquals(code(assertThrows(() => seedOf(filter))), "invalid", path);
  }
  assertEquals(polluted(), undefined);
});

test("dotted paths still reach fields, array elements and new objects", () => {
  const doc = { _id: "a", list: [{ a: 1 }], n: 1, tags: ["x"] };
  assertEquals(
    applyUpdate(doc, {
      $set: { "list.0.b": 2, "deep.er": true, "constructors": 1 },
      $inc: { n: 1 },
      $push: { tags: "y" },
    }),
    {
      _id: "a",
      list: [{ a: 1, b: 2 }],
      n: 2,
      tags: ["x", "y"],
      deep: { er: true },
      constructors: 1,
    },
  );
  assertEquals(applyUpdate(doc, { $unset: { "list.0.a": true } }).list, [{}]);
});

test("a read follows a document's own fields, never its prototype's", () => {
  assertEquals(get({}, "constructor"), undefined);
  assertEquals(get({}, "__proto__"), undefined);
  assertEquals(get({ a: {} }, "a.hasOwnProperty"), undefined);
  assertEquals(get({ list: [1, 2] }, "list.length"), 2);
  // A field of that name, as JSON can have, is a field like any other.
  const own = JSON.parse('{"__proto__": {"a": 1}, "constructor": "c"}');
  assertEquals([get(own, "__proto__.a"), get(own, "constructor")], [1, "c"]);
  assertEquals(matches({ _id: "x" }, { constructor: { $exists: true } }), false);
  assertEquals(matches({ _id: "x" }, { "toString": { $exists: true } }), false);
});

const profiles = definePlugin({
  name: "profiles",
  collections: {
    profile: defineCollection({
      schema: { type: "object" },
      queries: { all: (profiles) => profiles.find({}, { sort: { _id: 1 } }) },
    }),
  },
  actions: {
    // Patches what it's given, as a typical "change these fields" Action does.
    "profile.patch": defineAction({
      input: { type: "object", properties: { json: { type: "string" } }, required: ["json"] },
      run: (ctx, { json }) => {
        const { id, update, upsert } = JSON.parse(json);
        return ctx.db.collection("profile").updateOne({ _id: id }, update, { upsert });
      },
    }),
  },
});

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: plugin code's updates name no $ field and never the prototype`, async () => {
    const runtime = await createRuntime({ store: await make(), plugins: [profiles] });
    const patch = (id: string, update: unknown, upsert = true) =>
      runtime.call("profile.patch", { json: JSON.stringify({ id, update, upsert }) });
    try {
      await patch("p", { $set: { list: [{}], n: 1 } });
      for (const path of BAD) {
        for (const update of updates(path)) {
          for (const upsert of [true, false]) {
            const error = await patch("p", update, upsert).then(() => undefined, (e) => e);
            assertEquals(code(error), "invalid", `${JSON.stringify(update)}, upsert ${upsert}`);
          }
        }
      }
      assertEquals(polluted(), undefined);
      // As before: the document as it was, and fine dotted paths still work.
      await patch("p", { $set: { "list.0.a": 1, "deep.er": true } });
      assertEquals(await runtime.query("profile.all"), [
        { _id: "p", list: [{ a: 1 }], n: 1, deep: { er: true } },
      ]);
    } finally {
      await runtime.close();
    }
  });
}
