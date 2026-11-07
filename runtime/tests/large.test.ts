/**
 * Large values, and no answer carrying one whole when it needn't: a read
 * leaves out what it doesn't need (a projection: no blob is loaded for a
 * field left out), trusted host code reads a value's bytes in parts from the
 * owner itself (`runtime.bytes`), as someone reaches it, and the answers that
 * are large all the same (a query's, an Action's, what a browser is pushed)
 * cross Oxian in parts of at most 1 MiB, its bound on one chunk.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  type Blobs,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Runtime,
  type Store,
  type ViewContext,
} from "../mod.ts";
import { connect } from "../client.ts";
import { CHUNK } from "../wire.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { fileBlobs } from "../../stores/blobs/files/mod.ts";
import { tempDir, tempFile, test, testWho, ticketFor } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const encoder = new TextEncoder();
const code = (error: unknown) => (error as { code?: string }).code;

/** Blobs in memory that count what's read of them. */
function counting(): Blobs & { gets: number } {
  const kept = new Map<string, { data: Uint8Array; type?: string }>();
  const blobs = {
    gets: 0,
    put: ({ id, data, type }: { id: string; data: Uint8Array; type?: string }) => {
      kept.set(id, { data, type });
      return Promise.resolve();
    },
    get: (id: string) => {
      blobs.gets++;
      return Promise.resolve(kept.get(id) ?? null);
    },
  };
  return blobs;
}

/** Where the runtime keeps things: each store, its blobs in it; and blobs of their own. */
type Place = { store: Store; blobs?: Blobs };
const places: Record<string, () => Place | Promise<Place>> = {
  memory: () => ({ store: memoryStore() }),
  sqlite: async () => ({ store: await sqliteStore({ path: tempFile(".sqlite") }) }),
  pglite: async () => ({ store: await postgresStore({ url: ":memory:" }) }),
  "files as blobs": () => ({ store: memoryStore(), blobs: fileBlobs({ dir: tempDir() }) }),
};

/** A value over 3 MiB, some of it two bytes a character: a blob, read in many parts. */
const LARGE = Array.from({ length: 160_000 }, (_, i) => `part ${i}: café, `).join("");

/** Documents each person reaches only their own of, with a private field. */
const docs = definePlugin({
  name: "docs",
  collections: {
    doc: defineCollection({
      schema: { type: "object" },
      private: ["secret"],
      queries: {
        // As the system: a read with the projection it's given.
        pick: (docs, params: { id?: string; projection: Record<string, 0 | 1> }) =>
          params.id
            ? docs.findOne({ _id: params.id }, { projection: params.projection })
            : docs.find({}, { projection: params.projection, sort: { _id: 1 } }),
        // What a browser reads: a document's text.
        text: {
          allow: (actor) => actor.kind === "person",
          run: (docs, params: { id: string }) => docs.findOne({ _id: params.id }),
        },
      },
    }),
  },
  actions: {
    "doc.put": defineAction({
      input: { type: "object" },
      run: async (ctx, doc: Record<string, unknown>) => {
        await ctx.db.collection("doc").replaceOne({ _id: doc._id }, doc, { upsert: true });
      },
    }),
    // Answers as large a value as it's asked for.
    "doc.echo": defineAction({
      input: { type: "object" },
      run: (_ctx, input: { size: number }) => "y".repeat(input.size),
    }),
  },
  guard: (actor, { collection }) => collection === "doc" ? { owner: actor.id } : undefined,
});

/** The browser's View of a document's text. */
const front = definePlugin({
  name: "docs-front",
  requires: ["docs"],
  views: {
    text: ({ id }: { id: string }, ctx: ViewContext) =>
      ctx.db.collection("doc").query<{ text?: string } | null>("text", { id }).value?.text,
  },
});

