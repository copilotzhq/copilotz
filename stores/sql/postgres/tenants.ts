/**
 * A tenant's rows as a unit: copied to another schema or database, dropped,
 * or exported as a script. The building blocks for moving an org (copy it,
 * serve it from where it went, drop it where it was) and for handing it its
 * data. Rows go unchanged: the same keys, event numbers, epoch and positions,
 * so a store opened on the copy carries on where the original stopped.
 *
 * Stop the tenant's owner first: what it writes after a copy's snapshot
 * isn't in the copy. (Opening a store on the tenant fences it, and so does
 * `dropTenant`.)
 */
import {
  COLUMNS,
  constant,
  ident,
  type Layout,
  prepare,
  type Row,
  type Session,
  type Table,
  TABLES,
} from "./layout.ts";
import { type PostgresPool, postgresPool } from "./pool.ts";

/** Where tenants are: a schema (default "copilotz"), reached by a shared pool or a URL. */
export type Location =
  & ({ pool: PostgresPool; url?: undefined } | { url: string; pool?: undefined })
  & { schema?: string };

/** How many rows of each table. */
export type Counts = Record<Table, number>;

const error = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * A location's pool (one of its own for a URL, unless `near` reaches the same
 * database) and its schema, at the layout.
 */
async function reach(at: Location, near?: { url: string; pool: PostgresPool }) {
  const schema = at.schema ?? "copilotz";
  // The same URL is the same database, but every `:memory:` is a new one.
  const reuse = near && at.url !== undefined && at.url === near.url &&
    /^(postgres|file)/.test(at.url);
  const pool = at.pool ??
    (reuse ? near.pool : await postgresPool({ url: at.url!, writes: 1, reads: 1 }));
  const done = () => (at.pool || reuse ? Promise.resolve() : pool.close());
  try {
    return { pool, schema, layout: await prepare(pool, schema), done };
  } catch (failure) {
    await done();
    throw failure;
  }
}

/** Whether a schema holds any row of the tenant. */
const holds = async (db: Session, schema: string, tenant: string) => {
  const { rows: [row] } = await db.query(
    `SELECT ${
      TABLES.map((table) => `EXISTS (SELECT 1 FROM ${ident(schema)}.${table} WHERE tenant = $1)`)
        .join(" OR ")
    } AS held`,
    [tenant],
  );
  return Boolean(row.held);
};

/** A table's columns as SQL, and with their types where a vector's depends on the database. */
const columns = (table: Table) => COLUMNS[table].columns.map(([name]) => ident(name)).join(", ");
const typed = (type: string, layout: Layout) =>
  type === "embedding" ? (layout.vector ? "vector" : "jsonb") : type;

/**
 * After rows of `n` went in, the schema's sequence must be past them: locked
 * against new nodes meanwhile, it moves forward, never back.
 */
const advancing = (schema: string, tenant: string) => {
  const nodes = `${ident(schema)}.nodes`;
  return [
    `LOCK TABLE ${nodes} IN SHARE ROW EXCLUSIVE MODE`,
    `SELECT setval(q.s, greatest(coalesce((SELECT max(n) FROM ${nodes} WHERE tenant = ` +
    `${constant(tenant)}), 1), coalesce(pg_sequence_last_value(q.s), 1))) FROM (SELECT ` +
    `pg_get_serial_sequence(${constant(nodes)}, 'n')::regclass AS s) q`,
  ];
};

/**
 * A tenant's rows of one table in key order, a batch at a time, each column
 * as text (the form COPY writes): up to `limit` rows, or about `budget` bytes
 * of their largest column, whichever comes first (always at least one row).
 */
async function* batches(
  tx: Session,
  schema: string,
  table: Table,
  tenant: string,
  limit = 1000,
  budget = 16 << 20,
): AsyncGenerator<Row[]> {
  const { columns: all, key } = COLUMNS[table];
  const types = new Map(all);
  const keys = key.map(ident).join(", ");
  const large = {
    meta: "",
    events: "data",
    nodes: "doc",
    edges: "data",
    vectors: "embedding",
    blobs: "data",
  }[table];
  const size = large ? `pg_column_size(${large})` : "0";
  let after: unknown[] | undefined;
  for (;;) {
    const params: unknown[] = [tenant];
    const bound = after
      ? ` AND (${keys}) > (${
        after.map((v, i) => `$${params.push(v)}::${types.get(key[i])}`).join(", ")
      })`
      : "";
    const { rows } = await tx.query(
      `SELECT ${all.map(([name]) => `${ident(name)}::text AS ${ident(name)}`).join(", ")}, ` +
        `json_build_array(${keys}) AS _key FROM (SELECT r.*, sum(${size}) OVER (ORDER BY ${keys}) ` +
        `- ${size} AS _before FROM (SELECT * FROM ${ident(schema)}.${table} WHERE tenant = $1` +
        `${bound} ORDER BY ${keys} LIMIT ${limit}) r) w WHERE _before < ${budget} ORDER BY ${keys}`,
      params,
    );
    if (!rows.length) return;
    yield rows;
    after = rows.at(-1)!._key as unknown[];
  }
}

