/**
 * Blob references are the owner's own. A forged one in what plugin code
 * writes would make every read of its document fail (an id no blob has),
 * pull another document's blob into it (that blob's hash), or read a file or
 * a bucket's object (a path, a name). So what plugin code writes, and what an
 * Action is called with, may hold no `$blob` key; on read only an exact
 * reference loads a blob; and blob stores take nothing but blob ids.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { writeFile } from "node:fs/promises";
import {
  type Context,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  manualClock,
  type Store,
  TIMERS,
} from "../mod.ts";
import {
  blobId,
  type BlobRef,
  checkBlobId,
  hydrate,
  isBlobRef,
  offload,
  refuseBlobKeys,
} from "../blobs.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { fileBlobs } from "../../stores/blobs/files/mod.ts";
import { httpBlobs } from "../../stores/blobs/http/mod.ts";
import { env, tempDir, tempFile, temporary, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `b_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};
const each = (name: string, fn: (make: () => Store | Promise<Store>) => Promise<void>) => {
  for (const [store, make] of Object.entries(stores)) {
    test(`${store}: ${name}`, () => fn(make));
  }
};

const TEXT = "text/plain; charset=utf-8";
const FORGED = '"$blob" is reserved';
const object = { type: "object" } as const;
const encoder = new TextEncoder();
/** Over 16 KiB: a blob. */
const big = "A victim's private notes. ".repeat(1_000);
const bigRef = async (): Promise<BlobRef> => ({
  $blob: await blobId(encoder.encode(big)),
  size: encoder.encode(big).length,
  type: TEXT,
});
/** A blob id no blob has. */
const NONE = `sha256-${"0".repeat(64)}`;
const code = (error: unknown) => (error as { code?: string }).code;

/** Forged references: to no blob (a), to another document's blob (b), to a file (c), and more. */
const forgeries = async (): Promise<Record<string, unknown>> => ({
  "to no blob": { $blob: NONE, size: 1, type: TEXT },
  "to another document's blob": await bigRef(),
  "to a file": { $blob: "../../../../../../../../../../etc/hosts", size: 1, type: "text/plain" },
  "deep in an array": [{ ok: 1 }, { list: [{ $blob: NONE, size: 1, type: TEXT }] }],
  "loose": { $blob: 1 },
});

/** Every `$blob` value anywhere in `value`. */
const refsIn = (value: unknown): unknown[] =>
  value === null || typeof value !== "object" ? [] : [
    ...(Object.hasOwn(value, "$blob") ? [(value as BlobRef).$blob] : []),
    ...Object.values(value).flatMap(refsIn),
  ];

/** Times an Action ran that must not have. */
let ran = 0;

/** Each way plugin code writes, writing `value` (as an outside caller gave it). */
const ways: Record<string, (ctx: Context, value: unknown) => unknown> = {
  "an inserted document": (ctx, value) => ctx.db.collection("step").insertOne({ input: value }),
  "a replacement": (ctx, value) =>
    ctx.db.collection("step").replaceOne({ _id: "s" }, { input: value }, { upsert: true }),
  "$set": (ctx, value) =>
    ctx.db.collection("step").updateOne({ _id: "s" }, { $set: { input: value } }, {
      upsert: true,
    }),
  "$push": (ctx, value) =>
    ctx.db.collection("step").updateOne({ _id: "s" }, { $push: { inputs: value } }, {
      upsert: true,
    }),
  "an upsert's filter": (ctx, value) =>
    ctx.db.collection("step").updateOne({ _id: "u", input: { $eq: value } }, { $set: { n: 1 } }, {
      upsert: true,
    }),
  "an edge's data": (ctx, value) => ctx.graph.link("a", "holds", "b", { input: value }),
  "an event": (ctx, value) => ctx.emit("vault.said", { input: value }),
  "a transaction's write": (ctx, value) =>
    ctx.transaction(async (tx) => void await tx.db.collection("step").insertOne({ input: value })),
  "a transaction's event": (ctx, value) =>
    ctx.transaction((tx) => Promise.resolve(tx.emit("vault.said", { input: value }))),
  "a held transaction's write": (ctx, value) =>
    ctx.transaction(async (tx) => {
      await tx.db.collection("step").findOne({});
      await tx.db.collection("step").insertOne({ input: value });
    }),
  "an in-memory collection": (ctx, value) => ctx.db.collection("live").insertOne({ input: value }),
  "a record": (ctx, value) => void ctx.record("log", { input: value }),
  "a timer's input": (ctx, value) =>
    ctx.schedule("vault.noop", { input: value }, { at: "2099-01-01T00:00:00.000Z" }),
  "a nested call's input": (ctx, value) => ctx.call("vault.noop", { input: value }),
  "an Action's result": (_ctx, value) => ({ input: value }),
};

