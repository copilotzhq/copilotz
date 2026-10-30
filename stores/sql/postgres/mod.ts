/**
 * PostgreSQL storage adapter on Ominipg: a PostgreSQL server for a
 * `postgres://` URL, or PGlite in this process for `:memory:` and files.
 *
 * A store holds one tenant's data (an org's) in a schema other tenants may
 * share: every statement it makes names its tenant, so isolation never
 * depends on anything outside the store, and a tenant's rows copy elsewhere
 * unchanged (`tenants.ts`). Small orgs can share a few schemas and a big one
 * have its own: placement is the host's choice. Without a `tenant`, a store
 * is its schema's only tenant (""), with the same tables.
 *
 * There are five tables: `events`, `nodes` (documents as jsonb), `edges`,
 * `vectors` and `blobs` (bytea), plus `meta` for each tenant's fencing epoch
 * and Processor positions (`layout.ts`). MongoDB filters and sorts become SQL
 * over the jsonb (`dialect.ts`), and so do most updates (`update.ts`); the
 * rest read the matching documents, apply the reference operators and write
 * them back, in the same transaction.
 *
 * Connections come from a pool (`pool.ts`): one shared by every store the
 * process opens, or one of the store's own for a URL. The owner commits
 * through its write lane and reads committed state through its read lane.
 * PGlite has a single connection, so its reads wait for an open transaction.
 */
import type { JSONSchema } from "../../../runtime/define.ts";
import { applyUpdate, seedOf } from "../../../runtime/mongo.ts";
import { canonical } from "../../../runtime/registry.ts";
import {
  type Blob,
  type Change,
  type Command,
  cosine,
  type Doc,
  type Edge,
  type Event,
  fenced,
  type Filter,
  type IndexSpec,
  type Reader,
  type Store,
  type Transaction,
} from "../../../runtime/store.ts";
import { type Bind, page, type Scalars, where } from "../shared/filter.ts";
import { postgres, postgresAggregates, scalar } from "./dialect.ts";
import { grouped } from "../shared/aggregate.ts";
import { expression } from "./update.ts";
import {
  constant,
  forget,
  ident,
  type Layout,
  others,
  prepare,
  remembered,
  type Row,
  type Session,
  TABLES,
} from "./layout.ts";
import { type PostgresPool, postgresPool } from "./pool.ts";
import { dropTenant } from "./tenants.ts";

export { type PostgresPool, postgresPool } from "./pool.ts";
export { copyTenant, dropTenant, exportTenant, type Location } from "./tenants.ts";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const duplicateKey = (collection: string, id: string) =>
  Object.assign(new Error(`Duplicate _id "${id}" in "${collection}"`), { code: "duplicate_key" });

/**
 * After `INSERT … ON CONFLICT DO NOTHING RETURNING`, the first document that
 * didn't go in: its _id was taken, or repeated among the documents themselves.
 */
const notInserted = (docs: [string, Doc][], inserted: [string, string][]) => {
  const fresh = new Set(inserted.map((key) => JSON.stringify(key)));
  const seen = new Set<string>();
  for (const [collection, doc] of docs) {
    const key = JSON.stringify([collection, doc._id]);
    if (seen.has(key) || !fresh.has(key)) return duplicateKey(collection, doc._id);
    seen.add(key);
  }
};

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Numbered parameters ($1, $2, …) in the order they are bound. */
const binder = () => {
  const params: unknown[] = [];
  const bind: Bind = (value) => `$${params.push(value)}`;
  return { bind, params };
};

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** A short hash, the same for the same text: names and fingerprints for what a store makes. */
const hash = (text: string) => {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(36);
};

/** Each event once: an id given twice in one commit is one event. */
const unique = <E extends { id: string }>(events: E[]) => {
  const seen = new Set<string>();
  return events.filter((e) => !seen.has(e.id) && seen.add(e.id));
};

export async function postgresStore(options: {
  /** A database for this store alone: it opens its own connections, and closes them with itself. */
  url?: string;
  /** Or connections shared with the process's other stores (`postgresPool`); the host closes it. */
  pool?: PostgresPool;
  schema?: string;
  /** Whose data this is (an org's id). Without one, the store is its schema's only tenant (""). */
  tenant?: string;
  /** Hears every SQL statement sent, for debugging. */
  trace?: (sql: string) => void;
}): Promise<
  Store & {
    /** Exposes each collection as a SQL view of its schema's top-level fields. */
    describe(collections: Record<string, JSONSchema>): Promise<void>;
    index(collections: Record<string, IndexSpec[]>): Promise<void>;
    /** Runs a read-only query, for inspection tools; in a schema of its own only. */
    inspect(sql: string): Promise<Row[]>;
    /** Deletes everything this store holds, then closes: a tenant gone for good. */
    drop(): Promise<void>;
  }
