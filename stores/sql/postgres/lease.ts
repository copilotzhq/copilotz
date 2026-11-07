/**
 * One process at a time writes a database: a lease, a row renewed every few
 * seconds, taken before the process opens its stores and let go when it
 * stops; the next process waits for it.
 *
 * A store's epoch already fences an owner another has taken over, but a
 * deploy runs two processes for a while: the new one starts while the old
 * one still serves its browsers' sockets (Cloud Run keeps a retired revision
 * running for as long as a socket stays open), and every write those
 * browsers send is then refused. With the lease, the new process waits and
 * marks it wanted; the holder hears so as it renews (`asked`) and hands over:
 * it stops listening (its sockets close, and browsers reconnect, to the new
 * process), finishes what's running, and lets go. `serve`
 * (`copilotz/web/node`) does all of that.
 *
 * Only a process of a revision at least as new as the holder's asks: the
 * platform may restart the old revision's process while traffic moves over,
 * and that one would otherwise ask for it back. A script that writes while
 * the app runs (a data load) takes it with a revision above any deploy's
 * (`Number.MAX_SAFE_INTEGER`): the app hands over, waits, and takes it back
 * once the script lets go.
 *
 * A process that can't renew it in time has lost it: `lost` says so, and the
 * process stops rather than write beside another.
 */
import type { PostgresPool } from "./pool.ts";

/** A lease held. */
export type Lease = {
  /** Stops renewing it and lets it go, for the next process. */
  release(): Promise<void>;
};

export type LeaseOptions = {
  /** The schema its table (`copilotz_lease`) is in: `public` by default. */
  schema?: string;
  /** What's held: one per deployment sharing the database. `app` by default. */
  name?: string;
  /** How long it lasts unrenewed, in ms: 15 000 by default. It's renewed every third of it. */
  ttlMs?: number;
  /**
   * Which deploy this process is, a number each deploy raises (Cloud Run's
   * revision's: `app-00015-8bs` is 15): a process asks no newer one to hand
   * over. 0 by default.
   */
  revision?: number;
  /** Stops waiting for it: `lease` rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Said once, when another process holds it and this one waits. */
  waiting?: () => void;
  /** Another process waits for it: close what's open, then let it go. Said once. */
  asked?: () => void;
  /** It was lost: renewing failed past its time, or another process holds it. */
  lost: (why: string) => void;
};

/** How often a waiting process tries again, in ms, at most. */
const RETRY = 1_000;

/** Takes the lease, once the process holding it lets go (or its time runs out). */
export async function lease(pool: PostgresPool, options: LeaseOptions): Promise<Lease> {
  const name = options.name ?? "app";
  const ttl = options.ttlMs ?? 15_000;
  const revision = options.revision ?? 0;
  const holder = crypto.randomUUID();
  const db = pool.writes;
  const schema = options.schema ?? "public";
  const quoted = `"${schema.replaceAll('"', '""')}"`;
  const table = `${quoted}.copilotz_lease`;
  // A schema made already is left as it is: making one needs a right on the database the
  // process's role may not have.
  const { rows: found } = await db.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
  if (!found.length) await db.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${table} (name text PRIMARY KEY, holder text NOT NULL, ` +
      "until timestamptz NOT NULL, wanted timestamptz, revision bigint)",
  ).catch(async () => {
    // Two processes making it at once: one wins, and it's there for both.
    await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
  });

  /**
   * Takes it, or renews it: this process's when it's free, run out, or its
   * own already. Says whether another process wants it (within its time).
   */
  const take = async () => {
    const { rows } = await db.query(
      `INSERT INTO ${table} AS l (name, holder, until, revision) ` +
        "VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4) " +
        "ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until, " +
        "revision = EXCLUDED.revision, " +
        "wanted = CASE WHEN l.holder = EXCLUDED.holder THEN l.wanted END " +
        "WHERE l.until < now() OR l.holder = EXCLUDED.holder " +
        "RETURNING coalesce(wanted > now() - $3 * interval '1 millisecond', false) AS wanted",
      [name, holder, ttl, revision],
    );
    return rows.length ? { wanted: Boolean((rows[0] as { wanted: unknown }).wanted) } : undefined;
  };

  let told = false;
  while (!await take()) {
    options.signal?.throwIfAborted();
    if (!told) options.waiting?.();
    told = true;
    // The holder hears it's wanted as it renews, unless it's newer than this process.
    await db.query(
      `UPDATE ${table} SET wanted = now() ` +
        "WHERE name = $1 AND holder <> $2 AND coalesce(revision, 0) <= $3",
      [name, holder, revision],
    ).catch(() => {});
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(RETRY, Math.floor(ttl / 3)));
      options.signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", done);
        resolve();
      }
    });
    options.signal?.throwIfAborted();
  }

  let renewed = Date.now();
  let asked = false;
  let over = false;
  /** The renewal under way, if any: one at a time, and none once it's let go. */
  let renewing: Promise<void> | undefined;
  const renew = async () => {
    try {
      const held = await take();
      if (over) return;
      if (!held) {
        over = true;
        clearInterval(timer);
        options.lost("another process holds it");
        return;
      }
      renewed = Date.now();
      if (held.wanted && !asked) {
        asked = true;
        options.asked?.();
      }
    } catch (error) {
      if (!over && Date.now() - renewed > ttl) {
        over = true;
        clearInterval(timer);
        options.lost(`it couldn't be renewed: ${(error as Error).message}`);
      }
    }
  };
  const timer = setInterval(() => {
    renewing ??= renew().finally(() => renewing = undefined);
  }, Math.floor(ttl / 3));
  return {
    async release() {
      if (over) return;
      over = true;
      clearInterval(timer);
      // A renewal under way would write the row back after it's gone.
      await renewing;
      await db.query(`DELETE FROM ${table} WHERE name = $1 AND holder = $2`, [name, holder])
        .catch(() => {});
    },
  };
}