const vault = definePlugin({
  name: "vault",
  events: { "vault.said": { schema: object } },
  collections: {
    step: defineCollection({
      schema: object,
      queries: { one: (steps, params) => steps.findOne({ _id: (params as { id: string }).id }) },
    }),
    copy: defineCollection({ schema: object }),
    live: defineCollection({ schema: object, durable: false }),
    log: defineCollection({ schema: object, records: true }),
  },
  actions: {
    // Writes a value it parses (as a model's tool arguments come) one of the ways above.
    "vault.write": defineAction({
      input: {
        type: "object",
        properties: { way: { type: "string" }, json: { type: "string" } },
        required: ["way", "json"],
      },
      run: (ctx, { way, json }) => ways[way](ctx, JSON.parse(json)),
    }),
    "vault.keep": defineAction({
      input: object,
      run: async (ctx, input) => (await ctx.db.collection("step").insertOne({ input })).insertedId,
    }),
    "vault.noop": defineAction({ input: object, run: () => void ran++ }),
    // Changes a document with operators, without touching its large field.
    "vault.touch": defineAction({
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (ctx, { id }) =>
        ctx.db.collection("step").updateOne({ _id: id }, { $set: { n: 1 }, $push: { tags: "t" } }),
    }),
    // Keeps how long a text it was given is: none, when it wasn't given one.
    "vault.size": defineAction({
      input: object,
      run: (ctx, { text, via }) =>
        ctx.db.collection("copy").insertOne({
          via,
          size: typeof text === "string" ? text.length : null,
        }),
    }),
    "vault.nest": defineAction({
      input: object,
      run: (ctx, input) => ctx.call("vault.size", input),
    }),
    "vault.later": defineAction({
      input: object,
      run: (ctx, input) => ctx.schedule("vault.size", input, { at: "2026-11-04T12:01:00.000Z" }),
    }),
    // Reads every step, then deletes them all, as erasing a chat does.
    "vault.erase": defineAction({
      input: object,
      run: async (ctx) => {
        const steps = await ctx.db.collection("step").find({});
        await ctx.db.collection("step").deleteMany({});
        return steps.length;
      },
    }),
  },
  processors: {
    // Gets a changed document whole, and writes its large field again.
    "vault.copy": {
      on: "step.updated",
      run: async (ctx, event) => {
        const doc = event.data.doc as { input: { text: string } };
        await ctx.db.collection("copy").insertOne({ text: doc.input.text });
      },
    },
  },
});

each("each way plugin code writes refuses a forged reference, and stores none", async (make) => {
  const store = await make();
  const runtime = await createRuntime({ store, plugins: [vault] });
  try {
    // A victim's document holds a real blob.
    const victim = await runtime.call<string>("vault.keep", { text: big });
    ran = 0;
    for (const [name, forged] of Object.entries(await forgeries())) {
      for (const way of Object.keys(ways)) {
        const error = await assertRejects(
          () => runtime.call("vault.write", { way, json: JSON.stringify(forged) }),
          Error,
          FORGED,
          `${way}, ${name}`,
        );
        assertEquals(code(error), "invalid", `${way}, ${name}`);
      }
    }
    assertEquals(ran, 0);
    // Plain values go every way.
    for (const way of Object.keys(ways)) {
      await runtime.call("vault.write", { way, json: JSON.stringify("hello") });
    }
    await runtime.idle();
    // The only references stored are the owner's own: the victim's.
    const stored = [
      await store.find("step"),
      await store.find("log"),
      await store.find(TIMERS),
      await store.edges({}),
      (await store.events(0)).map((e) => e.data),
    ];
    assertEquals([...new Set(refsIn(stored))], [(await bigRef()).$blob]);
    // Everything still reads, and erases.
    assert(await runtime.call<number>("vault.erase", {}) >= 2);
    assertEquals((await store.find("step")).find((doc) => doc._id === victim), undefined);
  } finally {
    await runtime.close();
  }
});

each("what an Action is called with, and what's emitted, can't hold a $blob key", async (make) => {
  const store = await make();
  const runtime = await createRuntime({ store, plugins: [vault] });
  try {
    ran = 0;
    for (const forged of Object.values(await forgeries())) {
      const called = await assertRejects(
        () => runtime.call("vault.noop", { x: forged }),
        Error,
        FORGED,
      );
      assertEquals(code(called), "invalid");
      const emitted = await assertRejects(
        () => runtime.emit("vault.said", { x: forged }),
        Error,
        FORGED,
      );
      assertEquals(code(emitted), "invalid");
    }
    // Refused before anything ran or was recorded.
    assertEquals(ran, 0);
    await runtime.idle();
    assertEquals(await store.events(0), []);
  } finally {
    await runtime.close();
  }
});

