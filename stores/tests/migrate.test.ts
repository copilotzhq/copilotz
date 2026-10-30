/**
 * A schema in the layout before tenants (one tenant per schema, no `tenant`
 * column: what local databases have) migrates in place when a store opens
 * it: its rows become the tenant "", nothing is renumbered, and the tables
 * end up exactly as a fresh schema's.
 */
import { assertEquals } from "@std/assert";
import { type PostgresPool, postgresPool, postgresStore } from "../sql/postgres/mod.ts";
import { env, test } from "../../testing/mod.ts";
import { schemaName } from "./pooled.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const databases: Record<string, string> = {
  pglite: ":memory:",
  ...(POSTGRES ? { postgres: POSTGRES } : {}),
};

/**
 * The old layout, as the store made it, with rows in it. `older` is the one
 * before that: events without their actor, vectors keyed by id alone.
 */
const old = (s: string, older = false) => [
  `CREATE SCHEMA ${s}`,
  `CREATE TABLE ${s}.meta (key text PRIMARY KEY, value bigint NOT NULL)`,
  `INSERT INTO ${s}.meta (key, value) VALUES ('epoch', 3), ('position:p', 2)`,
  `CREATE TABLE ${s}.events (seq bigserial PRIMARY KEY, id text NOT NULL UNIQUE, type text ` +
  `NOT NULL, data jsonb NOT NULL, cause text, at text NOT NULL${older ? "" : ", actor jsonb"})`,
  `CREATE INDEX events_cause ON ${s}.events (cause)`,
  // Numbers with a gap, as a sequence leaves them: kept as they are.
  `INSERT INTO ${s}.events (seq, id, type, data, cause, at) VALUES (1, 'e1', 'made', '{}', ` +
  `NULL, '2026-01-01'), (2, 'e2', 'made', '{"k": 1}', 'e1', '2026-01-01'), (5, 'e5', 'made', ` +
  `'{}', 'e1', '2026-01-02')`,
  `SELECT setval(pg_get_serial_sequence('${s}.events', 'seq'), 5)`,
  `CREATE TABLE ${s}.nodes (collection text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, ` +
  `n bigserial, PRIMARY KEY (collection, id))`,
  `INSERT INTO ${s}.nodes (collection, id, doc) VALUES ('things', 'x', '{"_id": "x", "n": 1}'), ` +
  `('things', 'y', '{"_id": "y", "n": 2}')`,
  `CREATE TABLE ${s}.edges ("from" text NOT NULL, type text NOT NULL, "to" text NOT NULL, data ` +
  `jsonb, PRIMARY KEY ("from", type, "to"))`,
  `CREATE INDEX edges_to ON ${s}.edges ("to", type)`,
  `INSERT INTO ${s}.edges VALUES ('x', 'owns', 'y', '{"since": 1}')`,
  `CREATE TABLE ${s}.blobs (id text PRIMARY KEY, data bytea NOT NULL, type text)`,
  `INSERT INTO ${s}.blobs VALUES ('sha256-b', '\\x010203', 'image/png')`,
  ...(older ? [`CREATE TABLE ${s}.vectors (id text PRIMARY KEY, embedding jsonb NOT NULL)`] : [
    `CREATE TABLE ${s}.vectors (collection text NOT NULL, node text NOT NULL, field text NOT ` +
    `NULL, embedding vector NOT NULL, PRIMARY KEY (collection, node, field))`,
    `INSERT INTO ${s}.vectors VALUES ('things', 'x', 'e', '[1, 0]')`,
  ]),
  // A declared index and a view, as the store made them.
  `CREATE INDEX ix_old ON ${s}.nodes ((CASE WHEN jsonb_typeof(doc #> '{n}') = 'number' THEN ` +
  `(doc #>> '{n}')::numeric END) NULLS FIRST) WHERE collection = 'things'`,
  `CREATE VIEW ${s}.things AS SELECT id AS _id, doc ->> 'n' AS n FROM ${s}.nodes WHERE ` +
  `collection = 'things' ORDER BY n`,
];

/** What a store makes of a schema it opens: the declared indexes and views. */
const declare = async (store: Awaited<ReturnType<typeof postgresStore>>) => {
  await store.index({ things: [{ fields: [{ path: "n", type: "number" }] }] });
  await store.describe({ things: { type: "object", properties: { n: { type: "number" } } } });
};

