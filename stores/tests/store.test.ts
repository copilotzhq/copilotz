/**
 * Every storage adapter behaves like the reference (the in-memory store over
 * runtime/mongo.ts): the same queries return the same documents in the same
 * order, and writes, events, edges and fencing work alike.
 */
import { assertEquals, assertRejects } from "@std/assert";
import type { Doc, Filter, FindOptions, IndexSpec, Store, Update } from "../../runtime/store.ts";
import { type Pipeline, plan } from "../../runtime/aggregate.ts";
import { memoryStore } from "../memory/mod.ts";
import { sqliteStore } from "../sql/sqlite/mod.ts";
import { postgresStore } from "../sql/postgres/mod.ts";
import { env, tempFile, temporary, test } from "../../testing/mod.ts";
import { pooled } from "./pooled.ts";

const temp = () => tempFile(".sqlite");

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
/** A fresh schema per store, so tests sharing one database never meet. */
const schema = () => `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const adapters: Record<string, () => Store | Promise<Store>> = {
  memory: () => memoryStore(),
  sqlite: () => sqliteStore({ path: temp() }),
  pglite: () => postgresStore({ url: ":memory:" }),
  // A tenant of a schema it shares with another, which must never show.
  "pglite tenant": () => pooled(":memory:"),
  ...(POSTGRES
    ? {
      postgres: () => temporary(postgresStore({ url: POSTGRES, schema: schema() })),
      "postgres tenant": () => pooled(POSTGRES),
    }
    : {}),
};

const DOCS: Doc[] = [
  { _id: "a", n: 1, s: "x", b: true, tags: ["red", "blue"], nested: { k: 1 }, at: "2026-01-01" },
  {
    _id: "b",
    n: 2,
    s: "y",
    b: false,
    tags: ["green"],
    nested: { k: 2 },
    at: "2026-01-02",
    nil: null,
  },
  { _id: "c", n: 3.5, s: "z", tags: [], at: "2026-01-02" },
  { _id: "d", s: "10", list: [1, 2, 3], objs: [{ x: 1 }, { x: 2 }] },
  {
    _id: "e",
    n: 2,
    s: "x",
    b: true,
    nested: { k: 1, deep: { v: "q" } },
    nil: null,
    arr: [[1, 2], [3]],
  },
];

const FILTERS: Filter[] = [
  {},
  { _id: "a" },
  { _id: "a", n: 2 },
  { _id: { $in: ["a", "c"] } },
  { n: 2 },
  { n: { $eq: 2 } },
  { s: "x" },
  { s: "10" },
  { b: true },
  { b: false },
  { nil: null },
  { tags: "red" },
  { tags: ["red", "blue"] },
  { tags: [] },
  { "nested.k": 1 },
  { "nested.deep.v": "q" },
  { nested: { k: 2 } },
  { "list.1": 2 },
  { list: 2 },
  { objs: { x: 1 } },
  { arr: [3] },
  { n: { $gt: 1 } },
  { n: { $gte: 2, $lt: 3.5 } },
  { s: { $lt: "y" } },
  { n: { $ne: 2 } },
  { n: { $in: [1, 3.5] } },
  { n: { $nin: [1, 2] } },
  { tags: { $in: ["green", "red"] } },
  // Many values of a type go as one parameter; null and objects one by one.
  { s: { $in: ["x", "10", "q"] } },
  { s: { $nin: ["x", "10"] } },
  { list: { $in: [2, 9] } },
  { tags: { $nin: ["red", "green"] } },
  { b: { $in: [true, false] } },
  { n: { $in: [2, "2", null, 3.5] } },
  { nil: { $in: [null, "x"] } },
  { objs: { $in: [{ x: 2 }, { x: 9 }] } },
  { arr: { $in: [[3], [9]] } },
  // An array with an element in (or out of) a list; all elements in it.
  { tags: { $elemMatch: { $in: ["red", "x"] } } },
  { tags: { $elemMatch: { $nin: ["red"] } } },
  { tags: { $not: { $elemMatch: { $nin: ["red", "blue"] } } } },
  { list: { $elemMatch: { $in: [2] } } },
  { s: { $elemMatch: { $in: ["x"] } } },
  { _id: { $in: ["a", "b", "e"] } },
  { b: { $exists: true } },
  { b: { $exists: false } },
  { nil: { $exists: true } },
  { n: { $not: { $gt: 1 } } },
  { n: { $gt: null } },
  { nil: { $gte: null } },
  { nil: { $lte: null } },
  { n: { $lt: null } },
  { $or: [{ n: 1 }, { s: "z" }] },
  { $and: [{ n: 2 }, { b: true }] },
  { $nor: [{ n: 2 }] },
  { $or: [] },
];

const PAGES: FindOptions[] = [
  { sort: { n: 1 } },
  { sort: { n: -1 } },
  { sort: { at: -1, n: 1 } },
  { sort: { s: 1 }, limit: 2, skip: 1 },
  { limit: 2 },
  { skip: 3 },
];

const ids = (docs: Doc[]) => docs.map((doc) => doc._id);

async function seeded(make: () => Store | Promise<Store>) {
  const store = await make();
  const { epoch } = await store.open();
  await store.transaction(epoch, (tx) => tx.insert("things", structuredClone(DOCS)));
  return { store, epoch };
}

/**
 * MongoDB's answers, written out: every adapter, the reference included, must
 * give exactly these. Each case is one line of the compatibility list in
 * stores/README.md.
 */
const MONGO_DOCS: Doc[] = [
  { _id: "a", n: 1, s: "1", tags: ["x", "y"], scores: [3, 9] },
  { _id: "b", n: null, s: "b" },
  { _id: "c", s: "B" },
  { _id: "d", n: 2.5, tags: [], f: false },
  { _id: "e", n: "2", tags: [null], t: true, o: { k: 1 } },
];
const MONGO_FILTERS: [Filter, string][] = [
  [{ n: null }, "bc"], // null matches null and a missing field
  [{ n: { $ne: null } }, "ade"],
  [{ n: { $in: [null, 1] } }, "abc"],
  [{ n: { $nin: [null] } }, "ade"],
  [{ n: { $in: [1, 2.5, "2"] } }, "ade"], // each value matches its own type
  [{ tags: { $in: ["y", "z"] } }, "a"], // an array matches when an element is in the list
  [{ n: 1 }, "a"],
  [{ s: "1" }, "a"], // equality is type-strict
  [{ n: { $gt: 1 } }, "d"], // comparisons only match the operand's type
  [{ n: { $gte: "0" } }, "e"],
  [{ n: { $lt: 3 } }, "ad"], // null and missing don't compare with numbers
  [{ n: { $gte: null } }, "bc"], // null compares equal only to null and missing
  [{ n: { $gt: null } }, ""],
  [{ scores: { $gt: 5 } }, "a"], // an array matches when an element does
  [{ scores: { $lt: 5, $gt: 4 } }, "a"], // …each condition by any element, as in MongoDB
  [{ tags: "x" }, "a"],
  [{ tags: null }, "bce"], // missing, or an array holding null
  [{ "tags.0": "x" }, "a"],
  [{ tags: { $exists: false } }, "bc"],
  [{ f: false }, "d"],
  [{ "o.k": 1 }, "e"],
  [{ n: { $not: { $gt: 1 } } }, "abce"],
  [{ $or: [{ n: 1 }, { s: "B" }] }, "ac"],
  [{ $nor: [{ n: null }, { n: 1 }] }, "de"],
];
const MONGO_SORTS: [Record<string, 1 | -1>, string][] = [
  // null and missing are equal and first; then numbers, strings (code points: "B" < "b").
  [{ n: 1 }, "bcade"],
  [{ n: -1 }, "edabc"],
  [{ s: 1 }, "deacb"],
  [{ t: -1, _id: 1 }, "eabcd"],
];

for (const [name, make] of Object.entries(adapters)) {
  test(`${name} answers like MongoDB`, async () => {
    const store = await make();
    const { epoch } = await store.open();
    await store.transaction(epoch, (tx) => tx.insert("m", structuredClone(MONGO_DOCS)));
    const ids = (docs: Doc[]) => docs.map((d) => d._id).join("");
    for (const [filter, expected] of MONGO_FILTERS) {
      assertEquals(ids(await store.find("m", filter)), expected, JSON.stringify(filter));
      assertEquals(await store.count("m", filter), expected.length, JSON.stringify(filter));
    }
    for (const [sort, expected] of MONGO_SORTS) {
      assertEquals(ids(await store.find("m", {}, { sort })), expected, JSON.stringify(sort));
    }
    // What isn't supported fails, whether or not any document would be read.
    for (const collection of ["m", "empty"]) {
      for (const filter of [{ s: { $regex: "b" } }, { $where: "1" }, { n: { $gt: true } }]) {
        await assertRejects(() => store.find(collection, filter), Error, "Unsupported");
      }
    }
    await store.close();
  });
}

for (const [name, make] of Object.entries(adapters).filter(([name]) => name !== "memory")) {
  test(`${name} answers every filter and page like the reference`, async () => {
    const reference = await seeded(adapters.memory);
    const sqlite = await seeded(make);
    for (const filter of FILTERS) {
      const expected = await reference.store.find("things", filter);
      assertEquals(
        ids(await sqlite.store.find("things", filter)),
        ids(expected),
        JSON.stringify(filter),
      );
      assertEquals(await sqlite.store.find("things", filter), expected, JSON.stringify(filter));
      assertEquals(await sqlite.store.count("things", filter), expected.length);
    }
    for (const options of PAGES) {
      assertEquals(
        ids(await sqlite.store.find("things", {}, options)),
        ids(await reference.store.find("things", {}, options)),
        JSON.stringify(options),
      );
    }
    await sqlite.store.close();
  });
}

/** Indexes on the documents' scalar fields: filters on them must answer as before. */
const INDEXES: IndexSpec[] = [
  { fields: [{ path: "s", type: "string" }, { path: "n", type: "number" }] },
  { fields: [{ path: "b", type: "boolean" }] },
  { fields: [{ path: "at", type: "string" }] },
  { fields: [{ path: "nested.k", type: "number" }] },
];

const INDEXED: Filter[] = [
  ...FILTERS,
  { s: { $gte: "x" } },
  { s: { $gt: "10", $lt: "z" } },
  { n: { $lt: 3 } },
  { n: { $gt: "2" } },
  { s: { $gt: 5 } },
  { b: { $ne: true } },
  { b: { $in: [false] } },
  { at: { $gte: "2026-01-02" } },
  { at: { $lt: "2026-01-02" }, s: "x" },
  { "nested.k": { $gte: 1 } },
  { "nested.k": { $ne: 1 } },
  { s: { $not: { $gt: "x" } } },
  { $nor: [{ s: "x" }, { n: { $gt: 2 } }] },
  { n: { $nin: [] } },
  { s: { $in: ["x", "y", 10] } },
  { s: { $in: ["x", "y", "10"] } },
  { n: { $in: [1, 2, 3.5] } },
  { n: { $nin: [1, 2] } },
  { b: { $in: [true, false] } },
  { "nested.k": { $in: [1, 2] } },
];

/** Sorts on indexed fields, which their indexes serve: missing first, ties in insertion order. */
const INDEXED_PAGES: [Filter, FindOptions][] = [
  ...PAGES.map((options): [Filter, FindOptions] => [{}, options]),
  [{}, { sort: { at: 1 } }],
  [{}, { sort: { at: -1 } }],
  [{}, { sort: { at: -1 }, limit: 2 }],
  [{}, { sort: { b: 1, n: -1 } }],
  [{}, { sort: { "nested.k": -1 } }],
  [{}, { sort: { s: -1, n: 1 }, limit: 3 }],
  [{ s: "x" }, { sort: { n: -1 } }],
  [{ at: { $gte: "2026-01-01" } }, { sort: { at: -1 }, skip: 1 }],
];

for (const [name, make] of Object.entries(adapters).filter(([name]) => name !== "memory")) {
  test(`${name} answers filters on indexed fields like the reference`, async () => {
    const reference = await seeded(adapters.memory);
    const store = await make();
    await store.index?.({ things: INDEXES });
    const { epoch } = await store.open();
    await store.transaction(epoch, (tx) => tx.insert("things", structuredClone(DOCS)));
    for (const filter of INDEXED) {
      const expected = await reference.store.find("things", filter);
      assertEquals(ids(await store.find("things", filter)), ids(expected), JSON.stringify(filter));
      assertEquals(await store.count("things", filter), expected.length, JSON.stringify(filter));
    }
    for (const [filter, options] of INDEXED_PAGES) {
      assertEquals(
        ids(await store.find("things", filter, options)),
        ids(await reference.store.find("things", filter, options)),
        JSON.stringify([filter, options]),
      );
    }
    // Declared again with fewer, the others go; queries still answer.
    await store.index?.({ things: INDEXES.slice(0, 1) });
    assertEquals(ids(await store.find("things", { b: true })), ["a", "e"]);
    await store.close();
  });
}

const PIPELINES: Pipeline[] = [
  [{ $group: { _id: null, docs: { $count: {} }, n: { $sum: "$n" }, per: { $sum: 2 } } }],
  [{ $group: { _id: "$s", n: { $sum: "$n" }, avg: { $avg: "$n" }, docs: { $count: {} } } }],
  [{ $group: { _id: "$b", low: { $min: "$s" }, high: { $max: "$s" } } }],
  [{ $group: { _id: "$nested.k", low: { $min: "$n" }, high: { $max: "$n" } } }],
  [{ $group: { _id: { s: "$s", b: "$b" }, docs: { $count: {} } } }],
  [{ $group: { _id: { $substr: ["$at", 0, 7] }, n: { $sum: "$n" } } }],
  // Mixed types: $min takes a number, $max a string, as MongoDB orders them.
  [{ $group: { _id: null, low: { $min: "$v" }, high: { $max: "$v" } } }],
  [
    { $match: { n: { $gte: 2 } } },
    { $group: { _id: "$s", n: { $sum: "$n" } } },
    { $sort: { n: -1 } },
    { $limit: 2 },
  ],
  [{ $match: { s: "nobody" } }, { $group: { _id: null, docs: { $count: {} } } }],
  [{ $match: { n: { $exists: true } } }, { $sort: { n: -1 } }, { $skip: 1 }, { $limit: 2 }],
  [{ $group: { _id: "$g", v: { $sum: "$v" }, avg: { $avg: "$v" } } }, { $sort: { _id: -1 } }],
];

/** More documents, of every type, for grouping: deterministic. */
function grouping(): Doc[] {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
  return Array.from({ length: 300 }, (_, i) => {
    const doc: Doc = { _id: `g${i}`, at: `2026-0${1 + (i % 3)}-1${i % 9}` };
    const g = pick(["a", "b", "c", 1, 2, null, undefined]);
    if (g !== undefined) doc.g = g;
    const v = pick([1, 2, 3, 0.5, -4, "7", "x", null, undefined]);
    if (v !== undefined) doc.v = v;
    return doc;
  });
}

for (const [name, make] of Object.entries(adapters).filter(([name]) => name !== "memory")) {
  test(`${name} answers every aggregate like the reference`, async () => {
    const reference = await seeded(adapters.memory);
    const store = await seeded(make);
    for (const { store: s, epoch } of [reference, store]) {
      await s.transaction(epoch, (tx) => tx.insert("things", grouping()));
    }
    for (const pipeline of PIPELINES) {
      const expected = await reference.store.aggregate("things", plan(pipeline));
      assertEquals(
        await store.store.aggregate("things", plan(pipeline)),
        expected,
        JSON.stringify(pipeline),
      );
    }
    await store.store.close();
  });
}

for (const [name, make] of Object.entries(adapters)) {
  test(`${name}: updates follow MongoDB`, async () => {
    const { store, epoch } = await seeded(make);
    const { result } = await store.transaction(epoch, async (tx) => [
      await tx.update("things", { _id: "a" }, { $set: { "nested.k": 9, fresh: true } }),
      await tx.update("things", { _id: "a" }, { $set: { fresh: true } }),
      await tx.update("things", { n: 2 }, { $inc: { n: 1 } }, { many: true }),
      await tx.update("things", { _id: "b" }, {
        $unset: { nil: 1 },
        $push: { tags: { $each: ["x", "y"] } },
      }),
      await tx.update("things", { _id: "b" }, {
        $addToSet: { tags: "x" },
        $pull: { tags: "green" },
      }),
      await tx.update("things", { _id: "z", kind: "new" }, { $set: { n: 7 } }, { upsert: true }),
      await tx.replace("things", { _id: "c" }, { replaced: true }),
      await tx.replace("things", { _id: "c" }, { replaced: true }),
      await tx.replace("things", { _id: "y" }, { made: 1 }, { upsert: true }),
      await tx.delete("things", { b: true }, { many: true }),
    ]);
    // Counts as MongoDB reports them; `changes` lists only documents that actually changed.
    const counts: unknown[] = result.map(({ changes: _, ...rest }) => rest);
    assertEquals(counts, [
      { matched: 1, modified: 1 },
      { matched: 1, modified: 0 },
      { matched: 2, modified: 2 },
      { matched: 1, modified: 1 },
      { matched: 1, modified: 1 },
      { matched: 0, modified: 0, upsertedId: "z" },
      { matched: 1 },
      { matched: 1 },
      { matched: 0, upsertedId: "y" },
      { deleted: 2 },
    ]);
    const changed = result.map(({ changes }) =>
      changes.map((c) => `${c._id}:${c.before ? "before" : "-"}/${c.after ? "after" : "-"}`)
    );
    assertEquals(changed, [
      ["a:before/after"],
      [],
      ["b:before/after", "e:before/after"],
      ["b:before/after"],
      ["b:before/after"],
      ["z:-/after"],
      ["c:before/after"],
      [],
      ["y:-/after"],
      ["a:before/-", "e:before/-"],
    ]);
    assertEquals(result[0].changes[0].after?.nested, { k: 9 });
    assertEquals(result[0].changes[0].before?.nested, { k: 1 });
    assertEquals(await store.find("things", {}, { sort: { _id: 1 } }), [
      { _id: "b", n: 3, s: "y", b: false, tags: ["x", "y"], nested: { k: 2 }, at: "2026-01-02" },
      { _id: "c", replaced: true },
      { _id: "d", s: "10", list: [1, 2, 3], objs: [{ x: 1 }, { x: 2 }] },
      { _id: "y", made: 1 },
      { _id: "z", kind: "new", n: 7 },
    ]);
    await store.close();
  });

  test(`${name}: array updates match the reference`, async () => {
    const updates: Update[] = [
      { $push: { tags: "z" } },
      { $push: { list: [9, 9] } },
      { $push: { tags: { $each: [1, "w"] } } },
      { $addToSet: { tags: "red" } },
      { $addToSet: { list: 2, s: "q" } },
      { $addToSet: { arr: 3 } },
      { $pull: { tags: "blue" } },
      { $pull: { arr: 3, list: 2, missing: 1 } },
      { $set: { x: 1 }, $push: { tags: "p" }, $pull: { tags: "red" } },
      { $inc: { n: 1 }, $addToSet: { tags: null } },
      { $addToSet: { objs: { x: 1 } } },
    ];
    for (const update of updates) {
      const [{ store, epoch }, reference] = await Promise.all([seeded(make), seeded(memoryStore)]);
      for (const { store: s, epoch: e } of [{ store, epoch }, reference]) {
        await s.transaction(e, (tx) => tx.update("things", {}, update, { many: true }));
      }
      assertEquals(
        await store.find("things", {}, { sort: { _id: 1 } }),
        await reference.store.find("things", {}, { sort: { _id: 1 } }),
        JSON.stringify(update),
      );
      await Promise.all([store.close(), reference.store.close()]);
    }
  });

  test(`${name}: a duplicate insert fails its transaction, whenever it is sent`, async () => {
    // Postgres holds inserts back: alone they are one statement, before an update of
    // another collection they ride in its statement, otherwise they go in with the commit.
    const shapes: [string, (tx: Parameters<Parameters<Store["transaction"]>[1]>[0]) => unknown][] =
      [
        ["alone", (tx) => tx.insert("notes", [{ _id: "n1" }, { _id: "a" }, { _id: "a" }])],
        ["stored", (tx) => tx.insert("things", [{ _id: "new" }, { _id: "b" }])],
        ["before an update", async (tx) => {
          await tx.insert("notes", [{ _id: "n1" }, { _id: "n1" }]);
          await tx.update("things", { _id: "a" }, { $set: { n: 9 } });
        }],
        ["after an update", async (tx) => {
          await tx.update("things", { _id: "a" }, { $set: { n: 9 } });
          await tx.insert("things", [{ _id: "c" }]);
        }],
      ];
    for (const [shape, work] of shapes) {
      const { store, epoch } = await seeded(make);
      const error = await assertRejects(
        () => store.transaction(epoch, async (tx) => void await work(tx)),
        Error,
        undefined,
        shape,
      );
      assertEquals((error as { code?: string }).code, "duplicate_key", shape);
      assertEquals(await store.find("things", { _id: "a" }), [DOCS[0]], shape);
      assertEquals(await store.find("notes", {}), [], shape);
      await store.close();
    }
  });

  test(`${name}: an upsert seeds from the filter's equalities, and never takes another's _id`, async () => {
    const { store, epoch } = await seeded(make);
    // A rule's filter joins the caller's in an `$and`: the new document still takes its _id.
    const { result } = await store.transaction(epoch, async (tx) => [
      await tx.update(
        "things",
        { $and: [{ _id: "u" }, { kind: { $eq: "new" } }, { n: { $gt: 0 } }] },
        { $set: { m: 1 } },
        { upsert: true },
      ),
      await tx.replace(
        "things",
        { $and: [{ _id: "r" }, { s: { $in: ["x", "y"] } }] },
        { made: 1 },
        { upsert: true },
      ),
    ]);
    assertEquals(result.map((r) => r.upsertedId), ["u", "r"]);
    assertEquals(await store.find("things", { _id: { $in: ["r", "u"] } }, { sort: { _id: 1 } }), [
      { _id: "r", made: 1 },
      { _id: "u", kind: "new", m: 1 },
    ]);
    // One the filter didn't match (out of a rule's reach, say) is never written over.
    const out = { $and: [{ _id: "a" }, { s: "elsewhere" }] };
    const shapes: [string, (tx: Parameters<Parameters<Store["transaction"]>[1]>[0]) => unknown][] =
      [
        ["update", (tx) => tx.update("things", out, { $set: { n: 9 } }, { upsert: true })],
        ["replace", (tx) => tx.replace("things", out, { taken: true }, { upsert: true })],
      ];
    for (const [shape, work] of shapes) {
      const error = await assertRejects(
        () => store.transaction(epoch, async (tx) => void await work(tx)),
        Error,
        undefined,
        shape,
      );
      assertEquals((error as { code?: string }).code, "duplicate_key", shape);
    }
    assertEquals(await store.find("things", { _id: "a" }), [DOCS[0]]);
    await store.close();
  });

  test(`${name}: an insert if absent keeps what exists, and reports what went in`, async () => {
    const { store, epoch } = await seeded(make);
    const { result } = await store.transaction(epoch, async (tx) => {
      const first = await tx.insert(
        "things",
        [{ _id: "a", n: 100 }, { _id: "fresh", n: 7 }, { _id: "fresh", n: 8 }],
        { ifAbsent: true },
      );
      // Its own reads see what went in.
      return { first, read: await tx.findOne("things", { _id: "fresh" }) };
    });
    assertEquals(result.first.changes.map((c) => [c._id, c.after?.n]), [["fresh", 7]]);
    assertEquals(result.read?.n, 7);
    assertEquals(
      await store.find("things", { _id: { $in: ["a", "fresh"] } }, { sort: { _id: 1 } }),
      [
        DOCS[0],
        { _id: "fresh", n: 7 },
      ],
    );
    // In a command too, where the store has one.
    const run = store.command?.(epoch, {
      steps: [{
        write: {
          op: "insert",
          collection: "things",
          docs: [{ _id: "b", n: 0 }, { _id: "c2" }],
          ifAbsent: true,
        },
        record: true,
      }],
      blobs: [],
    });
    if (run) {
      const { changes, events } = await run;
      assertEquals(changes[0].map((c) => c._id), ["c2"]);
      assertEquals(events.map((e) => [e.type, e.data._id]), [["things.created", "c2"]]);
      assertEquals((await store.findOne("things", { _id: "b" }))?.n, DOCS[1].n);
    }
    await store.close();
  });

  test(`${name}: a failed transaction leaves nothing behind`, async () => {
    const { store, epoch } = await seeded(make);
    const error = await assertRejects(() =>
      store.transaction(epoch, async (tx) => {
        await tx.update("things", { _id: "a" }, { $set: { n: 100 } });
        tx.emit({ type: "never", data: {} });
        await tx.insert("things", [{ _id: "b" }]);
      })
    );
    assertEquals((error as { code?: string }).code, "duplicate_key");
    assertEquals((await store.findOne("things", { _id: "a" }))?.n, 1);
    assertEquals(await store.events(0), []);
    await store.close();
  });

  test(`${name}: events commit once, in order`, async () => {
    const store = await make();
    const { epoch } = await store.open();
    const first = await store.transaction(epoch, (tx) => {
      tx.emit({ id: "e1", type: "a", data: { x: 1 } });
      tx.emit({ type: "b", data: {}, cause: "e1" });
      return Promise.resolve();
    });
    // Retrying a committed id is a no-op.
    const retry = await store.transaction(epoch, (tx) => {
      tx.emit({ id: "e1", type: "a", data: { x: 1 } });
      return Promise.resolve();
    });
    assertEquals(first.events.map((e) => [e.seq, e.id, e.type]), [[1, "e1", "a"], [
      2,
      first.events[1].id,
      "b",
    ]]);
    assertEquals(first.events[1].cause, "e1");
    assertEquals(retry.events, []);
    assertEquals((await store.events(1)).map((e) => e.type), ["b"]);
    await store.close();
  });

  test(`${name}: event data round-trips exactly, whatever the text`, async () => {
    const store = await make();
    const { epoch } = await store.open();
    const text = `it's "quoted" \\ back$q$slash $$ $tag$ é 😀 \n end`;
    const data = { text, nested: { list: [text, 1, null, true] } };
    // A transaction that writes, so its events go in the transaction's final statement.
    const { events } = await store.transaction(epoch, async (tx) => {
      await tx.insert("things", [{ _id: "q", text }]);
      tx.emit({ id: `e-${text}`, type: "quoted", data, cause: text });
    });
    assertEquals(events.map((e) => [e.id, e.data, e.cause]), [[`e-${text}`, data, text]]);
    const [stored] = await store.events(0);
    assertEquals([stored.id, stored.data, stored.cause], [`e-${text}`, data, text]);
    assertEquals((await store.findOne("things", { _id: "q" }))?.text, text);
    await store.close();
  });

  test(`${name}: edges`, async () => {
    const store = await make();
    const { epoch } = await store.open();
    await store.transaction(epoch, async (tx) => {
      await tx.link({ from: "a", type: "knows", to: "b", data: { since: 1 } });
      await tx.link({ from: "a", type: "knows", to: "c" });
      await tx.link({ from: "b", type: "owns", to: "c" });
      await tx.unlink({ from: "a", type: "knows", to: "c" });
    });
    assertEquals(await store.edges({ from: "a" }), [{
      from: "a",
      type: "knows",
      to: "b",
      data: { since: 1 },
    }]);
    assertEquals((await store.edges({ to: "c" })).map((e) => e.from), ["b"]);
    assertEquals((await store.edges({ type: "knows" })).length, 1);
    await store.close();
  });

  test(`${name}: processor positions are saved with commits, never by a fenced owner`, async () => {
    const store = await make();
    const older = await store.open();
    await store.transaction(older.epoch, async (tx) => {
      await tx.insert("things", [{ _id: "p" }]);
    }, { positions: { a: 3 } });
    // A commit with nothing else to write still saves them.
    await store.transaction(older.epoch, () => Promise.resolve(), { positions: { a: 4, b: 1 } });
    assertEquals(await store.positions(), { a: 4, b: 1 });
    await store.open();
    await assertRejects(() =>
      store.transaction(older.epoch, () => Promise.resolve(), { positions: { a: 9 } })
    );
    assertEquals(await store.positions(), { a: 4, b: 1 });
    await store.close();
  });

  test(`${name}: a newer owner fences the older one`, async () => {
    const store = await make();
    const older = await store.open();
    const newer = await store.open();
    const error = await assertRejects(() =>
      store.transaction(older.epoch, () => Promise.resolve())
    );
    assertEquals((error as { code?: string }).code, "fenced");
    await store.transaction(newer.epoch, () => Promise.resolve());
    await store.close();
  });
}