each("the owner's own references pass through every flow that carries them", async (make) => {
  const store = await make();
  const clock = manualClock("2026-11-04T12:00:00.000Z");
  const runtime = await createRuntime({ store, plugins: [vault], clock });
  try {
    const ref = await bigRef();
    // A document holding a reference, changed by operators: it keeps the reference.
    const id = await runtime.call<string>("vault.keep", { text: big });
    await runtime.call("vault.touch", { id });
    await runtime.idle();
    const [kept] = await store.find("step", { _id: id });
    assertEquals([kept.input, kept.tags], [{ text: ref }, ["t"]]);
    // Its event holds the reference; a Processor gets the document whole and writes it again.
    const updated = (await store.events(0)).find((e) => e.type === "step.updated")!;
    assertEquals((updated.data.doc as { input: unknown }).input, { text: ref });
    assertEquals((await store.find("copy"))[0].text, ref);
    // A nested call's large input, and a timer's: each Action is given it whole.
    await runtime.call("vault.nest", { text: big, via: "nest" });
    await runtime.call("vault.later", { text: big, via: "timer" });
    clock.advance(60_000);
    await runtime.idle();
    const sizes = (await store.find("copy", { via: { $exists: true } })).map(({ _id, ...doc }) =>
      doc
    );
    assertEquals(sizes, [{ via: "nest", size: big.length }, { via: "timer", size: big.length }]);
    // Each call is on record with the same reference.
    const started = (await store.events(0)).filter((e) =>
      e.type === "action.started" && e.data.action === "vault.size"
    );
    assertEquals(started.map((e) => (e.data.input as { text: unknown }).text), [ref, ref]);
    assertEquals(await runtime.call("vault.erase", {}), 1);
  } finally {
    await runtime.close();
  }
});

each(
  "references a store already holds: only an exact one loads; one whose blob is gone fails",
  async (make) => {
    const store = await make();
    const ref = await bigRef();
    const planted: Record<string, unknown> = {
      "more keys": { ...ref, also: 1 },
      "no size": { $blob: ref.$blob, type: TEXT },
      "upper case": { ...ref, $blob: ref.$blob.toUpperCase() },
      "a path": { $blob: "../../../../etc/hosts", size: 1, type: TEXT },
    };
    // As a store may hold them from before writes were checked.
    const { epoch } = await store.open();
    await store.transaction(epoch, async (tx) => {
      await tx.putBlob({ id: ref.$blob, data: encoder.encode(big), type: TEXT });
      await tx.insert("step", [
        { _id: "exact", input: ref },
        { _id: "gone", input: { $blob: NONE, size: 1, type: TEXT } },
        ...Object.entries(planted).map(([_id, input]) => ({ _id, input })),
      ]);
    });
    const runtime = await createRuntime({ store, plugins: [vault] });
    try {
      const read = async (id: string) =>
        (await runtime.query<{ input: unknown }>("step.one", { id })).input;
      assertEquals(await read("exact"), big);
      for (const [id, input] of Object.entries(planted)) assertEquals(await read(id), input, id);
      // An exact reference whose blob is gone still fails: data is missing.
      assertEquals(code(await assertRejects(() => read("gone"))), "missing_blob");
    } finally {
      await runtime.close();
    }
  },
);

test("with blobs as files, no reference reaches a file outside them", async () => {
  const dir = tempDir();
  const secret = `${dir}/secret.txt`;
  await writeFile(secret, "the server's secret");
  // From the blobs' directory down to the root, then to the file.
  const path = `${"../".repeat(24)}${secret.replace(/^\//, "")}`;
  const store = memoryStore();
  const { epoch } = await store.open();
  await store.transaction(epoch, async (tx) => {
    await tx.insert("step", [{ _id: "planted", input: { $blob: path, size: 1, type: TEXT } }]);
  });
  const blobs = fileBlobs({ dir });
  const runtime = await createRuntime({ store, plugins: [vault], blobs });
  try {
    // One already stored is data, as it was written.
    const doc = await runtime.query<{ input: unknown }>("step.one", { id: "planted" });
    assertEquals(doc.input, { $blob: path, size: 1, type: TEXT });
    // A new one is refused.
    const error = await assertRejects(
      () =>
        runtime.call("vault.write", {
          way: "an inserted document",
          json: JSON.stringify({ $blob: path, size: 1, type: TEXT }),
        }),
      Error,
      FORGED,
    );
    assertEquals(code(error), "invalid");
    // The blob store itself takes only blob ids.
    for (const id of [path, "../secret.txt", `sha256-${"0".repeat(63)}/`]) {
      assertEquals(code(await assertRejects(() => blobs.get(id))), "invalid");
      assertEquals(
        code(await assertRejects(() => blobs.put({ id, data: new Uint8Array() }))),
        "invalid",
      );
    }
  } finally {
    await runtime.close();
  }
});

