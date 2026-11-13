/**
 * `serve`: an app through a deploy. It listens first and tells requests it's
 * starting while it waits for the store's lease; a newer process asks for
 * the lease and the older one hands over (stops listening, drains, lets
 * go); its signal stops it; a lost lease stops it too. The lease is the
 * Postgres store's, on PGlite; two serves on one pool stand for two
 * processes.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createServer } from "node:net";
import { lease, type PostgresPool, postgresPool } from "../../../../stores/sql/postgres/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { type App, serve } from "../mod.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A port the system has free, for a test that must know it before listening: one it hands out
 * itself, never one it keeps back (Windows reserves ranges, and refuses them: `EACCES`).
 */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 100 && !done(); i++) await sleep(50);
  assert(done(), what);
}

/** An app that says its name, and keeps how it was closed. */
function app(name: string, closed: number[]): App {
  return {
    fetch: () => new Response(name),
    close: (options) => (closed.push(options?.drain ?? -1), Promise.resolve()),
  };
}

/** What a request to `url` gets: its status and text, or "closed". */
const ask = (url: URL | string, init?: RequestInit) =>
  fetch(url, init).then(
    async (r) => ({ status: r.status, text: await r.text(), r }),
    () => "closed" as const,
  );

/** The lease on `pool`, as one deploy (`revision`) holds it. */
const holding = (pool: PostgresPool, revision: number) => (on: Parameters<typeof lease>[1]) =>
  lease(pool, { ttlMs: 600, revision, ...on });

async function withPool(run: (pool: PostgresPool) => Promise<void>) {
  const pool = await postgresPool({ url: ":memory:", writes: 2, reads: 1 });
  try {
    await run(pool);
  } finally {
    await pool.close();
  }
}

test("serve: while it waits for the lease, requests are told it's starting; then it serves", () =>
  withPool(async (pool) => {
    // A newer deploy holds it, and isn't asked. Its time is long: a slow runner that stalls
    // for a while must not see it run out, and the app open early.
    const other = await lease(pool, { revision: 9, ttlMs: 30_000, lost: () => {} });
    const port = await freePort();
    const closed: number[] = [];
    let opened = false;
    const serving = serve(() => (opened = true, Promise.resolve(app("new", closed))), {
      port,
      hold: holding(pool, 1),
    });
    try {
      let page: Awaited<ReturnType<typeof ask>> = "closed";
      for (let i = 0; i < 100 && page === "closed"; i++) {
        page = await ask(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
        if (page === "closed") await sleep(50);
      }
      assert(page !== "closed", "it listens while it waits");
      assertEquals(page.status, 503);
      assertEquals(page.r.headers.get("retry-after"), "2");
      assert(page.text.includes('http-equiv="refresh"'), page.text);
      const api = await ask(`http://127.0.0.1:${port}/connect`, { method: "POST" });
      assert(api !== "closed");
      assertEquals([api.status, JSON.parse(api.text)], [503, { error: "starting" }]);
      assertEquals(opened, false, "the app opens once it holds the lease");
    } finally {
      await other.release();
    }
    const served = await serving;
    const got = await ask(served.server.url);
    assert(got !== "closed");
    assertEquals([got.status, got.text], [200, "new"]);
    await served.stop();
    assertEquals(closed, [8_000]);
  }));

test("serve: a newer process asks; the older one stops listening, drains, lets go, and says 0", () =>
  withPool(async (pool) => {
    const closed: number[] = [];
    const stopped: number[] = [];
    const old = await serve(() => Promise.resolve(app("old", closed)), {
      hold: holding(pool, 1),
      drain: 50,
      stopped: (code) => stopped.push(code),
    });
    const fresh = await serve(() => Promise.resolve(app("new", [])), { hold: holding(pool, 2) });
    try {
      await until(() => stopped.length > 0, "the old one says it stopped");
      assertEquals(stopped, [0]);
      assertEquals(closed, [50]);
      assertEquals(await ask(old.server.url), "closed");
      const got = await ask(fresh.server.url);
      assert(got !== "closed");
      assertEquals(got.text, "new");
    } finally {
      await fresh.stop();
      await old.stop();
    }
    assertEquals(stopped, [0], "said once");
  }));

test("serve: its signal stops it; while it waits, it rejects and never opens", () =>
  withPool(async (pool) => {
    const other = await lease(pool, { revision: 9, ttlMs: 600, lost: () => {} });
    const sigterm = new AbortController();
    const stopped: number[] = [];
    let opened = false;
    let waited = false;
    const serving = serve(() => (opened = true, Promise.resolve(app("new", []))), {
      signal: sigterm.signal,
      hold: (on) =>
        holding(pool, 1)({
          ...on,
          waiting: () => {
            waited = true;
            on.waiting();
          },
        }),
      stopped: (code) => stopped.push(code),
    });
    await until(() => waited, "it waits");
    sigterm.abort();
    await assertRejects(() => serving, DOMException);
    await until(() => stopped.length > 0, "it says it stopped");
    assertEquals(stopped, [0]);
    assertEquals(opened, false);
    await other.release();

    // Once open, it stops the same way.
    const closed: number[] = [];
    const later = new AbortController();
    const served = await serve(() => Promise.resolve(app("app", closed)), {
      signal: later.signal,
      hold: holding(pool, 1),
      stopped: (code) => stopped.push(code),
    });
    later.abort();
    await until(() => stopped.length > 1, "it says it stopped");
    assertEquals(stopped, [0, 0]);
    assertEquals(closed, [8_000]);
    assertEquals(await ask(served.server.url), "closed");
    // Let go: another takes it at once.
    await (await lease(pool, { ttlMs: 600, lost: () => {} })).release();
  }));

test("serve: a lost lease stops it, and it says 1", () =>
  withPool(async (pool) => {
    const closed: number[] = [];
    const stopped: number[] = [];
    const served = await serve(() => Promise.resolve(app("app", closed)), {
      hold: holding(pool, 1),
      stopped: (code) => stopped.push(code),
    });
    await pool.writes.query(
      "UPDATE copilotz_lease SET holder = 'another', until = now() + interval '1 minute'",
    );
    await until(() => stopped.length > 0, "it stops");
    assertEquals(stopped, [1]);
    assertEquals(closed, [8_000]);
    assertEquals(await ask(served.server.url), "closed");
  }));

test("serve: without a lease, it listens and opens; an app that fails to open stops it", async () => {
  const served = await serve(() => Promise.resolve(app("app", [])));
  const got = await ask(served.server.url);
  assert(got !== "closed");
  assertEquals(got.text, "app");
  await served.stop();
  await assertRejects(() => serve(() => Promise.reject(new Error("no store"))), Error, "no store");
});