/** Two stores on the same database, as two processes would open it. */
const shared: Record<string, () => () => Store | Promise<Store>> = {
  sqlite: () => {
    const path = temp();
    return () => sqliteStore({ path });
  },
  ...(POSTGRES
    ? {
      postgres: () => {
        const name = schema();
        return () => postgresStore({ url: POSTGRES, schema: name });
      },
    }
    : {}),
};

for (const [name, database] of Object.entries(shared)) {
  test(`${name}: another process's owner fences this one, and data survives a restart`, async () => {
    const open = database();
    const first = await open();
    const { epoch } = await first.open();
    await first.transaction(epoch, async (tx) => {
      await tx.insert("things", [{ _id: "kept", n: 1 }]);
      tx.emit({ type: "kept", data: {} });
    });
    const second = await open();
    const taken = await second.open();
    const error = await assertRejects(() => first.transaction(epoch, () => Promise.resolve()));
    assertEquals((error as { code?: string }).code, "fenced");
    assertEquals(taken.epoch, epoch + 1);
    assertEquals(await second.find("things"), [{ _id: "kept", n: 1 }]);
    assertEquals((await second.events(0)).map((e) => e.type), ["kept"]);
    await first.close();
    await second.close();
  });
}

test("sqlite: each collection reads as a SQL view", async () => {
  const path = temp();
  const store = await sqliteStore({ path });
  const { epoch } = await store.open();
  store.describe({
    message: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } } },
  });
  await store.transaction(epoch, (tx) => tx.insert("message", [{ _id: "m1", text: "hi", n: 2 }]));
  const { DatabaseSync } = await import("node:sqlite");
  const client = new DatabaseSync(path, { readOnly: true });
  assertEquals(client.prepare("SELECT * FROM message").all().map((row) => ({ ...row })), [
    { _id: "m1", text: "hi", n: 2 },
  ]);
  client.close();
  await store.close();
});

test("pglite: each collection reads as a SQL view", async () => {
  const store = await postgresStore({ url: ":memory:", schema: "views" });
  const { epoch } = await store.open();
  await store.describe({
    message: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } } },
  });
  await store.transaction(epoch, (tx) => tx.insert("message", [{ _id: "m1", text: "hi", n: 2 }]));
  assertEquals(await store.inspect(`SELECT * FROM views.message`), [{
    _id: "m1",
    text: "hi",
    n: "2",
  }]);
  await store.close();
});