test("blobs over HTTP take only blob ids, and ask nothing for any other", async () => {
  const asked: string[] = [];
  const blobs = httpBlobs({
    url: "https://bucket.example/blobs",
    fetch: (input) => (asked.push(String(input)), Promise.resolve(new Response(null))),
  });
  for (const id of ["../other", "other", `${NONE}?x`, NONE.toUpperCase()]) {
    assertEquals(code(await assertRejects(() => blobs.get(id))), "invalid");
    assertEquals(
      code(await assertRejects(() => blobs.put({ id, data: new Uint8Array() }))),
      "invalid",
    );
  }
  assertEquals(asked, []);
  await blobs.get(NONE);
  assertEquals(asked, [`https://bucket.example/blobs/${NONE}`]);
});

test("isBlobRef: exactly what offload makes, and nothing else", async () => {
  const ref = await bigRef();
  assert(isBlobRef(ref));
  for (
    const not of [
      { ...ref, more: 1 },
      { $blob: ref.$blob, size: ref.size },
      { $blob: ref.$blob, size: "1", type: TEXT },
      { $blob: ref.$blob, size: 1, type: 1 },
      { ...ref, $blob: ref.$blob.toUpperCase() },
      { ...ref, $blob: "sha256-abc" },
      { ...ref, $blob: `${ref.$blob}\n` },
      { ...ref, $blob: "../../etc/hosts" },
      [ref.$blob, ref.size, ref.type],
      ref.$blob,
      null,
    ]
  ) assert(!isBlobRef(not), JSON.stringify(not));
});

test("hydrate loads only exact references: anything else is data, and no blob is asked for", async () => {
  const ref = await bigRef();
  const asked: string[] = [];
  const get = (id: string) => (asked.push(id), Promise.resolve({ data: encoder.encode(big) }));
  const loose = {
    a: { ...ref, more: 1 },
    b: [{ $blob: "../../etc/hosts", size: 1, type: TEXT }],
    c: { $blob: 1 },
  };
  assertEquals(await hydrate(loose, get), loose);
  assertEquals(asked, []);
  assertEquals(await hydrate<unknown>({ ...loose, d: ref }, get), { ...loose, d: big });
  assertEquals(asked, [ref.$blob]);
  const gone = await assertRejects(() => hydrate({ d: ref }, () => Promise.resolve(null)));
  assertEquals(code(gone), "missing_blob");
});

test("offloading plugin code's values refuses a $blob key anywhere, even past a large string", async () => {
  const put = () => Promise.resolve();
  for (
    const value of [
      { $blob: 1 },
      // After a large string, where the walk for one stops early.
      { a: big, b: { $blob: NONE } },
      [big, [{ c: { $blob: "x" } }]],
      { a: { b: big }, c: [{ d: { $blob: "x" } }] },
      { $set: { "a.b": { $blob: NONE, size: 1, type: TEXT } } },
      { $push: { list: { $each: [{ $blob: "x" }] } } },
    ]
  ) {
    const error = await assertRejects(() => offload(value, put, undefined, true), Error, FORGED);
    assertEquals(code(error), "invalid");
    assertThrows(() => refuseBlobKeys(value), Error, FORGED);
  }
  const ref = await bigRef();
  // Plugin code's large values move out as ever.
  assertEquals(await offload<unknown>({ text: big }, put, undefined, true), { text: ref });
  // The owner's own: its references stay as they are, other `$blob` keys are data.
  const mine = await offload<unknown>(
    { kept: ref, text: big, loose: { $blob: 1, note: big } },
    put,
  );
  assertEquals(mine, { kept: ref, text: ref, loose: { $blob: 1, note: ref } });
});

test("checkBlobId takes a blob's id, and refuses anything else", async () => {
  const id = await blobId(encoder.encode("x"));
  assertEquals(checkBlobId(id), id);
  for (const not of ["", "sha256-", id.toUpperCase(), id.slice(0, -1), `${id}0`, `../${id}`, 7]) {
    assertEquals(code(assertThrows(() => checkBlobId(not))), "invalid");
  }
});
