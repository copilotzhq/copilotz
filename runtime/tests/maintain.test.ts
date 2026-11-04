/**
 * Maintenance through the owner (`runtime.maintenance`): a SQL write runs
 * in line with the owner's writes, fenced, with its `maintenance.sql` audit
 * event in the same commit; then the owner forgets what it derived from
 * documents, so its next read, an observed View and Processors all see what
 * SQL left. An id makes a write safe to send again. Reads are SQL's, read
 * only; blobs come back by id.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  type Runtime,
  type Store,
  type ViewContext,
} from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresPool, postgresStore } from "../../stores/sql/postgres/mod.ts";
import { env, tempFile, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const operator: Actor = { kind: "maintenance", id: "maintenance", by: "ana" };

/** Stores on one database: each call opens another on it (the newest fences the rest). */
type Database = { dialect: "postgres" | "sqlite"; open(): Promise<Store>; done(): Promise<void> };
const databases: Record<string, () => Database> = {
  sqlite: () => {
    const path = tempFile(".sqlite");
    return { dialect: "sqlite", open: () => sqliteStore({ path }), done: () => Promise.resolve() };
  },
  pglite: () => {
    const pool = postgresPool({ url: ":memory:" });
    const schema = `m_${crypto.randomUUID().slice(0, 8)}`;
    return {
      dialect: "postgres",
      open: async () => postgresStore({ pool: await pool, schema }),
      done: async () => (await pool).close(),
    };
  },
  ...(POSTGRES
    ? {
      postgres: (): Database => {
        const schema = `m_${crypto.randomUUID().slice(0, 8)}`;
        return {
          dialect: "postgres",
          open: () => postgresStore({ url: POSTGRES, schema }),
          done: async () => await (await postgresStore({ url: POSTGRES, schema })).drop(),
        };
      },
    }
    : {}),
};

const heard: Event[] = [];
const text = { type: "string" } as const;
const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text, n: { type: "number" } }, required: ["text"] },
      queries: { one: (notes, { id }: { id: string }) => notes.findOne({ _id: id }) },
    }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { id: text, text, n: { type: "number" } } },
      run: (ctx, input) =>
        ctx.db.collection("note").insertOne({ _id: input.id, text: input.text!, n: input.n ?? 0 }),
    }),
  },
  processors: {
    "notes.heard": { on: "maintenance.sql", run: (_, event) => void heard.push(event) },
  },
  views: {
    note: {
      test: (id: string, ctx: ViewContext) =>
        ctx.db.collection<{ text: string }>("note").findOne({ _id: id }).value?.text,
    },
  },
});

/** A note's text set by SQL, and its `n` counted up: each dialect's JSON. */
const sql = (dialect: string) =>
  dialect === "postgres"
    ? {
      text: "UPDATE nodes SET doc = jsonb_set(doc, '{text}', to_jsonb($1::text)) WHERE " +
        "collection = 'note' AND id = $2",
      up: "UPDATE nodes SET doc = jsonb_set(doc, '{n}', to_jsonb((doc->>'n')::int + 1)) WHERE " +
        "collection = 'note' AND id = $1",
      read: "SELECT _id, text FROM note WHERE _id = $1",
    }
    : {
      text: "UPDATE nodes SET doc = json_set(doc, '$.text', ?1) WHERE collection = 'note' AND " +
        "id = ?2",
      up: "UPDATE nodes SET doc = json_set(doc, '$.n', json_extract(doc, '$.n') + 1) WHERE " +
        "collection = 'note' AND id = ?1",
      read: "SELECT _id, text FROM note WHERE _id = ?1",
    };

const one = (runtime: Runtime, id: string) =>
  runtime.query<{ text: string; n: number } | null>("note.one", { id });