/** Opens a read-only snapshot on `db`, held until `end`. */
async function snapshot(db: PostgresPool["reads"]) {
  const ready = Promise.withResolvers<Session>();
  const done = Promise.withResolvers<void>();
  const settled = db.transaction(async (tx: Session) => {
    ready.resolve(tx);
    await done.promise;
  }, { isolation: "repeatable read", readOnly: true });
  settled.catch((failure) => ready.reject(failure));
  const tx = await ready.promise;
  return {
    tx,
    end: async () => {
      done.resolve();
      await settled.catch(() => {});
    },
  };
}

/**
 * Copies a tenant's rows from one schema to another, in this database or
 * another, from one consistent snapshot of the source. The copy commits
 * whole, or not at all; a destination already holding the tenant is refused.
 * Within one database the rows never leave it; between two they stream
 * through this process, a batch at a time.
 */
export async function copyTenant(
  options: { from: Location; to: Location; tenant: string },
): Promise<Counts> {
  const { tenant } = options;
  const source = await reach(options.from);
  try {
    const target = await reach(options.to, {
      url: options.from.url ?? source.pool.url,
      pool: source.pool,
    });
    try {
      if (source.pool === target.pool && source.schema === target.schema) {
        throw error("A tenant can't be copied onto itself.", "invalid");
      }
      const counts = Object.fromEntries(TABLES.map((table) => [table, 0])) as Counts;
      const s = ident(source.schema);
      const d = ident(target.schema);
      const check = async (src: Session, dst: Session) => {
        if (!(await holds(src, source.schema, tenant))) {
          throw error(`No tenant "${tenant}" in schema "${source.schema}".`, "not_found");
        }
        if (await holds(dst, target.schema, tenant)) {
          throw error(`Schema "${target.schema}" already holds tenant "${tenant}".`, "exists");
        }
      };
      const advance = async (dst: Session) => {
        if (counts.nodes) {
          for (const sql of advancing(target.schema, tenant)) await dst.query(sql);
        }
      };
      if (source.pool === target.pool) {
        // One database: one transaction reads the source's snapshot and writes the copy,
        // in statements of a few thousand rows.
        await target.pool.writes.transaction(async (tx: Session) => {
          await check(tx, tx);
          for (const table of TABLES) {
            const { columns: all, key } = COLUMNS[table];
            const types = new Map(all);
            const keys = key.map(ident).join(", ");
            const values = all.map(([name, type]) =>
              type === "embedding" && source.layout.vector !== target.layout.vector
                ? `${ident(name)}::text::${typed(type, target.layout)}`
                : ident(name)
            ).join(", ");
            let after: unknown[] | undefined;
            for (;;) {
              const params: unknown[] = [tenant];
              const bound = after
                ? ` AND (${keys}) > (${
                  after.map((v, i) => `$${params.push(v)}::${types.get(key[i])}`).join(", ")
                })`
                : "";
              const { rows: [row] } = await tx.query(
                `WITH rows AS (SELECT * FROM ${s}.${table} WHERE tenant = $1${bound} ORDER BY ` +
                  `${keys} LIMIT 5000), put AS (INSERT INTO ${d}.${table} (${columns(table)}) ` +
                  `SELECT ${values} FROM rows) SELECT count(*)::int AS n, (SELECT ` +
                  `json_build_array(${keys}) FROM rows ORDER BY ${keys} DESC LIMIT 1) AS last ` +
                  `FROM rows`,
                params,
              );
              counts[table] += Number(row.n);
              if (Number(row.n) < 5000) break;
              after = row.last as unknown[];
            }
          }
          await advance(tx);
        }, { isolation: "repeatable read" });
        return counts;
      }
      // Two databases: the source's snapshot streams into one transaction at the destination.
      const read = await snapshot(source.pool.reads);
      try {
        await target.pool.writes.transaction(async (tx: Session) => {
          await check(read.tx, tx);
          for (const table of TABLES) {
            const all = COLUMNS[table].columns;
            for await (const rows of batches(read.tx, source.schema, table, tenant)) {
              await tx.query(
                `INSERT INTO ${d}.${table} (${columns(table)}) SELECT ${
                  all.map(([name, type]) => `r.${ident(name)}::${typed(type, target.layout)}`)
                    .join(", ")
                } FROM json_to_recordset($1::json) AS r(${
                  all.map(([name]) => `${ident(name)} text`).join(", ")
                })`,
                [JSON.stringify(rows)],
              );
              counts[table] += rows.length;
            }
          }
          await advance(tx);
        });
      } finally {
        await read.end();
      }
      return counts;
    } finally {
      await target.done();
    }
  } finally {
    await source.done();
  }
}