/** A schema's tables, keys, indexes and views, with its name taken out. */
async function layout(pool: PostgresPool, schema: string) {
  const strip = (text: unknown) =>
    String(text).replaceAll(`"${schema}"`, "S").replaceAll(schema, "S");
  const query = async (sql: string) =>
    (await pool.reads.query(sql, [schema])).rows.map((row) =>
      Object.values(row).map(strip).join(" | ")
    );
  return {
    columns: await query(
      `SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, ` +
        `column_default FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1, 2`,
    ),
    constraints: await query(
      `SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint ` +
        `WHERE connamespace = $1::regnamespace AND contype IN ('p', 'u') ORDER BY 1, 2`,
    ),
    indexes: await query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1, 2`,
    ),
    views: await query(
      `SELECT viewname, definition FROM pg_views WHERE schemaname = $1 ORDER BY 1`,
    ),
    sequences: await query(
      `SELECT sequencename FROM pg_sequences WHERE schemaname = $1 ORDER BY 1`,
    ),
  };
}

for (const [name, url] of Object.entries(databases)) {
  for (const older of [false, true]) {
    test(`${name}: ${older ? "an older" : "the"} layout before tenants migrates on open`, async () => {
      const pool = await postgresPool({ url });
      const schema = schemaName();
      for (const sql of old(schema, older)) await pool.writes.query(sql);

      const store = await postgresStore({ pool, schema });
      const { epoch } = await store.open();
      await declare(store);
      // The same rows, now the tenant "": the epoch, positions and numbers as they were.
      assertEquals(epoch, 4);
      assertEquals(await store.positions(), { p: 2 });
      assertEquals(await store.find("things", { n: { $gte: 1 } }), [
        { _id: "x", n: 1 },
        { _id: "y", n: 2 },
      ]);
      assertEquals((await store.events(0)).map((e) => [e.seq, e.id]), [[1, "e1"], [2, "e2"], [
        5,
        "e5",
      ]]);
      assertEquals((await store.related("e1", ["made"])).map((e) => e.id), ["e1", "e2", "e5"]);
      assertEquals(await store.edges({ to: "y" }), [{
        from: "x",
        type: "owns",
        to: "y",
        data: { since: 1 },
      }]);
      assertEquals(Array.from((await store.blob("sha256-b"))!.data), [1, 2, 3]);
      assertEquals(
        (await store.nearest("things", "e", [1, 0])).map((d) => d._id),
        older ? [] : ["x"],
      );
      // It carries on from there.
      const { events } = await store.transaction(epoch, async (tx) => {
        await tx.insert("things", [{ _id: "z", n: 3 }]);
        tx.emit({ type: "made", data: {} });
      });
      assertEquals(events.map((e) => e.seq), [6]);
      assertEquals((await store.find("things")).map((d) => d._id), ["x", "y", "z"]);
      const inspected = await store.inspect("SELECT _id, n FROM things");
      assertEquals(inspected, [{ _id: "x", n: "1" }, { _id: "y", n: "2" }, { _id: "z", n: "3" }]);

      // Exactly a fresh schema's tables, keys, indexes and views.
      const fresh = schemaName();
      const made = await postgresStore({ pool, schema: fresh });
      await made.open();
      await declare(made);
      assertEquals(await layout(pool, schema), await layout(pool, fresh));

      // Another tenant of it sees none of the migrated rows.
      const other = await postgresStore({ pool, schema, tenant: "other" });
      assertEquals(await other.find("things"), []);
      assertEquals(await other.events(0), []);
      await store.drop();
      await made.drop();
      await other.close();
      await pool.close();
    });
  }
}

if (POSTGRES) {
  test("postgres: processes opening an old schema at once migrate it once", async () => {
    const schema = schemaName();
    const setup = await postgresPool({ url: POSTGRES, writes: 1, reads: 1 });
    for (const sql of old(schema)) await setup.writes.query(sql);
    const pools = await Promise.all([1, 2, 3].map(() => postgresPool({ url: POSTGRES! })));
    const stores = await Promise.all(pools.map((pool) => postgresStore({ pool, schema })));
    for (const store of stores) {
      assertEquals((await store.events(0)).map((e) => e.seq), [1, 2, 5]);
    }
    const { epoch } = await stores[2].open();
    assertEquals(epoch, 4);
    await stores[0].drop();
    for (const pool of [...pools, setup]) await pool.close();
  });
}
