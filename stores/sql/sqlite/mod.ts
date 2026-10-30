/**
 * SQLite storage adapter, on the runtime's built-in SQLite: `node:sqlite` on
 * Node and Deno, `bun:sqlite` on Bun, or any database with the same small API
 * (`open`), such as a Durable Object's. The five things persist in five tables: `events`, `nodes`
 * (documents as JSON), `edges`, `vectors` and `blobs`, plus `meta` for the
 * fencing epoch. MongoDB filters and sorts become SQL over the JSON
 * (`../shared/filter.ts` with `dialect.ts`); updates read the matching
 * documents, apply the operators with the reference semantics and write them
 * back, inside the same transaction.
 *
 * The owner writes through one connection and reads committed state through a
 * second one. WAL mode lets any SQLite client read the file while it runs, and
 * each collection is also a SQL view (`SELECT * FROM message`).
 */
type SQLInputValue = null | number | bigint | string | Uint8Array;

/** What the store uses of a SQLite database: `node:sqlite`'s `DatabaseSync` and Bun's `Database` both fit. */
export type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** Whether a transaction is open (`node:sqlite` calls it `isTransaction`, Bun `inTransaction`). */
  readonly isTransaction?: boolean;
  readonly inTransaction?: boolean;
};

export type SqliteStatement = {
  all(...params: SQLInputValue[]): unknown[];
  get(...params: SQLInputValue[]): unknown;
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};

// Not literal, so no checker or bundler tries to resolve the one this runtime lacks.
const BUN_SQLITE = "bun:sqlite";
const NODE_SQLITE = "node:sqlite";