> {
  if (!options.url === !options.pool) throw new Error("postgresStore takes a url or a pool");
  const tenant = options.tenant ?? "";
  if (tenant.includes("\u0000")) throw new Error("A tenant can't contain a NUL character");
  const own = !options.pool;
  // A pool of its own holds what a store alone may need: an owner's commits run together.
  const pool = options.pool ?? await postgresPool({ url: options.url!, writes: 5, reads: 5 });
  const schema = options.schema ?? "copilotz";
  const t = (table: string) => `${ident(schema)}.${table}`;
  /** This store's tenant, as SQL: every statement names it. */
  const T = constant(tenant);
  const writer = pool.writes;
  const committed = pool.reads;
  let layout: Layout;
  try {
    layout = await prepare(pool, schema);
  } catch (error) {
    if (own) await pool.close();
    throw error;
  }
  let closed = false;
  const close = async () => {
    closed = true;
    if (own) await pool.close();
  };
  let statements = 0;
  const trace = options.trace;
  const run = async (db: Session, sql: string, params: unknown[] = []) => {
    if (closed) throw new Error("This store is closed.");
    statements++;
    trace?.(sql);
    return (await db.query(sql, params)).rows;
  };
  /** A session whose statements count as this store's, and are traced. */
  const counted = (db: Session): Session => ({
    query: async (sql, params) => ({ rows: await run(db, sql, params) }),
  });

  // Vectors are pgvector's where the database has it (PGlite always does), and
  // jsonb otherwise, ranked in JavaScript.
  const pgvector = layout.vector;
  const kind = pgvector ? "vector" : "jsonb";

  const event = (row: Row): Event => ({
    seq: Number(row.seq),
    id: String(row.id),
    type: String(row.type),
    data: row.data as Record<string, unknown>,
    ...(row.cause === null ? {} : { cause: String(row.cause) }),
    ...(row.actor == null ? {} : { actor: row.actor as Event["actor"] }),
    at: String(row.at),
  });

  /**
   * Writes run together, as they come, except one that runs alone: it waits
   * for those running to end, and those after it wait for it. (A write whose
   * events can't be counted before it runs is one; see `take`.)
   */
  const waiting: { alone: boolean; start(): void }[] = [];
  let running = 0;
  let solo = false;
  const pump = () => {
    while (waiting.length && !solo && !(waiting[0].alone && running)) {
      const next = waiting.shift()!;
      running++;
      solo = next.alone;
      next.start();
    }
  };
  const gate = <R>(alone: boolean, work: () => Promise<R>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      waiting.push({
        alone,
        start: () =>
          void work().then(resolve, reject).finally(() => {
            running--;
            if (alone) solo = false;
            pump();
          }),
      });
      pump();
    });

  /**
   * The highest seq given out in this tenant's log, loaded when the store
   * opens. The owner is its tenant's only writer (fenced by its epoch), so
   * the store numbers events itself, in memory, and writes explicit values.
   * Writes running together each take a range of numbers before they are
   * sent, one no other write gets, and number what they record from its
   * start. Numbers a write doesn't use stay a gap, as a sequence leaves one;
   * no number is given twice, even when a write's outcome is unknown. A write
   * whose events can't be counted before it runs, runs alone, numbering from
   * the last given out.
   */
  let last: number | undefined;
  /**
   * The seq before a write's first event, `count` numbers taken (none, alone:
   * it numbers on from the last). Before opening, from the log itself: such a
   * write is fenced anyway.
   */
  const take = (count: number | "alone") => {
    if (last === undefined) {
      return `(SELECT coalesce(max(seq), 0) FROM ${t("events")} WHERE tenant = ${T})`;
    }
    const before = last;
    if (count !== "alone") last += count;
    return `${before}::bigint`;
  };
  /** What a write that ran alone numbered: the last given out moves past it. */
  const numbered = (seqs: number[]) => {
    for (const seq of seqs) if (last !== undefined && seq > last) last = seq;
  };
  const load = async () => {
    const [row] = await run(
      writer,
      `SELECT coalesce(max(seq), 0) AS seq FROM ${t("events")} WHERE tenant = ${T}`,
    );
    return Number(row.seq);
  };

  /**
   * Appends events to the tenant's log, numbered on from `before`: `source`
   * yields rows (id, type, data, cause, actor, at), ordered by `order`. An id
   * already in the log was committed by an earlier attempt: it is skipped,
   * its number left unused.
   */
  const appending = (source: string, order: string, before: string, condition = "TRUE") =>
    `INSERT INTO ${t("events")} (tenant, seq, id, type, data, cause, actor, at) SELECT ${T}, ` +
    `${before} + row_number() OVER (ORDER BY ${order}), x.id, x.type, x.data, x.cause, ` +
    `x.actor, x.at FROM (${source}) x WHERE ${condition} ON CONFLICT (tenant, id) DO NOTHING`;

  // Collections with declared indexes: their fields' types, for filters to use the indexes.
  // Such a collection is named literally in queries, as its partial indexes are.
  const scalars = new Map<string, Scalars>();
  const named = (collection: string, bind: Bind) =>
    scalars.has(collection) ? literal(collection) : bind(collection);
  /** An index's name: short, and the same for the same collection and fields. */
  const indexName = (collection: string, fields: string[]) =>
    // Indexes lead with the tenant, and hold NULL first (see the dialect's `sorted`).
    `ix_${hash(`${collection}\u0000${fields.join("\u0000")}\u0000nulls first\u0000tenant`)}`;

  const reader = (db: Session): Reader => {
    const find: Reader["find"] = async (collection, filter = {}, options = {}) => {
      const { bind, params } = binder();
      const sql = `SELECT doc FROM ${t("nodes")} WHERE tenant = ${T} AND collection = ` +
        `${named(collection, bind)} AND ${where(filter, postgres, bind, scalars.get(collection))}` +
        page(options, postgres, bind, scalars.get(collection));
      return (await run(db, sql, params)).map((row) => row.doc as Doc);
    };
    return {
      find,
      async nearest(collection, field, query, options = {}) {
        const { bind, params } = binder();
        const join = `FROM ${t("nodes")} n JOIN ${t("vectors")} v ON v.tenant = n.tenant AND ` +
          `v.collection = n.collection AND v.node = n.id WHERE n.tenant = ${T} AND n.collection = ` +
          `${named(collection, bind)} AND v.field = ${bind(field)} AND ${
            where(options.filter ?? {}, postgres, bind, scalars.get(collection))
          }`;
        const limit = options.limit ?? 10;
        if (pgvector) {
          const q = `${bind(JSON.stringify(query))}::vector`;
          const rows = await run(
            db,
            `SELECT n.doc, 1 - (v.embedding <=> ${q}) AS score ${join} AND vector_dims(v.embedding) ` +
              `= ${bind(query.length)} ORDER BY v.embedding <=> ${q}, n.n LIMIT ${bind(limit)}`,
            params,
          );
          return rows.map((row) => ({ ...(row.doc as Doc), _score: Number(row.score) }));
        }
        const rows = await run(db, `SELECT n.doc, v.embedding ${join} ORDER BY n.n`, params);
        return rows.flatMap((row) => {
          const embedding = row.embedding as number[];
          return embedding.length === query.length
            ? [{ ...(row.doc as Doc), _score: cosine(embedding, query) }]
            : [];
        }).sort((a, b) => b._score - a._score).slice(0, limit);
      },
      findOne: async (collection, filter, options) =>
        (await find(collection, filter, { ...options, limit: 1 }))[0] ?? null,
      async aggregate(collection, plan) {
        if (!plan.group) return await find(collection, plan.match, plan);
        const { bind, params } = binder();
        const query = grouped({ ...plan, group: plan.group }, postgres, postgresAggregates, bind);
        const sql = `SELECT ${query.select} FROM ${t("nodes")} WHERE tenant = ${T} AND ` +
          `collection = ${named(collection, bind)} AND ` +
          `${where(plan.match, postgres, bind, scalars.get(collection))}${query.groupBy}`;
        return query.read(await run(db, sql, params));
      },
      async count(collection, filter = {}) {
        const { bind, params } = binder();
        const sql = `SELECT count(*)::int AS n FROM ${t("nodes")} WHERE tenant = ${T} AND ` +
          `collection = ${named(collection, bind)} AND ${
            where(filter, postgres, bind, scalars.get(collection))
          }`;
        return Number((await run(db, sql, params))[0]?.n ?? 0);
      },
      async edges(query) {
        const rows = await run(
          db,
          `SELECT "from", type, "to", data FROM ${t("edges")} WHERE tenant = ${T} AND ` +
            `($1::text IS NULL OR "from" = $1) AND ($2::text IS NULL OR type = $2) AND ` +
            `($3::text IS NULL OR "to" = $3)`,
          [query.from ?? null, query.type ?? null, query.to ?? null],
        );
        return rows.map((row) => ({
          from: String(row.from),
          type: String(row.type),
          to: String(row.to),
          ...(row.data === null ? {} : { data: row.data as Record<string, unknown> }),
        }));
      },
      async blob(id) {
        const [row] = await run(
          db,
          `SELECT data, type FROM ${t("blobs")} WHERE tenant = ${T} AND id = $1`,
          [id],
        );
        if (!row) return null;
        return {
          id,
          data: new Uint8Array(row.data as Uint8Array),
          ...(row.type === null ? {} : { type: String(row.type) }),
        };
      },
      events: async (after, limit = 1000) =>
        (await run(
          db,
          `SELECT * FROM ${t("events")} WHERE tenant = ${T} AND seq > $1 ORDER BY seq LIMIT $2`,
          [after, limit],
        )).map(event),
      related: async (id, types) =>
        (await run(
          db,
          `SELECT * FROM ${t("events")} WHERE tenant = ${T} AND (id = $1 OR cause = $1) AND ` +
            `type = ANY($2::text[]) ORDER BY seq`,
          [id, types],
        )).map(event),
    };
  };

  /**
   * Writes a transaction holds back: inserts and blobs answer nothing the
   * caller doesn't know, so they wait for the transaction's next statement,
   * or go in its last one. A transaction of only these is one statement.
   */
  type Held = { docs: [string, Doc][]; blobs: Blob[] };

  const transaction = (
    tx: Session,
    emitted: Omit<Event, "seq" | "at">[],
    held: Held,
  ): Transaction & { flush(): Promise<void> } => {
    /** The ids that went in. With `ifAbsent`, existing ones are left as they are. */
    const insert = async (collection: string, docs: Doc[], ifAbsent = false) => {
      if (!docs.length) return new Set<string>();
      const { bind, params } = binder();
      const values = docs.map((doc) =>
        `(${T}, ${bind(collection)}, ${bind(doc._id)}, ${bind(JSON.stringify(doc))}::jsonb)`
      );
      // ON CONFLICT keeps the transaction usable, and names exactly which ids existed.
      const inserted = await run(
        tx,
        `INSERT INTO ${t("nodes")} (tenant, collection, id, doc) VALUES ${values.join(", ")} ` +
          `ON CONFLICT DO NOTHING RETURNING id`,
        params,
      );
      if (!ifAbsent) {
        const duplicate = notInserted(
          docs.map((doc) => [collection, doc]),
          inserted.map((row) => [collection, String(row.id)]),
        );
        if (duplicate) throw duplicate;
      }
      return new Set(inserted.map((row) => String(row.id)));
    };
    /** Sends what is held back, before any statement that may read or change it. */
    const flush = async () => {
      const docs = held.docs.splice(0);
      const blobs = held.blobs.splice(0);
      for (const collection of new Set(docs.map(([c]) => c))) {
        await insert(collection, docs.filter(([c]) => c === collection).map(([, doc]) => doc));
      }
      for (const blob of blobs) {
        // Content-addressed: an existing id already holds these bytes.
        await run(
          tx,
          `INSERT INTO ${t("blobs")} (tenant, id, data, type) VALUES (${T}, $1, $2, $3) ` +
            `ON CONFLICT DO NOTHING`,
          [blob.id, blob.data, blob.type ?? null],
        );
      }
    };
    const after = <A extends unknown[], R>(f: (...args: A) => Promise<R>) => async (...args: A) => {
      await flush();
      return await f(...args);
    };
    const direct = reader(tx);
    const read: Reader = {
      find: after(direct.find),
      findOne: after(direct.findOne),
      count: after(direct.count),
      aggregate: after(direct.aggregate),
      nearest: after(direct.nearest),
      edges: after(direct.edges),
      blob: after(direct.blob),
      events: after(direct.events),
      related: after(direct.related),
    };
    /**
     * One statement: lock the matching documents, write the new version of
     * each that changes, or insert `seed` when none matched (an upsert), and
     * return every document's before and after.
     */
    const modify = async (
      collection: string,
      filter: Filter,
      next: (bind: Bind) => string,
      seed: Doc | undefined,
      many: boolean,
    ) => {
      // Held documents of other collections go in with this statement: it can't
      // see them (one snapshot), and needn't, as it only touches `collection`.
      const along = held.docs.every(([c]) => c !== collection) ? held.docs.splice(0) : [];
      await flush();
      const { bind, params } = binder();
      const c = bind(collection);
      const match = where(filter, postgres, bind);
      const limit = many ? "" : " LIMIT 1";
      const value = next(bind);
      const insert = seed
        ? `, ins AS (INSERT INTO ${t("nodes")} (tenant, collection, id, doc) SELECT ${T}, ${c}, ` +
          `${bind(seed._id)}, ${bind(JSON.stringify(seed))}::jsonb WHERE NOT EXISTS ` +
          `(SELECT 1 FROM prev) ON CONFLICT DO NOTHING RETURNING id)`
        : "";
      const docs = along.length
        ? `, docs AS (INSERT INTO ${t("nodes")} (tenant, collection, id, doc) SELECT ${T}, ` +
          `v.collection, v.id, v.doc FROM (VALUES ${
            along.map(([collection, doc], i) =>
              `(${bind(collection)}::text, ${bind(doc._id)}::text, ${
                bind(JSON.stringify(doc))
              }::jsonb, ${i})`
            ).join(", ")
          }) v(collection, id, doc, i) ORDER BY v.i ON CONFLICT DO NOTHING RETURNING collection, id)`
        : "";
      const [row] = await run(
        tx,
        `WITH prev AS (SELECT id, doc, n FROM ${t("nodes")} WHERE tenant = ${T} AND collection = ` +
          `${c} AND ${match} ORDER BY n${limit} FOR UPDATE), upd AS (UPDATE ${t("nodes")} t SET ` +
          `doc = ${value} FROM prev WHERE t.tenant = ${T} AND t.collection = ${c} AND t.id = ` +
          `ANY (ARRAY (SELECT id FROM prev)) AND t.id = prev.id AND t.doc IS DISTINCT FROM ` +
          `${value} RETURNING prev.doc AS before, t.doc AS ` +
          `after, prev.n)${insert}${docs} SELECT (SELECT count(*) FROM prev)::int AS matched, ` +
          `(SELECT jsonb_agg(jsonb_build_object('before', before, 'after', after) ORDER BY n) ` +
          `FROM upd) AS updated` +
          (seed ? `, (SELECT count(*) FROM ins)::int AS inserted` : "") +
          (along.length
            ? `, (SELECT jsonb_agg(jsonb_build_array(collection, id)) FROM docs) AS held`
            : ""),
        params,
      );
      const duplicate = along.length &&
        notInserted(along, (row.held ?? []) as [string, string][]);
      if (duplicate) throw duplicate;
      const updated = (row.updated ?? []) as { before: Doc; after: Doc }[];
      const changes: Change[] = updated.map(({ before, after }) => ({
        _id: after._id,
        before,
        after,
      }));
      const matched = Number(row.matched);
      if (!seed || matched) return { matched, modified: changes.length, changes };
      // No match: the seed went in, unless its _id belongs to a document the filter missed.
      if (!Number(row.inserted)) throw duplicateKey(collection, seed._id);
      return {
        matched: 0,
        modified: 0,
        upsertedId: seed._id,
        changes: [{ _id: seed._id, before: null, after: seed }],
      };
    };
    const write = (collection: string, doc: Doc) =>
      run(
        tx,
        `UPDATE ${t("nodes")} SET doc = $3::jsonb WHERE tenant = ${T} AND collection = $1 AND ` +
          `id = $2`,
        [collection, doc._id, JSON.stringify(doc)],
      );
    return {
      ...read,
      flush,
      async insert(collection, docs, options = {}) {
        if (options.ifAbsent) {
          // What goes in is known only once sent: sent now, in order after what is held.
          await flush();
          const fresh = await insert(collection, docs, true);
          const changes = docs.filter((doc) => fresh.delete(doc._id))
            .map((doc) => ({ _id: doc._id, before: null, after: doc }));
          return { changes };
        }
        held.docs.push(...docs.map((doc): [string, Doc] => [collection, doc]));
        return {
          changes: docs.map((doc) => ({ _id: doc._id, before: null, after: doc })),
        };
      },
      async update(collection, filter, update, options = {}) {
        const seed = options.upsert ? applyUpdate(seedOf(filter), update) : undefined;
        const fast = expression(update);
        if (fast) return await modify(collection, filter, fast, seed, options.many ?? false);
        await flush();
        // Other operators ($push, $pull, $addToSet, nested paths): read, apply, write.
        const found = await read.find(collection, filter, options.many ? {} : { limit: 1 });
        const changes: Change[] = [];
        for (const doc of found) {
          const next = applyUpdate(doc, update);
          if (same(next, doc)) continue;
          await write(collection, next);
          changes.push({ _id: doc._id, before: doc, after: next });
        }
        if (found.length || !seed) {
          return { matched: found.length, modified: changes.length, changes };
        }
        await insert(collection, [seed]);
        return {
          matched: 0,
          modified: 0,
          upsertedId: seed._id,
          changes: [{ _id: seed._id, before: null, after: seed }],
        };
      },
      async replace(collection, filter, doc, options = {}) {
        const seed = options.upsert ? { ...doc, _id: seedOf(filter)._id } : undefined;
        const { modified: _, ...result } = await modify(
          collection,
          filter,
          (bind) => `jsonb_set(${bind(JSON.stringify(doc))}::jsonb, '{_id}', to_jsonb(t.id))`,
          seed,
          false,
        );
        return result;
      },
      async delete(collection, filter, options = {}) {
        await flush();
        const { bind, params } = binder();
        const c = bind(collection);
        const rows = await run(
          tx,
          `DELETE FROM ${t("nodes")} t WHERE t.tenant = ${T} AND t.collection = ${c} AND t.id = ` +
            `ANY (ARRAY (SELECT id FROM ${t("nodes")} WHERE tenant = ${T} AND collection = ${c} ` +
            `AND ${where(filter, postgres, bind)}${
              page(options.many ? {} : { limit: 1 }, postgres, bind)
            })) RETURNING t.doc, t.n`,
          params,
        );
        const gone = rows.sort((a, b) => Number(a.n) - Number(b.n)).map((row) => row.doc as Doc);
        return {
          deleted: gone.length,
          changes: gone.map((doc) => ({ _id: doc._id, before: doc, after: null })),
        };
      },
      async link(edge: Edge) {
        await flush();
        await run(
          tx,
          `INSERT INTO ${
            t("edges")
          } (tenant, "from", type, "to", data) VALUES (${T}, $1, $2, $3, ` +
            `$4::jsonb) ON CONFLICT (tenant, "from", type, "to") DO UPDATE SET data = EXCLUDED.data`,
          [
            edge.from,
            edge.type,
            edge.to,
            edge.data === undefined ? null : JSON.stringify(edge.data),
          ],
        );
      },
      async unlink(edge) {
        await flush();
        await run(
          tx,
          `DELETE FROM ${t("edges")} WHERE tenant = ${T} AND "from" = $1 AND type = $2 AND ` +
            `"to" = $3`,
          [edge.from, edge.type, edge.to],
        );
      },
      putBlob(value: Blob) {
        held.blobs.push(value);
        return Promise.resolve();
      },
      async putVector(value) {
        await run(
          tx,
          `INSERT INTO ${
            t("vectors")
          } (tenant, collection, node, field, embedding) VALUES (${T}, ` +
            `$1, $2, $3, $4::${kind}) ON CONFLICT (tenant, collection, node, field) DO UPDATE SET ` +
            `embedding = EXCLUDED.embedding`,
          [value.collection, value.doc, value.field, JSON.stringify(value.embedding)],
        );
      },
      async deleteVectors(collection, docs, field) {
        if (!docs.length) return;
        await run(
          tx,
          `DELETE FROM ${t("vectors")} WHERE tenant = ${T} AND collection = $1 AND ` +
            `node = ANY($2::text[])` + (field ? " AND field = $3" : ""),
          field ? [collection, docs, field] : [collection, docs],
        );
      },
      emit(value) {
        emitted.push({ ...value, id: value.id ?? crypto.randomUUID() });
      },
    };
  };

  /** Events as VALUES rows (id, type, data, cause, actor, at, i), parameters bound. */
  const rows = (emitted: Omit<Event, "seq" | "at">[], at: string, bind: Bind) => {
    const when = bind(at);
    return `SELECT * FROM (VALUES ${
      emitted.map((e, i) =>
        `(${bind(e.id)}::text, ${bind(e.type)}::text, ${bind(JSON.stringify(e.data))}::jsonb, ` +
        `${bind(e.cause ?? null)}::text, ${
          bind(e.actor ? JSON.stringify(e.actor) : null)
        }::jsonb, ` +
        `${when}::text, ${i})`
      ).join(", ")
    }) v(id, type, data, cause, actor, at, i)`;
  };
  const committedEvents = (
    emitted: Omit<Event, "seq" | "at">[],
    at: string,
    inserted: { id: string; seq: number }[],
  ): Event[] => {
    const seqs = new Map(inserted.map((row) => [String(row.id), Number(row.seq)]));
    return emitted.filter((e) => seqs.has(e.id))
      .map((e) => ({ ...e, seq: seqs.get(e.id)!, at }))
      .sort((a, b) => a.seq - b.seq);
  };

  type Positions = Record<string, number>;
  type Finish = (sql: string) => Promise<{ rows: Row[] }>;

  /**
   * A statement that inserted held documents failed on the primary key: names
   * the duplicate (repeated within them, or already stored), as other stores do.
   */
  const conflict = async (error: unknown, docs: [string, Doc][]) => {
    if (!docs.length || !String(error).includes("nodes_pkey")) return error;
    const seen = new Set<string>();
    for (const [collection, doc] of docs) {
      const key = JSON.stringify([collection, doc._id]);
      if (seen.has(key)) return duplicateKey(collection, doc._id);
      seen.add(key);
    }
    const [row] = await run(
      committed,
      `SELECT collection, id FROM ${t("nodes")} WHERE tenant = ${T} AND (collection, id) IN ` +
        `(SELECT * FROM unnest($1::text[], $2::text[])) LIMIT 1`,
      [docs.map(([collection]) => collection), docs.map(([, doc]) => doc._id)],
    );
    return row ? duplicateKey(String(row.collection), String(row.id)) : error;
  };

  /**
   * The transaction's held writes, events and positions as one statement with
   * no parameters, so it can travel with COMMIT. Text is dollar-quoted with a
   * tag the text can't end early, so nothing needs escaping.
   */
  const final = (
    emitted: Omit<Event, "seq" | "at">[],
    positions: Positions,
    at: string,
    held: Held,
  ) => {
    const text = constant;
    // Typed, as VALUES rows: a bare NULL there would be text.
    const nullable = (value?: string) => `${value === undefined ? "NULL" : text(value)}::text`;
    const ctes: string[] = [];
    const entries = Object.entries(positions).map(([name, seq]) => {
      if (!Number.isSafeInteger(seq)) throw new Error(`Invalid position ${seq}`);
      return `(${T}, ${text(`position:${name}`)}::text, ${seq}::bigint)`;
    });
    if (entries.length) {
      ctes.push(
        `pos AS (INSERT INTO ${t("meta")} (tenant, key, value) VALUES ${entries.join(", ")} ` +
          `ON CONFLICT (tenant, key) DO UPDATE SET value = EXCLUDED.value)`,
      );
    }
    if (held.docs.length) {
      const values = held.docs.map(([collection, doc], i) =>
        `(${text(collection)}::text, ${text(doc._id)}::text, ${
          text(JSON.stringify(doc))
        }::jsonb, ${i})`
      );
      ctes.push(
        `docs AS (INSERT INTO ${t("nodes")} (tenant, collection, id, doc) SELECT ${T}, ` +
          `v.collection, v.id, v.doc FROM (VALUES ${
            values.join(", ")
          }) v(collection, id, doc, i) ` +
          `ORDER BY v.i)`,
      );
    }
    if (held.blobs.length) {
      const values = held.blobs.map((b) =>
        `(${T}, ${text(b.id)}::text, decode(${text(hex(b.data))}, 'hex'), ${nullable(b.type)})`
      );
      ctes.push(
        `b AS (INSERT INTO ${t("blobs")} (tenant, id, data, type) VALUES ${values.join(", ")} ` +
          `ON CONFLICT DO NOTHING)`,
      );
    }
    const head = ctes.length ? `WITH ${ctes.join(", ")} ` : "";
    if (!emitted.length) return `${head}SELECT 1`;
    const when = `${text(at)}::text`;
    const values = emitted.map((e, i) =>
      `(${text(e.id)}::text, ${text(e.type)}::text, ${text(JSON.stringify(e.data))}::jsonb, ` +
      `${nullable(e.cause)}, ${e.actor ? text(JSON.stringify(e.actor)) : "NULL"}::jsonb, ` +
      `${when}, ${i})`
    );
    return `${head}${
      appending(
        `SELECT * FROM (VALUES ${values.join(", ")}) v(id, type, data, cause, actor, at, i)`,
        "x.i",
        take(emitted.length),
      )
    } RETURNING seq, id`;
  };

  /** Upserts Processor positions into `meta`, as a CTE named `pos`, when there are any. */
  const saving = (positions: Positions, bind: Bind, guard = "") => {
    const entries = Object.entries(positions);
    if (!entries.length) return "";
    const values = entries.map(([name, seq]) =>
      `(${bind(`position:${name}`)}::text, ${bind(seq)}::bigint)`
    );
    return `pos AS (INSERT INTO ${t("meta")} (tenant, key, value) SELECT ${T}, p.key, p.value ` +
      `FROM (VALUES ${values.join(", ")}) p(key, value)${guard} ON CONFLICT (tenant, key) DO ` +
      `UPDATE SET value = EXCLUDED.value)`;
  };

  /**
   * Inserts a transaction's events and saves its positions, in one statement.
   * An event id already in the log was committed by an earlier attempt.
   */
  const record = async (
    tx: Session,
    emitted: Omit<Event, "seq" | "at">[],
    positions: Positions,
  ) => {
    const at = new Date().toISOString();
    const { bind, params } = binder();
    const pos = saving(positions, bind);
    const ins = emitted.length
      ? `${appending(rows(emitted, at, bind), "x.i", take(emitted.length))} RETURNING seq, id`
      : "";
    if (!pos && !ins) return [];
    const sql = ins ? `${pos ? `WITH ${pos} ` : ""}${ins}` : `WITH ${pos} SELECT 1`;
    const inserted = await run(tx, sql, params);
    return ins ? committedEvents(emitted, at, inserted as { id: string; seq: number }[]) : [];
  };

  /** The fence: this tenant's epoch, locked for share until the statement or transaction ends. */
  const fence = `fence AS (SELECT value FROM ${t("meta")} WHERE tenant = ${T} AND key = 'epoch' ` +
    `FOR SHARE)`;

  /**
   * Held writes, events and positions alone, as one statement that checks the
   * fence itself. A duplicate _id fails it whole, so nothing commits.
   */
  const append = async (
    owner: number,
    emitted: Omit<Event, "seq" | "at">[],
    positions: Positions,
    held: Held,
  ) => {
    const at = new Date().toISOString();
    const { bind, params } = binder();
    const epoch = bind(owner);
    const fenced_ = ` WHERE (SELECT value FROM fence) = ${epoch}::bigint`;
    const ctes = [fence];
    if (held.docs.length) {
      const values = held.docs.map(([collection, doc], i) =>
        `(${bind(collection)}::text, ${bind(doc._id)}::text, ${
          bind(JSON.stringify(doc))
        }::jsonb, ${i})`
      );
      ctes.push(
        `docs AS (INSERT INTO ${t("nodes")} (tenant, collection, id, doc) SELECT ${T}, ` +
          `v.collection, v.id, v.doc FROM (VALUES ${values.join(", ")}) v(collection, id, doc, i)` +
          `${fenced_} ORDER BY v.i)`,
      );
    }
    if (held.blobs.length) {
      const values = held.blobs.map((b) =>
        `(${bind(b.id)}::text, ${bind(b.data)}::bytea, ${bind(b.type ?? null)}::text)`
      );
      ctes.push(
        `b AS (INSERT INTO ${t("blobs")} (tenant, id, data, type) SELECT ${T}, v.id, v.data, ` +
          `v.type FROM (VALUES ${values.join(", ")}) v(id, data, type)${fenced_} ON CONFLICT ` +
          `DO NOTHING)`,
      );
    }
    if (emitted.length) {
      ctes.push(
        `ins AS (${
          appending(
            rows(emitted, at, bind),
            "x.i",
            take(emitted.length),
            `(SELECT value FROM fence) = ${epoch}::bigint`,
          )
        } RETURNING seq, id)`,
      );
    }
    const pos = saving(positions, bind, fenced_);
    if (pos) ctes.push(pos);
    const [row] = await run(
      writer,
      `WITH ${ctes.join(", ")} SELECT (SELECT value FROM fence) AS epoch` +
        (emitted.length
          ? `, (SELECT jsonb_agg(jsonb_build_object('seq', seq, 'id', id)) FROM ins) AS inserted`
          : ""),
      params,
    );
    if (Number(row.epoch) !== owner) throw fenced();
    return committedEvents(emitted, at, (row.inserted ?? []) as { id: string; seq: number }[]);
  };

  /**
   * Writes with their events, blobs and positions, as a single statement. A
   * statement on its own is atomic, so there is no BEGIN or COMMIT: one round
   * trip. The fence is checked inside it; if it fails, the statement changes
   * nothing. Lifecycle events are built here in SQL, exactly as the owner
   * builds them for other stores (the runtime tests hold both to it).
   *
   * Every part of a statement sees the same snapshot, so no write may depend
   * on another's effect: each collection gets either inserts, or one update,
   * replace or delete; each edge, one link or unlink. Other commands, and
   * updates that need JavaScript, return undefined (the owner then uses a
   * transaction).
   */
  const command = (owner: number, c: Command) => {
    const writes = c.steps.flatMap((step, i) => "write" in step ? [{ ...step, i }] : []);
    const touched = new Map<string, string>();
    for (const { write: op } of writes) {
      if (op.op === "emit" || (op.op === "update" && !expression(op.update))) return undefined;
      const key = "collection" in op
        ? `nodes:${op.collection}`
        : `edges:${JSON.stringify([op.edge.from, op.edge.type, op.edge.to])}`;
      const kind = op.op === "insert" ? "insert" : "other";
      if (touched.has(key) && (kind === "other" || touched.get(key) === "other")) return undefined;
      touched.set(key, kind);
    }
    // Each write it records takes as many numbers as documents it may change; one of many
    // documents can't say how many, so the command runs alone.
    const alone = writes.some(({ write: op, record }) =>
      record && (op.op === "update" || op.op === "delete") && op.options.many
    );
    const recorded = writes.reduce(
      (sum, { write: op, record }) =>
        sum + (!record ? 0 : op.op === "insert" ? op.docs.length : "collection" in op ? 1 : 0),
      0,
    );
    return gate(alone, async () => {
      const at = new Date().toISOString();
      const { bind, params } = binder();
      const epoch = bind(owner);
      const ok = "EXISTS (SELECT 1 FROM ok)";
      const ctes = [fence, `ok AS (SELECT 1 FROM fence WHERE value = ${epoch}::bigint)`];
      const select = [`(SELECT value FROM fence) AS epoch`];
      // Every event, ordered by its step: emits as given, then each write's own.
      const sources: string[] = [];
      const seeds: (Doc | undefined)[] = [];
      const inserted: [string, Doc][] = [];
      for (const [n, { write: op, record, i }] of writes.entries()) {
        let changes = "";
        let seed: Doc | undefined;
        switch (op.op) {
          case "insert": {
            if (!op.docs.length) break;
            if (!op.ifAbsent) {
              inserted.push(...op.docs.map((doc): [string, Doc] => [op.collection, doc]));
            }
            const values = op.docs.map((doc, k) =>
              `(${bind(doc._id)}::text, ${bind(JSON.stringify(doc))}::jsonb, ${k})`
            );
            // No ON CONFLICT: a duplicate _id fails the whole statement, so nothing commits.
            // With `ifAbsent`, existing ids are skipped, and only what went in is returned.
            ctes.push(
              `w${n} AS (INSERT INTO ${t("nodes")} (tenant, collection, id, doc) SELECT ${T}, ${
                bind(op.collection)
              }, v.id, v.doc FROM (VALUES ${values.join(", ")}) v(id, doc, i) WHERE ${ok} ` +
                `ORDER BY v.i${op.ifAbsent ? " ON CONFLICT DO NOTHING" : ""} RETURNING id, doc, n)`,
            );
            changes = `SELECT id, NULL::jsonb AS before, doc AS after, n AS ord FROM w${n}`;
            break;
          }
          case "update":
          case "replace": {
            const collection = bind(op.collection);
            const match = where(op.filter, postgres, bind);
            const many = op.op === "update" && op.options.many;
            const value = op.op === "update"
              ? expression(op.update)!(bind)
              : `jsonb_set(${bind(JSON.stringify(op.doc))}::jsonb, '{_id}', to_jsonb(t.id))`;
            if (op.options.upsert) {
              seed = op.op === "update"
                ? applyUpdate(seedOf(op.filter), op.update)
                : { ...op.doc, _id: seedOf(op.filter)._id };
              inserted.push([op.collection, seed]);
            }
            ctes.push(
              `prev${n} AS (SELECT id, doc, n FROM ${t("nodes")} WHERE ${ok} AND tenant = ${T} ` +
                `AND collection = ${collection} AND ${match} ORDER BY n${
                  many ? "" : " LIMIT 1"
                } FOR UPDATE)`,
              `upd${n} AS (UPDATE ${t("nodes")} t SET doc = ${value} FROM prev${n} WHERE ` +
                `t.tenant = ${T} AND t.collection = ${collection} AND t.id = ANY (ARRAY (SELECT ` +
                `id FROM prev${n})) AND t.id = prev${n}.id AND t.doc IS DISTINCT FROM ${value} ` +
                `RETURNING t.id, prev${n}.doc AS before, t.doc AS after, prev${n}.n)`,
            );
            if (seed) {
              ctes.push(
                `ins${n} AS (INSERT INTO ${
                  t("nodes")
                } (tenant, collection, id, doc) SELECT ${T}, ` +
                  `${collection}, ${bind(seed._id)}, ${bind(JSON.stringify(seed))}::jsonb WHERE ` +
                  `${ok} AND NOT EXISTS (SELECT 1 FROM prev${n}) RETURNING id, doc, n)`,
              );
            }
            changes = `SELECT id, before, after, n AS ord FROM upd${n}` +
              (seed ? ` UNION ALL SELECT id, NULL::jsonb, doc, n FROM ins${n}` : "");
            select.push(
              `(SELECT count(*) FROM prev${n})::int AS matched${n}`,
              `(SELECT count(*) FROM upd${n})::int AS modified${n}`,
            );
            break;
          }
          case "delete": {
            const collection = bind(op.collection);
            ctes.push(
              `del${n} AS (DELETE FROM ${t("nodes")} t WHERE t.tenant = ${T} AND t.collection = ` +
                `${collection} AND t.id = ANY (ARRAY (SELECT id FROM ${t("nodes")} WHERE ${ok} ` +
                `AND tenant = ${T} AND collection = ${collection} AND ` +
                `${where(op.filter, postgres, bind)}` +
                `${page(op.options.many ? {} : { limit: 1 }, postgres, bind)})) RETURNING t.id, ` +
                `t.doc, t.n)`,
            );
            changes = `SELECT id, doc AS before, NULL::jsonb AS after, n AS ord FROM del${n}`;
            select.push(`(SELECT count(*) FROM del${n})::int AS deleted${n}`);
            break;
          }
          case "link":
            ctes.push(
              `w${n} AS (INSERT INTO ${t("edges")} (tenant, "from", type, "to", data) SELECT ` +
                `${T}, ${bind(op.edge.from)}, ${bind(op.edge.type)}, ${bind(op.edge.to)}, ` +
                `${
                  bind(op.edge.data === undefined ? null : JSON.stringify(op.edge.data))
                }::jsonb ` +
                `WHERE ${ok} ON CONFLICT (tenant, "from", type, "to") DO UPDATE SET data = ` +
                `EXCLUDED.data)`,
            );
            break;
          case "unlink":
            ctes.push(
              `w${n} AS (DELETE FROM ${t("edges")} WHERE ${ok} AND tenant = ${T} AND "from" = ${
                bind(op.edge.from)
              } AND type = ${bind(op.edge.type)} AND "to" = ${bind(op.edge.to)})`,
            );
            break;
        }
        seeds.push(seed);
        if (!changes || !("collection" in op)) continue;
        ctes.push(`changes${n} AS (${changes})`);
        select.push(
          `(SELECT jsonb_agg(jsonb_build_object('_id', id, 'before', before, 'after', after) ` +
            `ORDER BY ord) FROM changes${n}) AS changes${n}`,
        );
        if (!record) continue;
        const keys = (of: string, condition: string) =>
          `(SELECT coalesce(jsonb_agg(k ORDER BY k COLLATE "C"), '[]'::jsonb) FROM ` +
          `jsonb_object_keys(${of}) AS k(k) WHERE ${condition})`;
        const changed = keys("after", "before -> k IS DISTINCT FROM after -> k");
        const removed = keys("before", "NOT after ? k");
        sources.push(
          `SELECT ${i} AS grp, row_number() OVER (ORDER BY ord) AS ord, ` +
            `gen_random_uuid()::text AS id, ${bind(op.collection)}::text || CASE WHEN before ` +
            `IS NULL THEN '.created' WHEN after IS NULL THEN '.deleted' ELSE '.updated' END ` +
            `AS type, CASE WHEN before IS NULL THEN jsonb_build_object('_id', id, 'doc', after) ` +
            `WHEN after IS NULL THEN jsonb_build_object('_id', id, 'doc', before) ELSE ` +
            `jsonb_build_object('_id', id, 'doc', after, 'changed', ${changed}, 'removed', ` +
            `${removed}) END AS data, ${bind(c.cause ?? null)}::text AS cause, ` +
            `${bind(c.actor ? JSON.stringify(c.actor) : null)}::jsonb AS actor FROM changes${n}`,
        );
      }
      const emits = unique(
        c.steps.flatMap((step, i) =>
          "emit" in step ? [{ ...step.emit, id: step.emit.id ?? crypto.randomUUID(), i }] : []
        ),
      );
      if (emits.length) {
        const values = emits.map((e) =>
          `(${e.i}, 0, ${bind(e.id)}::text, ${bind(e.type)}::text, ` +
          `${bind(JSON.stringify(e.data))}::jsonb, ${bind(e.cause ?? null)}::text, ` +
          `${bind(e.actor ? JSON.stringify(e.actor) : null)}::jsonb)`
        );
        sources.push(
          `SELECT * FROM (VALUES ${values.join(", ")}) e(grp, ord, id, type, data, cause, actor)`,
        );
      }
      if (c.blobs.length) {
        const values = c.blobs.map((b) =>
          `(${bind(b.id)}::text, ${bind(b.data)}::bytea, ${bind(b.type ?? null)}::text)`
        );
        ctes.push(
          `b AS (INSERT INTO ${t("blobs")} (tenant, id, data, type) SELECT ${T}, v.id, v.data, ` +
            `v.type FROM (VALUES ${values.join(", ")}) v(id, data, type) WHERE ${ok} ON CONFLICT ` +
            `DO NOTHING)`,
        );
      }
      if (sources.length) {
        ctes.push(
          `ev AS (${
            appending(
              `SELECT u.*, ${bind(at)}::text AS at FROM (${sources.join(" UNION ALL ")}) u`,
              "x.grp, x.ord",
              take(alone ? "alone" : emits.length + recorded),
              ok,
            )
          } RETURNING seq, id, type, data, cause, actor, at)`,
        );
        select.push(`(SELECT jsonb_agg(to_jsonb(ev) ORDER BY seq) FROM ev) AS events`);
      }
      const pos = saving(c.positions ?? {}, bind, ` WHERE ${ok}`);
      if (pos) ctes.push(pos);
      let row: Row;
      try {
        [row] = await run(writer, `WITH ${ctes.join(", ")} SELECT ${select.join(", ")}`, params);
      } catch (error) {
        // Whether its events went in may be unknown: what ran alone moves past what the log holds.
        if (alone && last !== undefined) last = Math.max(last, await load().catch(() => last!));
        // A duplicate _id fails the statement on the primary key.
        throw await conflict(error, inserted);
      }
      if (Number(row.epoch) !== owner) throw fenced();
      const events = ((row.events ?? []) as Row[]).map((e): Event => ({
        seq: Number(e.seq),
        id: String(e.id),
        type: String(e.type),
        data: e.data as Record<string, unknown>,
        ...(e.cause === null ? {} : { cause: String(e.cause) }),
        ...(e.actor == null ? {} : { actor: e.actor as Event["actor"] }),
        at: String(e.at),
      }));
      if (alone) numbered(events.map((e) => e.seq));
      const results = writes.map(({ write: op }, n) => {
        const matched = Number(row[`matched${n}`] ?? 0);
        const seed = seeds[n];
        return op.op === "update"
          ? (seed && !matched
            ? { matched: 0, modified: 0, upsertedId: seed._id }
            : { matched, modified: Number(row[`modified${n}`]) })
          : op.op === "replace"
          ? (seed && !matched ? { matched: 0, upsertedId: seed._id } : { matched })
          : op.op === "delete"
          ? Number(row[`deleted${n}`])
          : undefined;
      });
      const changes = writes.map((_, n) => (row[`changes${n}`] ?? []) as Change[]);
      return { results, events, changes };
    });
  };

  return {
    ...reader(committed),
    command,
    // Alone: the writes before it end first.
    open: () =>
      gate(true, async () => {
        last = undefined;
        const [row] = await run(
          writer,
          `INSERT INTO ${t("meta")} (tenant, key, value) VALUES (${T}, 'epoch', 1) ON CONFLICT ` +
            `(tenant, key) DO UPDATE SET value = meta.value + 1 RETURNING value`,
        );
        // Then the log: whoever wrote last may have been another owner, who can't any more.
        last = await load();
        return { epoch: Number(row.value) };
      }),
    async positions() {
      const rows = await run(
        committed,
        `SELECT key, value FROM ${t("meta")} WHERE tenant = ${T} AND key LIKE 'position:%'`,
      );
      return Object.fromEntries(
        rows.map((row) => [String(row.key).slice("position:".length), Number(row.value)]),
      );
    },
    transaction: (owner, work, options = {}) =>
      gate(false, async () => {
        const positions = options.positions ?? {};
        // The database transaction opens with the command's first statement. A
        // command that only records events (an action's completion, say) needs
        // none: its events go in as one fenced statement, atomic on its own.
        const emitted: Omit<Event, "seq" | "at">[] = [];
        let open:
          | { tx: Promise<Session>; done: PromiseWithResolvers<void>; settled: Promise<void> }
          | undefined;
        const begin = () => {
          if (closed) throw new Error("This store is closed.");
          if (!open) {
            const ready = Promise.withResolvers<Session>();
            const done = Promise.withResolvers<void>();
            done.promise.catch(() => {});
            const settled = writer.transaction(async (tx: Session) => {
              // Unparameterized, so Ominipg sends it together with BEGIN. FOR SHARE
              // waits for a newer owner's claim to settle, then sees it.
              const [fence] = await run(
                tx,
                `SELECT value FROM ${t("meta")} WHERE tenant = ${T} AND key = 'epoch' FOR SHARE`,
              );
              if (Number(fence?.value) !== owner) throw fenced();
              ready.resolve(tx);
              await done.promise;
            });
            settled.catch((error) => ready.reject(error));
            ready.promise.catch(() => {});
            open = { tx: ready.promise, done, settled };
          }
          return open.tx;
        };
        const lazy: Session = { query: async (sql, params) => (await begin()).query(sql, params) };
        const held: Held = { docs: [], blobs: [] };
        // What the last statement inserts, to name a duplicate _id if it fails.
        let inserting: [string, Doc][] = [];
        try {
          const scope = transaction(lazy, emitted, held);
          const result = await work(scope);
          const events = unique(emitted);
          const writes = events.length || Object.keys(positions).length ||
            held.docs.length || held.blobs.length;
          inserting = held.docs;
          if (!open) {
            if (writes) return { result, events: await append(owner, events, positions, held) };
            // Nothing to write: still tell a fenced owner so.
            const [fence] = await run(
              writer,
              `SELECT value FROM ${t("meta")} WHERE tenant = ${T} AND key = 'epoch'`,
            );
            if (Number(fence?.value) !== owner) throw fenced();
            return { result, events: [] };
          }
          const tx = await open.tx;
          const finish = (tx as { finish?: Finish }).finish;
          if (finish && writes) {
            // Ominipg 0.11.2+: the last statement and COMMIT go in one round trip.
            // It must carry no parameters, so its values are written as literals.
            const at = new Date().toISOString();
            const sql = final(events, positions, at, held);
            statements++;
            trace?.(sql);
            const { rows } = await finish.call(tx, sql);
            open.done.resolve();
            await open.settled;
            return {
              result,
              events: events.length
                ? committedEvents(events, at, rows as { id: string; seq: number }[])
                : [],
            };
          }
          await scope.flush();
          const recorded = await record(tx, events, positions);
          open.done.resolve();
          await open.settled;
          statements++; // COMMIT
          return { result, events: recorded };
        } catch (error) {
          if (open) {
            open.done.reject(error);
            await open.settled.catch(() => {});
          }
          throw await conflict(error, inserting);
        }
      }),
    async index(collections) {
      const wanted = new Map<string, string>();
      for (const [collection, specs] of Object.entries(collections)) {
        scalars.set(
          collection,
          new Map(specs.flatMap((spec) => spec.fields.map((f) => [f.path, f.type] as const))),
        );
        for (const spec of specs) {
          const name = indexName(collection, spec.fields.map((f) => f.path));
          wanted.set(
            name,
            `CREATE INDEX IF NOT EXISTS ${ident(name)} ON ${t("nodes")} (tenant, ` +
              `${spec.fields.map((f) => `${scalar(f.path, f.type)} NULLS FIRST`).join(", ")}) ` +
              `WHERE collection = ${literal(collection)}`,
          );
        }
      }
      // A schema's indexes serve all its tenants: this process makes them once.
      const known = remembered(pool);
      const key = `${schema}\u0000indexes`;
      const signature = [...wanted.keys()].sort().join(",");
      if (known.get(key) === signature) return;
      // Making an index that exists still locks the table against writes: only missing ones.
      const existing = new Set(
        (await run(
          writer,
          `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'nodes' ` +
            `AND indexname LIKE 'ix\\_%'`,
          [schema],
        )).map((row) => String(row.indexname)),
      );
      for (const [name, ddl] of wanted) if (!existing.has(name)) await run(writer, ddl);
      // Indexes no longer declared go, from a schema of its own: tenants sharing one may run
      // other versions of the app, which still declare them.
      const stale = [...existing].filter((name) => !wanted.has(name));
      if (stale.length && !(await others(counted(writer), schema, tenant))) {
        for (const name of stale) {
          await run(writer, `DROP INDEX IF EXISTS ${ident(schema)}.${ident(name)}`);
        }
      }
      known.set(key, signature);
    },
    /**
     * One view per collection for the schema, showing the rows of one tenant:
     * the session's `copilotz.tenant` setting, else "" (a schema's only
     * tenant), so `SELECT * FROM message` reads as before. A view can't keep
     * a tenant from the tables beside it, so the views are for reading, not
     * a boundary. One set serves every tenant (not a set each, which would
     * grow the catalog with the tenants), and it changes only when a
     * collection's fields do.
     */
    async describe(collections) {
      const views = Object.entries(collections)
        .filter(([name]) => !(TABLES as readonly string[]).includes(name))
        .map(([name, def]) => {
          const fields = Object.keys(
            (def as { properties?: Record<string, unknown> }).properties ?? {},
          ).filter((field) => field !== "_id");
          const columns = fields.map((field) => `doc ->> ${literal(field)} AS ${ident(field)}`);
          const sql = `SELECT ${["id AS _id", ...columns].join(", ")} FROM ${t("nodes")} ` +
            `WHERE tenant = coalesce(current_setting('copilotz.tenant', true), '') AND ` +
            `collection = ${literal(name)} ORDER BY n`;
          return { name, sql, note: `copilotz ${hash(sql)}` };
        });
      const known = remembered(pool);
      const key = `${schema}\u0000views`;
      const signature = views.map((view) => `${view.name}:${view.note}`).join(",");
      if (known.get(key) === signature) return;
      /** The views not as described: missing, or another definition. A table's name is skipped. */
      const stale = async (db: Session) => {
        const { rows } = await db.query(
          `SELECT c.relname AS name, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS ` +
            `note FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE ` +
            `s.nspname = $1 AND c.relname = ANY($2::text[])`,
          [schema, views.map((view) => view.name)],
        );
        const found = new Map(rows.map((row) => [String(row.name), row]));
        return views.filter((view) => {
          const it = found.get(view.name);
          return !it || (it.kind === "v" && it.note !== view.note);
        });
      };
      if ((await stale(counted(committed))).length) {
        await writer.transaction(async (tx: Session) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `copilotz:${schema}:views`,
          ]);
          for (const view of await stale(tx)) {
            const name = t(ident(view.name));
            await tx.query(`DROP VIEW IF EXISTS ${name}`);
            await tx.query(`CREATE VIEW ${name} AS ${view.sql}`);
            await tx.query(`COMMENT ON VIEW ${name} IS ${literal(view.note)}`);
          }
        });
      }
      known.set(key, signature);
    },
    async inspect(sql) {
      // Any SQL can reach the tables, and so other tenants' rows: only in a schema of its own.
      if (await others(counted(committed), schema, tenant)) {
        throw Object.assign(
          new Error("This store shares its schema with other tenants: it can't be inspected."),
          { code: "shared_schema" },
        );
      }
      return await committed.transaction(async (tx: Session) => {
        // The views show this tenant, and unqualified names are the schema's.
        await tx.query(
          `SELECT set_config('copilotz.tenant', ${T}, true), set_config('search_path', ` +
            `${constant(`${ident(schema)}, public`)}, true)`,
        );
        return (await tx.query(sql)).rows;
      }, { readOnly: true });
    },
    roundTrips: () => statements,
    close,
    /**
     * Deletes everything this store holds, then closes: a tenant gone for
     * good. Its schema goes with it when no other tenant is in it.
     */
    async drop() {
      if (await others(counted(writer), schema, tenant)) {
        await dropTenant({ pool, schema, tenant });
      } else {
        await run(writer, `DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
        forget(pool, schema);
      }
      await close();
    },
  };
}