async function setup(
  place: () => Place | Promise<Place>,
  fn: (rt: Runtime) => Promise<void>,
) {
  const { store, blobs } = await place();
  const rt = await createRuntime({ store, ...(blobs ? { blobs } : {}), plugins: [docs] });
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

const doc = {
  _id: "d1",
  owner: "ana",
  name: "a",
  meta: { kind: "k", note: "n" },
  data: LARGE,
  secret: "s",
};

for (const [name, place] of Object.entries(places)) {
  test(`${name}: a projection keeps or leaves out fields, as MongoDB's`, async () => {
    await setup(place, async (rt) => {
      await rt.call("doc.put", doc);
      await rt.call("doc.put", { _id: "d2", owner: "bob", name: "b", data: "small" });
      const pick = (projection: Record<string, 0 | 1>, id: string | null = "d1") =>
        rt.query("doc.pick", { ...(id ? { id } : {}), projection });
      assertEquals(await pick({ name: 1 }), { _id: "d1", name: "a" });
      assertEquals(await pick({ name: 1, _id: 0 }), { name: "a" });
      assertEquals(await pick({ "meta.kind": 1 }), { _id: "d1", meta: { kind: "k" } });
      const rest = { _id: "d1", owner: "ana", name: "a", meta: { kind: "k", note: "n" } };
      assertEquals(await pick({ data: 0 }), { ...rest, secret: "s" });
      assertEquals(await pick({ "meta.note": 0, data: 0, secret: 0 }), {
        ...rest,
        meta: { kind: "k" },
      });
      assertEquals(await pick({ name: 1, missing: 1 }), { _id: "d1", name: "a" });
      // A path ends at a large value as at a string: nothing of its reference shows.
      assertEquals(await pick({ "data.size": 1 }), { _id: "d1" });
      // Many documents alike.
      assertEquals(await pick({ name: 1, _id: 0 }, null), [{ name: "a" }, { name: "b" }]);
      // Read whole again: the projections changed nothing of it.
      assertEquals(await pick({ secret: 0 }), { ...rest, data: LARGE });
      assertEquals(await pick({}), doc);
      const refused: Record<string, number>[] = [
        { name: 1, data: 0 },
        { meta: 1, "meta.kind": 1 },
        { $where: 1 },
        { name: 2 },
      ];
      for (const bad of refused) {
        const error = await assertRejects(() => pick(bad as Record<string, 0 | 1>));
        assertEquals(code(error), "invalid", JSON.stringify(bad));
      }
    });
  });

  test(`${name}: runtime.bytes reads a value's bytes in parts, as someone reaches it`, async () => {
    await setup(place, async (rt) => {
      await rt.call("doc.put", { ...doc, meta: { kind: "k", text: "héllo" }, count: 3 });
      await rt.call("doc.put", { _id: "d2", owner: "bob", data: "small" });
      const whole = encoder.encode(LARGE);
      const large = (await rt.bytes("doc", { _id: "d1" }, "data", { actor: ana }))!;
      assertEquals(large.size, whole.length);
      // In parts, any size, wherever they start: each exactly that part of it.
      for (
        const [start, end] of [[0, 1], [0, 3], [CHUNK - 1, CHUNK + 5], [
          whole.length - 7,
          whole.length,
        ]]
      ) {
        assertEquals(await large.read(start, end), whole.slice(start, end), `${start}-${end}`);
      }
      const read = new Uint8Array(large.size);
      for (let at = 0; at < large.size; at += 200_000) {
        read.set(await large.read(at, at + 200_000), at);
      }
      assertEquals(new TextDecoder().decode(read), LARGE);
      // A value small enough to be in the document; a dotted path; as the system.
      const small = (await rt.bytes("doc", { _id: "d2" }, "data"))!;
      assertEquals(await small.read(0, small.size), encoder.encode("small"));
      const nested = (await rt.bytes("doc", { _id: "d1" }, "meta.text", { actor: ana }))!;
      assertEquals([nested.size, await nested.read(0, 6)], [6, encoder.encode("héllo")]);
      // What they can't reach, a private field, no such document, a value that isn't text: none.
      assertEquals(await rt.bytes("doc", { _id: "d1" }, "data", { actor: bob }), null);
      assertEquals(await rt.bytes("doc", { _id: "d1" }, "secret", { actor: ana }), null);
      assert(await rt.bytes("doc", { _id: "d1" }, "secret"));
      assertEquals(await rt.bytes("doc", { _id: "nope" }, "data"), null);
      assertEquals(await rt.bytes("doc", { _id: "d1" }, "count"), null);
      assertEquals(await rt.bytes("doc", { _id: "d1" }, "meta"), null);
      const unknown = await assertRejects(() => rt.bytes("nope", {}, "data"));
      assertEquals(code(unknown), "invalid");
      const operator = await assertRejects(() => rt.bytes("doc", {}, "$where"));
      assertEquals(code(operator), "invalid");
    });
  });
}

test("a field a projection leaves out loads no blob; runtime.bytes loads one once", async () => {
  const blobs = counting();
  await setup(() => ({ store: memoryStore(), blobs }), async (rt) => {
    await rt.call("doc.put", doc);
    const before = blobs.gets;
    assertEquals(await rt.query("doc.pick", { id: "d1", projection: { data: 0 } }), {
      _id: "d1",
      owner: "ana",
      name: "a",
      meta: { kind: "k", note: "n" },
      secret: "s",
    });
    assertEquals(blobs.gets, before);
    assertEquals(
      (await rt.query<{ data: string }>("doc.pick", { id: "d1", projection: {} })).data,
      LARGE,
    );
    assertEquals(blobs.gets, before + 1);
    // Its size from the reference; the blob loaded at the first part read, and only then.
    const large = (await rt.bytes("doc", { _id: "d1" }, "data"))!;
    assertEquals(blobs.gets, before + 1);
    for (let at = 0; at < large.size; at += CHUNK) await large.read(at, at + CHUNK);
    assertEquals(blobs.gets, before + 2);
  });
});

test("answers past 1 MiB cross whole, in parts: a query's, an Action's, what a browser is pushed", async () => {
  const topic = `large-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [docs, testWho],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const client = connect({
    transport: { type: "in-process", config: { topic } },
    ticket: () => ticketFor(rt, ana),
    plugins: [front],
  });
  try {
    await rt.call("doc.put", doc);
    assertEquals(
      (await rt.query<{ data: string }>("doc.pick", { id: "d1", projection: {} })).data,
      LARGE,
    );
    assertEquals(await rt.call("doc.echo", { size: 3 * CHUNK + 1 }), "y".repeat(3 * CHUNK + 1));
    // A browser watching a document's text: the text grows past a chunk, and is pushed whole.
    await rt.call("doc.put", { _id: "t1", owner: "ana", text: "short" });
    await client.ready;
    const view = client.observe<string>("text", { id: "t1" });
    assertEquals(await view.ready, { status: "ready", value: "short" });
    await rt.call("doc.put", { _id: "t1", owner: "ana", text: LARGE });
    const value = () => (view.get() as { value?: string }).value;
    for (let i = 0; i < 300 && value() !== LARGE; i++) await new Promise((r) => setTimeout(r, 10));
    assertEquals(value()?.length, LARGE.length);
    view.close();
  } finally {
    await client.close();
    await rt.close();
  }
});
