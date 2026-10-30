/**
 * The tables of a schema, and getting a schema to them. Every row carries its
 * tenant, and every key and index leads with it: many tenants share a schema,
 * each reaches only its own rows, and one's rows copy out by tenant, unchanged.
 *
 * A pool checks a schema once (one catalog query) and changes it only when it
 * must, in a transaction under a lock: tables are made when missing, and the
 * layout before tenants (one tenant per schema, no `tenant` column) migrates
 * in place: its rows become the tenant "", their keys are rebuilt to lead
 * with it, and nothing is renumbered. Either way the result is the same.
 */
import type { PostgresPool } from "./pool.ts";

export type Row = Record<string, unknown>;
export type Session = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };

export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * A text constant, dollar-quoted with a tag that can't end it early (the text
 * doesn't contain it, nor end with the start of it): nothing needs escaping,
 * whatever the server's settings, and a statement can carry it with no
 * parameters.
 */
export const constant = (value: string) => {
  let tag = "$q$";
  while ((value + tag).indexOf(tag) !== value.length) {
    tag = `$q${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}$`;
  }
  return `${tag}${value}${tag}`;
};

/** The tables, in the order a tenant's rows go: `meta` first, as it holds the fence. */
export const TABLES = ["meta", "events", "nodes", "edges", "vectors", "blobs"] as const;
export type Table = typeof TABLES[number];

/**
 * Each table's columns, in the layout's order (`tenant` last, where a
 * migration adds it), with their types; and its key after `tenant`, the
 * order its rows are read in. `embedding` is a vector type: pgvector's
 * `vector` where the database has it, else `jsonb`.
 */
export const COLUMNS: Record<Table, { columns: [string, string][]; key: string[] }> = {
  meta: { columns: [["key", "text"], ["value", "bigint"], ["tenant", "text"]], key: ["key"] },
  events: {
    columns: [
      ["seq", "bigint"],
      ["id", "text"],
      ["type", "text"],
      ["data", "jsonb"],
      ["cause", "text"],
      ["at", "text"],
      ["actor", "jsonb"],
      ["tenant", "text"],
    ],
    key: ["seq"],
  },
  nodes: {
    columns: [["collection", "text"], ["id", "text"], ["doc", "jsonb"], ["n", "bigint"], [
      "tenant",
      "text",
    ]],
    key: ["collection", "id"],
  },
  edges: {
    columns: [["from", "text"], ["type", "text"], ["to", "text"], ["data", "jsonb"], [
      "tenant",
      "text",
    ]],
    key: ["from", "type", "to"],
  },
  vectors: {
    columns: [
      ["collection", "text"],
      ["node", "text"],
      ["field", "text"],
      ["embedding", "embedding"],
      ["tenant", "text"],
    ],
    key: ["collection", "node", "field"],
  },
  blobs: {
    columns: [["id", "text"], ["data", "bytea"], ["type", "text"], ["tenant", "text"]],
    key: ["id"],
  },
};

/** Each table's definition: its columns before `tenant`, its keys and its indexes. */
const definition = (s: string, embedding: string): Record<
  Table,
  { columns: string; keys: string[]; indexes: string[] }
> => ({
  meta: {
    columns: "key text NOT NULL, value bigint NOT NULL",
    keys: ["meta_pkey PRIMARY KEY (tenant, key)"],
    indexes: [],
  },
  events: {
    columns: "seq bigint NOT NULL, id text NOT NULL, type text NOT NULL, data jsonb NOT NULL, " +
      "cause text, at text NOT NULL, actor jsonb",
    keys: ["events_pkey PRIMARY KEY (tenant, seq)", "events_id_key UNIQUE (tenant, id)"],
    indexes: [`events_cause ON ${s}.events (tenant, cause)`],
  },
  nodes: {
    // `n` keeps insertion order: one sequence for the schema, as only order within a tenant counts.
    columns: "collection text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, n bigserial",
    keys: ["nodes_pkey PRIMARY KEY (tenant, collection, id)"],
    indexes: [],
  },
  edges: {
    columns: '"from" text NOT NULL, type text NOT NULL, "to" text NOT NULL, data jsonb',
    keys: ['edges_pkey PRIMARY KEY (tenant, "from", type, "to")'],
    indexes: [`edges_to ON ${s}.edges (tenant, "to", type)`],
  },
  vectors: {
    columns:
      `collection text NOT NULL, node text NOT NULL, field text NOT NULL, embedding ${embedding} ` +
      "NOT NULL",
    keys: ["vectors_pkey PRIMARY KEY (tenant, collection, node, field)"],
    indexes: [],
  },
  blobs: {
    columns: "id text NOT NULL, data bytea NOT NULL, type text",
    keys: ["blobs_pkey PRIMARY KEY (tenant, id)"],
    indexes: [],
  },
});