/**
 * Deletes a tenant's rows, a batch at a time, so no statement holds many
 * locks or runs long. Its epoch goes first: an owner still running is fenced
 * and writes nothing more. Stopped midway, it can be run again.
 */
export async function dropTenant(
  options: Location & { tenant: string; batch?: number },
): Promise<Counts> {
  const schema = options.schema ?? "copilotz";
  const pool = options.pool ?? await postgresPool({ url: options.url!, writes: 1, reads: 1 });
  try {
    const counts = Object.fromEntries(TABLES.map((table) => [table, 0])) as Counts;
    // Nothing to drop where nothing was made.
    const { rows: [made] } = await pool.writes.query(`SELECT to_regclass($1) IS NOT NULL AS made`, [
      `${ident(schema)}.meta`,
    ]);
    if (!made.made) return counts;
    await prepare(pool, schema);
    const batch = options.batch ?? 5000;
    for (const table of TABLES) {
      const name = `${ident(schema)}.${table}`;
      for (;;) {
        const { rows: [row] } = await pool.writes.query(
          `WITH gone AS (DELETE FROM ${name} WHERE ctid = ANY (ARRAY (SELECT ctid FROM ${name} ` +
            `WHERE tenant = $1 LIMIT $2)) RETURNING 1) SELECT count(*)::int AS n FROM gone`,
          [options.tenant, batch],
        );
        counts[table] += Number(row.n);
        if (Number(row.n) < batch) break;
      }
    }
    return counts;
  } finally {
    if (!options.pool) await pool.close();
  }
}

/** A value as COPY's text format writes it: backslash, tab and line breaks escaped; NULL as \N. */
const copyText = (value: unknown) =>
  value === null || value === undefined ? "\\N" : String(value).replace(
    /[\\\t\n\r]/g,
    (c) => ({ "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" })[c]!,
  );

/**
 * A tenant's rows as a SQL script, streamed, from one consistent snapshot:
 * one COPY per table (the text format, as `COPY … TO STDOUT` writes it),
 * then the node sequence moved past the rows, all in one transaction. psql
 * restores it into a schema a store has opened, which has the tables (by
 * default the same schema; `into` names another); it refuses one that
 * already holds the tenant.
 *
 *   psql -v ON_ERROR_STOP=1 -f tenant.sql
 */
export function exportTenant(
  options: Location & { tenant: string; into?: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = script(options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await lines.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (failure) {
        controller.error(failure);
      }
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
}

async function* script(options: Location & { tenant: string; into?: string }) {
  const at = await reach(options);
  try {
    const read = await snapshot(at.pool.reads);
    try {
      const into = ident(options.into ?? at.schema);
      const T = constant(options.tenant);
      const taken = TABLES.map((table) =>
        `EXISTS (SELECT 1 FROM ${into}.${table} WHERE tenant = ${T})`
      )
        .join(" OR ");
      const check = `BEGIN IF ${taken} THEN RAISE EXCEPTION 'The schema already holds tenant %', ` +
        `${T}; END IF; END`;
      yield `-- Copilotz tenant ${JSON.stringify(options.tenant)}, from schema ` +
        `${JSON.stringify(at.schema)}: its rows in one snapshot, as of ` +
        `${new Date().toISOString()}.\n` +
        `SET client_encoding = 'UTF8';\nBEGIN;\nDO ${constant(check)};\n`;
      for (const table of TABLES) {
        const names = COLUMNS[table].columns.map(([name]) => name);
        yield `COPY ${into}.${table} (${columns(table)}) FROM stdin;\n`;
        for await (const rows of batches(read.tx, at.schema, table, options.tenant)) {
          yield rows.map((row) => names.map((name) => copyText(row[name])).join("\t") + "\n")
            .join("");
        }
        yield "\\.\n";
      }
      yield `${advancing(options.into ?? at.schema, options.tenant).join(";\n")};\nCOMMIT;\n`;
    } finally {
      await read.end();
    }
  } finally {
    await at.done();
  }
}
