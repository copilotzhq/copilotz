/**
 * The store's lease (`lease`, stores/sql/postgres/lease.ts): one process at a
 * time holds it; the next waits, and asks the holder to hand over when it's
 * at least as new; an older one waits without asking; a holder that can't
 * keep it hears it's lost. Two leases on one pool stand for two processes.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { lease, type PostgresPool, postgresPool } from "../sql/postgres/mod.ts";
import { env, test } from "../../testing/mod.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
/** Where pools connect: PGlite in memory (a new database for each pool), and the server. */
const databases: Record<string, string> = {
  pglite: ":memory:",
  ...(POSTGRES ? { postgres: POSTGRES } : {}),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for `done` to say yes, for up to 5 s. */
async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 100 && !done(); i++) await sleep(50);
  assert(done(), what);
}

/** A pool and a schema of its own for one test, dropped after it. */
async function withPool(url: string, run: (pool: PostgresPool, schema: string) => Promise<void>) {
  const pool = await postgresPool({ url, writes: 2, reads: 1 });
  const schema = `lease_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await run(pool, schema);
  } finally {
    await pool.writes.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.close();
  }
}

for (const [db, url] of Object.entries(databases)) {
  test(`lease (${db}): the next process waits for it, then takes it once it's let go`, () =>
    withPool(url, async (pool, schema) => {
      const lost: string[] = [];
      const first = await lease(pool, { schema, ttlMs: 600, lost: (why) => lost.push(why) });
      let waited = 0;
      let taken = false;
      const second = lease(pool, {
        schema,
        ttlMs: 600,
        waiting: () => waited++,
        lost: (why) => lost.push(why),
      }).then((held) => (taken = true, held));
      await until(() => waited > 0, "the second one waits");
      await sleep(700);
      assertEquals(taken, false, "not while the first renews it");
      assertEquals(waited, 1, "said once");
      await first.release();
      await (await second).release();
      assertEquals(lost, []);
    }));

  test(`lease (${db}): a newer process asks the holder to hand over, once`, () =>
    withPool(url, async (pool, schema) => {
      let asked = 0;
      const holder = await lease(pool, {
        schema,
        revision: 5,
        ttlMs: 600,
        asked: () => asked++,
        lost: () => {},
      });
      const newer = lease(pool, { schema, revision: 6, ttlMs: 600, lost: () => {} });
      await until(() => asked > 0, "the holder is asked");
      await sleep(500);
      assertEquals(asked, 1);
      await holder.release();
      await (await newer).release();
    }));

  test(`lease (${db}): an older process (a restart of the one handing over) waits without asking`, () =>
    withPool(url, async (pool, schema) => {
      let asked = 0;
      const holder = await lease(pool, {
        schema,
        revision: 5,
        ttlMs: 600,
        asked: () => asked++,
        lost: () => {},
      });
      let waited = false;
      const older = lease(pool, {
        schema,
        revision: 4,
        ttlMs: 600,
        waiting: () => waited = true,
        lost: () => {},
      });
      await until(() => waited, "the older one waits");
      await sleep(700);
      assertEquals(asked, 0);
      await holder.release();
      await (await older).release();
    }));

  test(`lease (${db}): one waiting stops when its signal aborts`, () =>
    withPool(url, async (pool, schema) => {
      const holder = await lease(pool, { schema, ttlMs: 600, lost: () => {} });
      const stop = new AbortController();
      let waited = false;
      const waiting = lease(pool, {
        schema,
        ttlMs: 600,
        signal: stop.signal,
        waiting: () => waited = true,
        lost: () => {},
      });
      await until(() => waited, "it waits");
      stop.abort(new Error("stopped"));
      await assertRejects(() => waiting, Error, "stopped");
      await holder.release();
    }));

  test(`lease (${db}): a holder another process took it from hears it's lost`, () =>
    withPool(url, async (pool, schema) => {
      const lost: string[] = [];
      const held = await lease(pool, { schema, ttlMs: 600, lost: (why) => lost.push(why) });
      await pool.writes.query(
        `UPDATE "${schema}".copilotz_lease SET holder = 'another', ` +
          "until = now() + interval '1 minute'",
      );
      await until(() => lost.length > 0, "it's lost");
      assertEquals(lost, ["another process holds it"]);
      // Letting go of a lease lost leaves the other's alone.
      await held.release();
      const { rows } = await pool.writes.query(`SELECT holder FROM "${schema}".copilotz_lease`);
      assertEquals(rows, [{ holder: "another" }]);
    }));

  test(`lease (${db}): one let go is gone, though a renewal was under way`, () =>
    withPool(url, async (pool, schema) => {
      for (let i = 0; i < 5; i++) {
        const held = await lease(pool, { schema, ttlMs: 30, lost: () => {} });
        await sleep(10 + i * 5);
        await held.release();
        await sleep(30);
        const { rows } = await pool.writes.query(`SELECT 1 FROM "${schema}".copilotz_lease`);
        assertEquals(rows.length, 0);
      }
    }));
}