/** What a schema holds: each table's columns and their types; and whether pgvector is there. */
type Found = { tables: Record<string, Record<string, string>>; vector: boolean };

const detect = async (db: Session, schema: string): Promise<Found> => {
  const { rows: [row] } = await db.query(
    `SELECT (SELECT coalesce(jsonb_object_agg(c.relname, (SELECT jsonb_object_agg(a.attname, ` +
      `format_type(a.atttypid, a.atttypmod)) FROM pg_attribute a WHERE a.attrelid = c.oid AND ` +
      `a.attnum > 0 AND NOT a.attisdropped)), '{}'::jsonb) FROM pg_class c JOIN pg_namespace s ` +
      `ON s.oid = c.relnamespace WHERE s.nspname = $1 AND c.relkind = 'r' AND c.relname = ` +
      `ANY($2::text[])) AS tables, EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') ` +
      `AS vector`,
    [schema, TABLES],
  );
  return { tables: row.tables as Found["tables"], vector: Boolean(row.vector) };
};

/** Whether the vectors are pgvector's. */
const vectorType = (found: Found) => found.tables.vectors?.embedding?.startsWith("vector") ?? false;

/** Whether a schema already has the layout: nothing to make or migrate. */
const current = (found: Found) =>
  TABLES.every((table) => found.tables[table]?.tenant) &&
  "actor" in found.tables.events && "field" in found.tables.vectors &&
  (!found.vector || vectorType(found));

/** What a pool knows of its schemas in this process: their layout, views and indexes. */
const known = new WeakMap<PostgresPool, Map<string, unknown>>();
export const remembered = (pool: PostgresPool) => {
  let schemas = known.get(pool);
  if (!schemas) known.set(pool, schemas = new Map());
  return schemas;
};

/** Forgets what was known of a schema (it was dropped). */
export const forget = (pool: PostgresPool, schema: string) => {
  const schemas = remembered(pool);
  for (const key of [...schemas.keys()]) if (key.startsWith(`${schema}\u0000`)) schemas.delete(key);
};

export type Layout = {
  /** Whether vectors are pgvector's `vector` (ranked in SQL), else `jsonb` (ranked in JavaScript). */
  vector: boolean;
};

/** Gets a schema to the layout, once per pool: checked, then made or migrated if it must be. */
export function prepare(pool: PostgresPool, schema: string): Promise<Layout> {
  const schemas = remembered(pool);
  const key = `${schema}\u0000layout`;
  let ready = schemas.get(key) as Promise<Layout> | undefined;
  if (!ready) {
    ready = setup(pool, schema);
    schemas.set(key, ready);
    ready.catch(() => schemas.get(key) === ready && schemas.delete(key));
  }
  return ready;
}

