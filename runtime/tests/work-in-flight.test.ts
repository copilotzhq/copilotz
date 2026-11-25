/**
 * The queries docs/operations/stores.md gives an app's operators for work in
 * flight, run as the page has them: through maintenance, and on the store's own
 * file or database, as `sqlite3` or `psql` reads it (after the page's
 * `SET search_path`, on PostgreSQL).
 */
import { assert, assertEquals } from "@std/assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, defineAction, type Store } from "../mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../stores/sql/postgres/mod.ts";
import { postgresPool } from "../../stores/sql/postgres/pool.ts";
import { runtime as host, tempDir, tempFile, test } from "../../testing/mod.ts";

// Git may check the page out with CRLF line endings (Windows).
const page = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../docs/operations/stores.md"),
  "utf8",
).replaceAll("\r\n", "\n");
const section = page.slice(page.indexOf("### Work in flight"));
/** The page's statements, in order, without their comments. */
const queries = /```sql\n([\s\S]*?)```/.exec(section)![1].split(";")
  .map((sql) => sql.replace(/^--.*$/gm, "").trim()).filter(Boolean);
/** What the page says to run first in `psql`. */
const searchPath = /`(SET search_path TO [a-z_]+);`/.exec(section)![1];

type Row = Record<string, unknown>;

/** The store's SQLite file, read as `sqlite3` reads it; closed after, as Windows keeps open files. */
async function sqliteFile(path: string): Promise<{ read: (sql: string) => Row[]; close(): void }> {
  // Not literal, so no checker resolves another runtime's module.
  const BUN_SQLITE = "bun:sqlite";
  if (host === "bun") {
    const { Database } = await import(BUN_SQLITE);
    const db = new Database(path, { readonly: true });
    return { read: (sql) => db.prepare(sql).all() as Row[], close: () => db.close() };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return { read: (sql) => db.prepare(sql).all() as Row[], close: () => db.close() };
}

/** Work left in flight: a delivery cut short, a failed call, a timer occurrence waiting to retry. */
async function leaveWork(store: Store) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const runtime = await createRuntime({
    store,
    plugins: [{
      name: "shop",
      events: { "order.placed": { schema: { type: "object" } } },
      actions: {
        place: defineAction({ run: (ctx) => ctx.emit("order.placed", {}) }),
        done: defineAction({ run: () => 1 }),
        fails: defineAction({
          run: () => {
            throw new Error("no");
          },
        }),
        remind: defineAction({
          run: () => {
            throw new Error("not yet");
          },
        }),
        arm: defineAction({
          run: (ctx) =>
            ctx.schedule("remind", {}, { at: new Date(Date.now() + 30).toISOString(), id: "r1" }),
        }),
      },
      processors: { "shop.waits": { on: "order.placed", run: () => gate } },
    }],
  });
  try {
    await runtime.call("done", {}, { id: "done-1" });
    await runtime.call("fails", {}, { id: "failed-1" }).catch(() => {});
    await runtime.call("arm", {});
    await runtime.call("place", {});
    // The occurrence fails, and its retry waits; the Processor's position is saved.
    const retries = () => runtime.maintenance.read(queries[2]).then(({ rows }) => rows.length);
    for (let i = 0; i < 150 && !await retries(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { runtime, release };
  } catch (error) {
    release();
    await runtime.close({ drain: 0 });
    throw error;
  }
}

/** The page's queries through maintenance (`/maintenance/sql`), one at a time, as it takes them. */
async function throughMaintenance(runtime: Awaited<ReturnType<typeof createRuntime>>) {
  const found: Row[][] = [];
  for (const sql of queries) found.push((await runtime.maintenance.read(sql)).rows);
  return found;
}

/** What each query found says: a Processor behind, two calls not completed, one retry waiting. */
function check(found: Row[][]) {
  const [positions, calls, retries] = found;
  const waits = positions.find((row) => row.processor === "shop.waits");
  assert(waits && Number(waits.position) < Number(waits.last), JSON.stringify(positions));
  const ids = calls.map((row) => String(row.id));
  assert(ids.includes("failed-1"), ids.join());
  assert(ids.some((id) => id.startsWith("r1@")), ids.join());
  assert(!ids.includes("done-1"), ids.join());
  assertEquals(retries.map((row) => String(row.id).split("@")[0]), ["r1"]);
}

test("the page's queries find work in flight: SQLite, through maintenance and sqlite3", async () => {
  const path = tempFile(".sqlite");
  const store = await sqliteStore({ path });
  const { runtime, release } = await leaveWork(store);
  try {
    check(await throughMaintenance(runtime));
  } finally {
    await runtime.close({ drain: 0 });
    release();
  }
  const file = await sqliteFile(path);
  try {
    check(queries.map(file.read));
  } finally {
    file.close();
  }
});

test("the page's queries find work in flight: PGlite, through maintenance and as psql", async () => {
  const url = `file://${tempDir()}`;
  const store = await postgresStore({ url });
  const { runtime, release } = await leaveWork(store);
  try {
    check(await throughMaintenance(runtime));
  } finally {
    await runtime.close({ drain: 0 });
    release();
  }
  // A session of its own, as psql's: nothing set but what the page says.
  const pool = await postgresPool({ url });
  try {
    await pool.writes.query(searchPath);
    const found: Row[][] = [];
    for (const sql of queries) found.push((await pool.writes.query(sql)).rows as Row[]);
    check(found);
  } finally {
    await pool.close();
  }
});