/** The runtime's own SQLite: Bun's, else `node:sqlite` (Node, Deno). */
async function builtin(path: string): Promise<SqliteDatabase> {
  if ("Bun" in globalThis) {
    const { Database } = await import(BUN_SQLITE);
    return new Database(path, { create: true });
  }
  const { DatabaseSync } = await import(NODE_SQLITE);
  return new DatabaseSync(path);
}
import type { JSONSchema } from "../../../runtime/define.ts";
import { applyUpdate, seedOf } from "../../../runtime/mongo.ts";
import {
  type Blob,
  type Change,
  cosine,
  type Doc,
  type Edge,
  type Event,
  fenced,
  type IndexSpec,
  type Reader,
  type Store,
  type Transaction,
} from "../../../runtime/store.ts";
import { type Bind, page, type Scalars, where } from "../shared/filter.ts";
import { scalar, sqlite, sqliteAggregates } from "./dialect.ts";
import { grouped } from "../shared/aggregate.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value ANY) STRICT;
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    cause TEXT,
    at TEXT NOT NULL,
    actor TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS events_cause ON events (cause);
  CREATE TABLE IF NOT EXISTS nodes (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS edges (
    "from" TEXT NOT NULL,
    type TEXT NOT NULL,
    "to" TEXT NOT NULL,
    data TEXT,
    PRIMARY KEY ("from", type, "to")
  ) STRICT;
  CREATE INDEX IF NOT EXISTS edges_to ON edges ("to", type);
  CREATE TABLE IF NOT EXISTS vectors (
    collection TEXT NOT NULL,
    node TEXT NOT NULL,
    field TEXT NOT NULL,
    embedding TEXT NOT NULL,
    PRIMARY KEY (collection, node, field)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    type TEXT
  ) STRICT;
`;

const TABLES = new Set(["meta", "events", "nodes", "edges", "vectors", "blobs"]);

type Row = Record<string, SQLInputValue>;

const duplicateKey = (collection: string, id: string) =>
  Object.assign(new Error(`Duplicate _id "${id}" in "${collection}"`), { code: "duplicate_key" });

/** Numbered parameters (?1, ?2, …), so they may appear in the SQL in any order. */
const binder = () => {
  const params: SQLInputValue[] = [];
  const bind: Bind = (value) => `?${params.push(value as SQLInputValue)}`;
  return { bind, params };
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function sqliteStore(options: {
  path: string;
  /** Each connection's page cache (64 MiB) and memory-mapped reads (256 MiB). */
  cacheKiB?: number;
  mmapMiB?: number;
  /** Opens a connection (two are opened: one writes, one reads). Default: the runtime's own SQLite. */
  open?: (path: string) => SqliteDatabase | Promise<SqliteDatabase>;
}): Promise<
  Store & {
    /** Exposes each collection as a SQL view of its schema's top-level fields. */
    describe(collections: Record<string, JSONSchema>): void;
    index(collections: Record<string, IndexSpec[]>): void;
  }
> {
  const connect = async () => {
    const db = await (options.open ?? builtin)(options.path);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; " +
        // SQLite's default page cache is 2 MB: too small for indexes over a growing file.
        `PRAGMA cache_size = -${options.cacheKiB ?? 65_536}; PRAGMA mmap_size = ${
          (options.mmapMiB ?? 256) * 1024 * 1024
        };`,
    );
    return db;
  };
  const writer = await connect();
  // Vectors were once keyed by id alone, before any were written: start them over.
  const shape = writer.prepare("PRAGMA table_info(vectors)").all() as { name: string }[];
  if (shape.length && !shape.some((column) => column.name === "field")) {
    writer.exec("DROP TABLE vectors");
  }
  writer.exec(SCHEMA);
  // Events record who did them since the actor came in: older logs gain the column.
  const logged = writer.prepare("PRAGMA table_info(events)").all() as { name: string }[];
  if (!logged.some((column) => column.name === "actor")) {
    writer.exec("ALTER TABLE events ADD COLUMN actor TEXT");
  }
  writer.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', 0)");
  // The planner prefers the primary key (collection, id) to a collection's
  // own indexes unless statistics say how many rows a collection holds and
  // how its indexes divide them. They're gathered when missing, and again
  // each time the table about doubles (one pass per index: ~0.15 s for 200k rows).
  const counting = writer.prepare("SELECT total_changes() AS n");
  const changes = () => Number((counting.get() as { n: number }).n);
  const primary = String(
    (writer.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes' " +
        "AND name LIKE 'sqlite_autoindex_nodes_%'",
    ).get() as Row).name,
  );
  const counted = () => {
    if (!writer.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").get()) return;
    const row = writer.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?").get(primary) as
      | Row
      | undefined;
    return row ? Number(String(row.stat).split(" ")[0]) : undefined;
  };
  let due = 0;
  /** The reading connection loads the new statistics (it keeps what it loaded first). */
  let reload = () => {};
  const analyze = () => {
    writer.exec("ANALYZE nodes");
    due = changes() + Math.max(1_000, counted() ?? 0);
    reload();
  };
  const known = counted();
  if (known === undefined) analyze();
  else due = changes() + Math.max(1_000, known);
  const committed = await connect();
  reload = () => committed.exec("ANALYZE sqlite_schema");
  let statements = 0;
  let queue = Promise.resolve();

  const prepared = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>();
  const statement = (db: SqliteDatabase, sql: string) => {
    if (!prepared.has(db)) prepared.set(db, new Map());
    const cache = prepared.get(db)!;
    if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
    statements++;
    return cache.get(sql)!;
  };
  const all = (db: SqliteDatabase, sql: string, params: SQLInputValue[] = []) =>
    statement(db, sql).all(...params) as Row[];
  const one = (db: SqliteDatabase, sql: string, params: SQLInputValue[] = []) =>
    statement(db, sql).get(...params) as Row | undefined;
  const run = (db: SqliteDatabase, sql: string, params: SQLInputValue[] = []) =>
    statement(db, sql).run(...params);

  const event = (row: Row): Event => ({
    seq: Number(row.seq),
    id: String(row.id),
    type: String(row.type),
    data: JSON.parse(String(row.data)),
    ...(row.cause === null ? {} : { cause: String(row.cause) }),
    ...(row.actor == null ? {} : { actor: JSON.parse(String(row.actor)) }),
    at: String(row.at),
  });

  // Collections with declared indexes: their fields' types, for filters to use the indexes.
  // Such a collection is named literally in queries, as its partial indexes are.
  const scalars = new Map<string, Scalars>();
  const named = (collection: string, bind: Bind) =>
    scalars.has(collection) ? `'${collection.replaceAll("'", "''")}'` : bind(collection);
  /** An index's name: short, and the same for the same collection and fields. */
  const indexName = (collection: string, fields: string[]) => {
    let h = 2166136261;
    for (const c of `${collection}\u0000${fields.join("\u0000")}`) {
      h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    }
    return `ix_${h.toString(36)}`;
  };

  const reader = (db: SqliteDatabase): Reader => {
    // Async, so a filter it can't translate rejects like any other failure.
    const find: Reader["find"] = async (collection, filter = {}, options = {}) => {
      const { bind, params } = binder();
      const sql = `SELECT doc FROM nodes WHERE collection = ${named(collection, bind)} AND ` +
        `${where(filter, sqlite, bind, scalars.get(collection))}` +
        page(options, sqlite, bind, scalars.get(collection));
      return await Promise.resolve(
        all(db, sql, params).map((row) => JSON.parse(String(row.doc)) as Doc),
      );
    };
    return {
      find,
      // Filtered in SQL, ranked here: SQLite has no vector index.
      async nearest(collection, field, vector, options = {}) {
        const { bind, params } = binder();
        const sql = `SELECT n.doc AS doc, v.embedding AS embedding FROM nodes n JOIN vectors v ` +
          `ON v.collection = n.collection AND v.node = n.id WHERE n.collection = ${
            named(collection, bind)
          } AND v.field = ${bind(field)} AND ${
            where(options.filter ?? {}, sqlite, bind, scalars.get(collection))
          } ` +
          `ORDER BY n.rowid`;
        const scored = (await Promise.resolve(all(db, sql, params))).flatMap((row) => {
          const embedding = JSON.parse(String(row.embedding)) as number[];
          return embedding.length === vector.length
            ? [{ ...JSON.parse(String(row.doc)) as Doc, _score: cosine(embedding, vector) }]
            : [];
        });
        return scored.sort((a, b) => b._score - a._score).slice(0, options.limit ?? 10);
      },
      findOne: async (collection, filter, options) =>
        (await find(collection, filter, { ...options, limit: 1 }))[0] ?? null,
      async aggregate(collection, plan) {
        if (!plan.group) return await find(collection, plan.match, plan);
        const { bind, params } = binder();
        const query = grouped({ ...plan, group: plan.group }, sqlite, sqliteAggregates, bind);
        const sql =
          `SELECT ${query.select} FROM nodes WHERE collection = ${named(collection, bind)} AND ` +
          `${where(plan.match, sqlite, bind, scalars.get(collection))}${query.groupBy}`;
        return await Promise.resolve(query.read(all(db, sql, params)));
      },
      async count(collection, filter = {}) {
        const { bind, params } = binder();
        const sql =
          `SELECT count(*) AS n FROM nodes WHERE collection = ${named(collection, bind)} AND ` +
          where(filter, sqlite, bind, scalars.get(collection));
        return await Promise.resolve(Number(one(db, sql, params)?.n ?? 0));
      },
      edges(query) {
        const rows = all(
          db,
          `SELECT "from", type, "to", data FROM edges WHERE ` +
            `(?1 IS NULL OR "from" = ?1) AND (?2 IS NULL OR type = ?2) AND (?3 IS NULL OR "to" = ?3)`,
          [query.from ?? null, query.type ?? null, query.to ?? null],
        );
        return Promise.resolve(rows.map((row) => ({
          from: String(row.from),
          type: String(row.type),
          to: String(row.to),
          ...(row.data === null ? {} : { data: JSON.parse(String(row.data)) }),
        })));
      },
      blob(id) {
        const row = one(db, "SELECT data, type FROM blobs WHERE id = ?", [id]);
        return Promise.resolve(
          row
            ? {
              id,
              data: row.data as Uint8Array,
              ...(row.type === null ? {} : { type: String(row.type) }),
            }
            : null,
        );
      },
      events: (after, limit = 1000) =>
        Promise.resolve(
          all(db, "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", [after, limit])
            .map(event),
        ),
      related: (id, types) =>
        Promise.resolve(
          all(
            db,
            `SELECT * FROM events WHERE (id = ? OR cause = ?) AND type IN (${
              types.map(() => "?").join(", ")
            }) ORDER BY seq`,
            [id, id, ...types],
          ).map(event),
        ),
    };
  };

  const transaction = (emitted: Omit<Event, "seq" | "at">[]): Transaction => {
    const read = reader(writer);
    /** Whether it went in: with `ifAbsent`, an existing `_id` is left as it is. */
    const insert = (collection: string, doc: Doc, ifAbsent = false) => {
      try {
        run(writer, "INSERT INTO nodes (collection, id, doc) VALUES (?, ?, ?)", [
          collection,
          doc._id,
          JSON.stringify(doc),
        ]);
        return true;
      } catch (error) {
        if (!String(error).includes("UNIQUE")) throw error;
        if (ifAbsent) return false;
        throw duplicateKey(collection, doc._id);
      }
    };
    const write = (collection: string, doc: Doc) =>
      run(writer, "UPDATE nodes SET doc = ? WHERE collection = ? AND id = ?", [
        JSON.stringify(doc),
        collection,
        doc._id,
      ]);
    return {
      ...read,
      insert(collection, docs, options = {}) {
        const fresh = docs.filter((doc) => insert(collection, doc, options.ifAbsent));
        return Promise.resolve({
          changes: fresh.map((doc) => ({ _id: doc._id, before: null, after: doc })),
        });
      },
      async update(collection, filter, update, options = {}) {
        const found = await read.find(collection, filter, options.many ? {} : { limit: 1 });
        const changes: Change[] = [];
        for (const doc of found) {
          const next = applyUpdate(doc, update);
          if (JSON.stringify(next) === JSON.stringify(doc)) continue;
          write(collection, next);
          changes.push({ _id: doc._id, before: doc, after: next });
        }
        if (found.length || !options.upsert) {
          return { matched: found.length, modified: changes.length, changes };
        }
        // Upsert: the filter's equality fields seed the new document.
        const seed = seedOf(filter);
        const created = applyUpdate(seed, update);
        insert(collection, created);
        return {
          matched: 0,
          modified: 0,
          upsertedId: seed._id,
          changes: [{ _id: seed._id, before: null, after: created }],
        };
      },
      async replace(collection, filter, doc, options = {}) {
        const current = await read.findOne(collection, filter);
        if (current) {
          const next = { ...doc, _id: current._id };
          if (JSON.stringify(next) === JSON.stringify(current)) return { matched: 1, changes: [] };
          write(collection, next);
          return { matched: 1, changes: [{ _id: current._id, before: current, after: next }] };
        }
        if (!options.upsert) return { matched: 0, changes: [] };
        const id = seedOf(filter)._id;
        const created = { ...doc, _id: id };
        insert(collection, created);
        return {
          matched: 0,
          upsertedId: id,
          changes: [{ _id: id, before: null, after: created }],
        };
      },
      async delete(collection, filter, options = {}) {
        const found = await read.find(collection, filter, options.many ? {} : { limit: 1 });
        for (const doc of found) {
          run(writer, "DELETE FROM nodes WHERE collection = ? AND id = ?", [collection, doc._id]);
        }
        return {
          deleted: found.length,
          changes: found.map((doc) => ({ _id: doc._id, before: doc, after: null })),
        };
      },
      link(edge: Edge) {
        run(writer, `INSERT OR REPLACE INTO edges ("from", type, "to", data) VALUES (?, ?, ?, ?)`, [
          edge.from,
          edge.type,
          edge.to,
          edge.data === undefined ? null : JSON.stringify(edge.data),
        ]);
        return Promise.resolve();
      },
      unlink(edge) {
        run(writer, `DELETE FROM edges WHERE "from" = ? AND type = ? AND "to" = ?`, [
          edge.from,
          edge.type,
          edge.to,
        ]);
        return Promise.resolve();
      },
      putBlob(value: Blob) {
        // Content-addressed: an existing id already holds these bytes.
        run(writer, "INSERT OR IGNORE INTO blobs (id, data, type) VALUES (?, ?, ?)", [
          value.id,
          value.data,
          value.type ?? null,
        ]);
        return Promise.resolve();
      },
      putVector(value) {
        run(
          writer,
          "INSERT OR REPLACE INTO vectors (collection, node, field, embedding) VALUES (?1, ?2, ?3, ?4)",
          [value.collection, value.doc, value.field, JSON.stringify(value.embedding)],
        );
        return Promise.resolve();
      },
      deleteVectors(collection, docs, field) {
        if (!docs.length) return Promise.resolve();
        const { bind, params } = binder();
        run(
          writer,
          `DELETE FROM vectors WHERE collection = ${bind(collection)} AND node IN (${
            docs.map((doc) => bind(doc)).join(", ")
          })${field ? ` AND field = ${bind(field)}` : ""}`,
          params,
        );
        return Promise.resolve();
      },
      emit(value) {
        emitted.push({ ...value, id: value.id ?? crypto.randomUUID() });
      },
    };
  };

  // One writer at a time, like the owner itself.
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const epochNow = () => Number(one(writer, "SELECT value FROM meta WHERE key = 'epoch'")?.value);

  return {
    ...reader(committed),
    open: () =>
      serially(() => {
        writer.exec("BEGIN IMMEDIATE");
        try {
          run(writer, "UPDATE meta SET value = value + 1 WHERE key = 'epoch'");
          const epoch = epochNow();
          writer.exec("COMMIT");
          return Promise.resolve({ epoch });
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }),
    positions: () =>
      Promise.resolve(Object.fromEntries(
        all(committed, "SELECT key, value FROM meta WHERE key LIKE 'position:%'").map((row) => [
          String(row.key).slice("position:".length),
          Number(row.value),
        ]),
      )),
    transaction: (owner, work, options = {}) =>
      serially(async () => {
        // The write lock is held from here to COMMIT, so the epoch can't move under us.
        writer.exec("BEGIN IMMEDIATE");
        try {
          if (epochNow() !== owner) throw fenced();
          const emitted: Omit<Event, "seq" | "at">[] = [];
          const result = await work(transaction(emitted));
          const at = new Date().toISOString();
          const events: Event[] = [];
          // An event id already in the log was committed by an earlier attempt.
          for (const e of emitted) {
            const inserted = run(
              writer,
              "INSERT OR IGNORE INTO events (id, type, data, cause, actor, at) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
              [
                e.id,
                e.type,
                JSON.stringify(e.data),
                e.cause ?? null,
                e.actor ? JSON.stringify(e.actor) : null,
                at,
              ],
            );
            if (inserted.changes) {
              events.push({ ...e, seq: Number(inserted.lastInsertRowid), at });
            }
          }
          for (const [name, seq] of Object.entries(options.positions ?? {})) {
            run(
              writer,
              "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
              [
                `position:${name}`,
                seq,
              ],
            );
          }
          writer.exec("COMMIT");
          if (changes() >= due) analyze();
          return { result, events };
        } catch (error) {
          if (writer.isTransaction ?? writer.inTransaction) writer.exec("ROLLBACK");
          throw error;
        }
      }),
    index(collections) {
      const wanted = new Set<string>();
      for (const [collection, specs] of Object.entries(collections)) {
        scalars.set(
          collection,
          new Map(specs.flatMap((spec) => spec.fields.map((f) => [f.path, f.type] as const))),
        );
        for (const spec of specs) {
          const name = indexName(collection, spec.fields.map((f) => f.path));
          wanted.add(name);
          writer.exec(
            `CREATE INDEX IF NOT EXISTS ${quote(name)} ON nodes ` +
              `(${spec.fields.map((f) => scalar(f.path)).join(", ")}) ` +
              `WHERE collection = '${collection.replaceAll("'", "''")}'`,
          );
        }
      }
      // Indexes no longer declared go.
      const existing = writer.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix\\_%' ESCAPE '\\'",
      ).all() as { name: string }[];
      for (const { name } of existing) {
        if (!wanted.has(name)) writer.exec(`DROP INDEX ${quote(name)}`);
      }
      // New indexes have no statistics yet.
      const had = new Set(existing.map(({ name }) => name));
      if ([...wanted].some((name) => !had.has(name))) {
        analyze();
      }
    },
    describe(collections) {
      for (const [name, def] of Object.entries(collections)) {
        if (TABLES.has(name)) continue;
        const fields = Object.keys(
          (def as { properties?: Record<string, unknown> }).properties ?? {},
        ).filter((field) => field !== "_id");
        const columns = fields.map((field) =>
          `json_extract(doc, '$."${field.replaceAll('"', "").replaceAll("'", "''")}"') AS ${
            quote(field)
          }`
        );
        writer.exec(`DROP VIEW IF EXISTS ${quote(name)}`);
        writer.exec(
          `CREATE VIEW ${quote(name)} AS SELECT ${["id AS _id", ...columns].join(", ")} ` +
            `FROM nodes WHERE collection = '${name.replaceAll("'", "''")}' ORDER BY rowid`,
        );
      }
    },
    roundTrips: () => statements,
    close() {
      writer.close();
      committed.close();
      return Promise.resolve();
    },
  };
}