for (const [name, make] of Object.entries(databases)) {
  test(`${name}: a SQL write commits with its audit event, and the owner reads what it left`, async () => {
    heard.length = 0;
    const database = make();
    const runtime = await createRuntime({ store: await database.open(), plugins: [notes] });
    const q = sql(database.dialect);
    try {
      assert(runtime.maintenance.sql);
      await runtime.call("note.add", { id: "n1", text: "typo", n: 1 });
      // Read through the owner: now it's cached.
      assertEquals((await one(runtime, "n1"))?.text, "typo");
      const view = runtime.observe<string>("test", "note", "n1");
      await view.ready;

      const done = await runtime.maintenance.write(q.text, {
        actor: operator,
        params: ["fixed", "n1"],
      });
      assertEquals([done.changed, done.rows, done.truncated], [1, [], false]);
      assertEquals(done.event.type, "maintenance.sql");
      assertEquals(done.event.actor, operator);
      assertEquals(done.event.data, {
        sql: q.text,
        params: ["fixed", "n1"],
        changed: 1,
        ms: done.event.data.ms,
      });

      // The owner's cache forgot it; observed Views and Processors follow.
      assertEquals((await one(runtime, "n1"))?.text, "fixed");
      await runtime.idle();
      const shows = view.get();
      assertEquals(shows.status === "ready" && shows.value, "fixed");
      view.close();
      assertEquals(heard.map((e) => e.id), [done.event.id]);
      // And SQL reads it, read only.
      assertEquals((await runtime.maintenance.read(q.read, { params: ["n1"] })).rows, [
        { _id: "n1", text: "fixed" },
      ]);
      const error = await assertRejects(() =>
        runtime.maintenance.read(q.text, { params: ["read", "n1"] })
      );
      assertEquals((error as { code?: string }).code, "read_only");
    } finally {
      await runtime.close();
      await database.done();
    }
  });

  test(`${name}: a SQL write sent again with its id runs once`, async () => {
    const database = make();
    const runtime = await createRuntime({ store: await database.open(), plugins: [notes] });
    const q = sql(database.dialect);
    try {
      await runtime.call("note.add", { id: "n1", text: "count", n: 1 });
      const first = await runtime.maintenance.write(q.up, {
        actor: operator,
        params: ["n1"],
        id: "fix-1",
      });
      const again = await runtime.maintenance.write(q.up, {
        actor: operator,
        params: ["n1"],
        id: "fix-1",
      });
      assertEquals([again.repeated, again.changed, again.event.id], [true, 1, first.event.id]);
      assertEquals((await one(runtime, "n1"))?.n, 2);
      // The same id for another statement is a mistake, said so.
      const error = await assertRejects(() =>
        runtime.maintenance.write(q.up, { actor: operator, params: ["n2"], id: "fix-1" })
      );
      assertEquals((error as { code?: string }).code, "id_conflict");
    } finally {
      await runtime.close();
      await database.done();
    }
  });

  test(`${name}: a fenced owner can't write SQL`, async () => {
    const database = make();
    const first = await createRuntime({ store: await database.open(), plugins: [notes] });
    const second = await createRuntime({ store: await database.open(), plugins: [notes] });
    // Written by the owner that holds the store now: the first has nothing of its own to save.
    await second.call("note.add", { id: "n1", text: "kept" });
    try {
      const error = await assertRejects(() =>
        first.maintenance.write(sql(database.dialect).text, {
          actor: operator,
          params: ["lost", "n1"],
        })
      );
      assertEquals((error as { code?: string }).code, "fenced");
      assertEquals((await one(second, "n1"))?.text, "kept");
      const audit = await second.maintenance.read(
        "SELECT count(*) AS n FROM events WHERE type = 'maintenance.sql'",
      );
      assertEquals(Number(audit.rows[0].n), 0);
    } finally {
      await first.close();
      await second.close();
      await database.done();
    }
  });
}

test("memory: no SQL, and a blob comes back by id", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [notes] });
  try {
    assertEquals(runtime.maintenance.sql, false);
    for (
      const run of [
        () => runtime.maintenance.read("SELECT 1"),
        () => runtime.maintenance.write("DELETE FROM nodes", { actor: operator }),
      ]
    ) {
      assertEquals(((await assertRejects(run)) as { code?: string }).code, "unsupported");
    }
    // A long text is kept as a blob, by its hash.
    const long = "x".repeat(40_000);
    await runtime.call("note.add", { id: "n1", text: long });
    const id = `sha256-${
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(long)))]
        .map((b) => b.toString(16).padStart(2, "0")).join("")
    }`;
    const blob = await runtime.maintenance.blob(id);
    assertEquals(new TextDecoder().decode(blob!.data), long);
    assertEquals(blob!.type, "text/plain; charset=utf-8");
    assertEquals(await runtime.maintenance.blob(`sha256-${"0".repeat(64)}`), null);
  } finally {
    await runtime.close();
  }
});
