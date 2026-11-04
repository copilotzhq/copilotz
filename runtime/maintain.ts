/**
 * Maintenance: SQL beside the collections, for an app's operators when they
 * can't reach its database themselves (a client's network that keeps their
 * database user out). Only trusted host code reaches it, through the owner
 * (`runtime.maintenance`): the maintenance plugin's routes. Plugin code
 * never runs SQL; nothing on its `ctx` does.
 *
 * - `read`: one read-only statement on committed state (the store's
 *   `inspect`), in a transaction that can't write, at most `limit` rows.
 * - `write`: one statement that writes, for what the collections'
 *   operations can't do. It runs in line with the owner's other writes,
 *   alone (the writes running end first, the next wait for it), in a
 *   transaction fenced by the owner's epoch: an owner that lost the store
 *   can't run it. Its audit event, `maintenance.sql` (the statement, its
 *   params, the rows it changed, by whom), commits with it, or neither does.
 *   An `id` makes it safe to send again: one already on record answers from
 *   its event, without running again.
 *
 *   It bypasses the collections' schemas and records no per-document
 *   events: Processors hear only `maintenance.sql`. The owner can't know
 *   what it changed, so it forgets what it derived from documents: the read
 *   cache empties, observed Views (screens, browsers' reads) run again, and
 *   the clock looks at the timers again. Not refreshed: Processors'
 *   positions and the fencing epoch (`meta`, read when the owner starts:
 *   leave them be), in-memory collections (`durable: false`: no SQL reaches
 *   them), and what plugin code keeps in memory of its own.
 * - `blob`: a blob's bytes and type, by id, from wherever blobs live.
 */
import { type Blobs, hydrate, offload } from "./blobs.ts";
import { canonical } from "./registry.ts";
import type { Actor, Blob, Event, Row, Store } from "./store.ts";

/** The audit event of a maintenance write. */
export const MAINTENANCE_SQL = "maintenance.sql";

export type Maintenance = {
  /** Whether the store runs SQL (a SQL store; PostgreSQL in a schema of its own). */
  readonly sql: boolean;
  /** One read-only statement: its rows, at most `limit`, and whether there were more. */
  read(
    sql: string,
    options?: { params?: unknown[]; limit?: number; timeout?: number },
  ): Promise<{ rows: Row[]; truncated: boolean }>;
  /** One statement that writes, as `actor`, with its audit event (see above). */
  write(
    sql: string,
    options: { actor: Actor; params?: unknown[]; limit?: number; timeout?: number; id?: string },
  ): Promise<Written>;
  /** A blob, by id (`sha256-…`); null when there's none. */
  blob(id: string): Promise<Blob | null>;
};

export type Written = {
  /** What it returned (`RETURNING`), at most `limit`; none when `repeated`. */
  rows: Row[];
  truncated: boolean;
  /** Rows it inserted, updated or deleted, in every table. */
  changed: number;
  /** Its audit event. */
  event: Event;
  /** It was on record already, by its id: nothing ran. */
  repeated?: true;
};

const unsupported = () =>
  Object.assign(
    new Error(
      "This store doesn't run SQL (a memory store): the collections' operations still work.",
    ),
    { code: "unsupported" },
  );

const conflict = (id: string) =>
  Object.assign(new Error(`Id "${id}" was already used for another statement.`), {
    code: "id_conflict",
  });

export function createMaintenance(env: {
  store: Store;
  epoch: number;
  blobs?: Blobs;
  blobThreshold?: number;
  /**
   * A write committed that nothing can follow: forget what came from
   * documents, then publish its events.
   */
  wrote(events: Event[]): void;
}): Maintenance {
  const { store, epoch } = env;
  const sql = typeof store.inspect === "function";
  const params = (given: unknown[] | undefined) => {
    if (given !== undefined && !Array.isArray(given)) {
      throw Object.assign(new Error("params is a list"), { code: "invalid" });
    }
    return given ?? [];
  };
  const cut = (rows: Row[], limit?: number) =>
    limit !== undefined && rows.length > limit
      ? { rows: rows.slice(0, limit), truncated: true }
      : { rows, truncated: false };

  return {
    sql,

    async read(statement, options = {}) {
      if (!sql) throw unsupported();
      const { limit, timeout } = options;
      // One more than asked says whether there were more.
      const rows = await store.inspect!(statement, params(options.params), {
        ...(limit !== undefined ? { limit: limit + 1 } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      });
      return cut(rows, limit);
    },

    async write(statement, options) {
      if (!sql) throw unsupported();
      const { actor, id, limit, timeout } = options;
      const bound = params(options.params);
      const { result, events } = await store.transaction(epoch, async (tx) => {
        const blob = (ref: string) => env.blobs ? env.blobs.get(ref) : tx.blob(ref);
        if (id !== undefined) {
          const [prior] = (await tx.related(id, [MAINTENANCE_SQL])).filter((e) => e.id === id);
          if (prior) {
            const said = await hydrate(prior.data, blob);
            if (said.sql !== statement || canonical(said.params) !== canonical(bound)) {
              throw conflict(id);
            }
            return { rows: [], changed: Number(said.changed), prior };
          }
        }
        if (!tx.execute) throw unsupported();
        const started = performance.now();
        const done = await tx.execute(statement, bound, timeout !== undefined ? { timeout } : {});
        const ms = Math.round((performance.now() - started) * 100) / 100;
        const data = await offload(
          { sql: statement, params: bound, changed: done.changed, ms },
          (large) => env.blobs ? env.blobs.put(large) : tx.putBlob(large),
          env.blobThreshold,
        );
        tx.emit({ ...(id !== undefined ? { id } : {}), type: MAINTENANCE_SQL, data, actor });
        return { ...done, prior: undefined };
      }, { alone: true });
      if (result.prior) {
        return {
          rows: [],
          truncated: false,
          changed: result.changed,
          event: result.prior,
          repeated: true,
        };
      }
      env.wrote(events);
      const event = events.find((e) => e.type === MAINTENANCE_SQL)!;
      return { ...cut(result.rows, limit), changed: result.changed, event };
    },

    async blob(id) {
      if (!env.blobs) return await store.blob(id);
      const found = await env.blobs.get(id);
      return found && { id, ...found };
    },
  };
}