async function setup(pool: PostgresPool, schema: string): Promise<Layout> {
  const db = pool.writes;
  const found = await detect(db, schema);
  if (current(found)) return { vector: vectorType(found) };
  // Vectors use pgvector when the database has it (PGlite always does), and jsonb otherwise.
  if (!found.vector) {
    try {
      await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      // Not installed, not allowed, or made concurrently: the check below sees which.
    }
  }
  return await db.transaction(async (tx) => {
    // One process at a time makes or migrates a schema; the others then find it done.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`copilotz:${schema}`]);
    const s = ident(schema);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    const now = await detect(tx, schema);
    if (current(now)) return { vector: vectorType(now) };
    const tables = now.tables;
    const old = TABLES.filter((table) => tables[table] && !tables[table].tenant);
    if (old.length) {
      await tx.query(
        `LOCK TABLE ${old.map((table) => `${s}.${table}`).join(", ")} IN ACCESS ` +
          `EXCLUSIVE MODE`,
      );
    }
    // Vectors were once keyed by id alone, before any were written: start them over.
    if (tables.vectors && !("field" in tables.vectors)) {
      await tx.query(`DROP TABLE ${s}.vectors`);
      delete tables.vectors;
    }
    const embedding = now.vector ? "vector" : "jsonb";
    const tableDefs = definition(s, embedding);
    for (const table of TABLES) {
      const def = tableDefs[table];
      const name = `${s}.${table}`;
      if (!tables[table]) {
        await tx.query(`CREATE TABLE ${name} (${def.columns}, tenant text NOT NULL)`);
      } else if (!tables[table].tenant) {
        // Events record who did them since the actor came in: older logs gain the column first.
        if (table === "events" && !("actor" in tables.events)) {
          await tx.query(`ALTER TABLE ${name} ADD COLUMN actor jsonb`);
        }
        await tx.query(`ALTER TABLE ${name} ADD COLUMN tenant text NOT NULL DEFAULT ''`);
        await tx.query(`ALTER TABLE ${name} ALTER COLUMN tenant DROP DEFAULT`);
        await unkey(tx, schema, table);
        if (table === "events") {
          // The store numbers each tenant's events itself: the schema-wide sequence goes.
          const { rows: [{ seq }] } = await tx.query(
            `SELECT pg_get_serial_sequence($1, 'seq') AS seq`,
            [name],
          );
          if (seq) {
            await tx.query(`ALTER TABLE ${name} ALTER COLUMN seq DROP DEFAULT`);
            await tx.query(`DROP SEQUENCE ${seq}`);
          }
        }
      } else continue;
      await tx.query(
        `ALTER TABLE ${name} ${def.keys.map((key) => `ADD CONSTRAINT ${key}`).join(", ")}`,
      );
      for (const index of def.indexes) await tx.query(`CREATE INDEX ${index}`);
    }
    if (now.vector && tables.vectors?.embedding === "jsonb") {
      await tx.query(
        `ALTER TABLE ${s}.vectors ALTER COLUMN embedding TYPE vector USING embedding::text::vector`,
      );
    }
    return { vector: vectorType(await detect(tx, schema)) };
  });
}

/**
 * Drops an old table's keys and indexes, which don't lead with `tenant`. Its
 * declared indexes (`ix_…`) go too: `index()` makes them again.
 */
async function unkey(tx: Session, schema: string, table: Table) {
  const name = `${ident(schema)}.${table}`;
  const { rows } = await tx.query(
    `SELECT c.conname AS name, 'constraint' AS kind FROM pg_constraint c WHERE c.conrelid = ` +
      `$1::regclass AND c.contype IN ('p', 'u') UNION ALL SELECT i.relname, 'index' FROM ` +
      `pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = $1::regclass AND ` +
      `NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)`,
    [name],
  );
  for (const { name: key, kind } of rows) {
    await tx.query(
      kind === "constraint"
        ? `ALTER TABLE ${name} DROP CONSTRAINT ${ident(String(key))}`
        : `DROP INDEX ${ident(schema)}.${ident(String(key))}`,
    );
  }
}

/**
 * Whether the schema holds a tenant other than this one (two probes of
 * `meta`'s key): a store then shares its schema.
 */
export const others = async (db: Session, schema: string, tenant: string) => {
  const meta = `${ident(schema)}.meta`;
  const t = constant(tenant);
  const { rows: [row] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM ${meta} WHERE tenant < ${t}) OR EXISTS (SELECT 1 FROM ${meta} ` +
      `WHERE tenant > ${t}) AS others`,
  );
  return Boolean(row.others);
};
