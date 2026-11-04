/**
 * Maintenance SQL on the SQL stores: `inspect` reads one statement with its
 * parameters, at most `limit` rows, and can't write; a transaction's
 * `execute` runs one that writes, says how many rows it changed, and is
 * fenced like any commit. PostgreSQL runs it only alone and only in a
 * schema of its own, and cuts a read off at its timeout.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Store } from "../../runtime/store.ts";
import { memoryStore } from "../memory/mod.ts";
import { sqliteStore } from "../sql/sqlite/mod.ts";
import { postgresPool, postgresStore } from "../sql/postgres/mod.ts";
import { env, tempFile, test } from "../../testing/mod.ts";
import { pooled, schemaName } from "./pooled.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");

type Sql = Store & Required<Pick<Store, "inspect">>;
/** Two stores on one database: the second to open fences the first. */
type Pair = { dialect: "postgres" | "sqlite"; open(): Promise<[Sql, Sql]>; close(): Promise<void> };

const pairs: Record<string, () => Pair> = {
  sqlite: () => {
    const path = tempFile(".sqlite");
    return {
      dialect: "sqlite",
      open: async () => [await sqliteStore({ path }), await sqliteStore({ path })],
      close: () => Promise.resolve(),
    };
  },
  pglite: () => {
    let pool: Awaited<ReturnType<typeof postgresPool>>;
    return {
      dialect: "postgres",
      async open() {
        pool = await postgresPool({ url: ":memory:" });
        const schema = schemaName();
        return [await postgresStore({ pool, schema }), await postgresStore({ pool, schema })];
      },
      close: () => pool.close(),
    };
  },
  ...(POSTGRES
    ? {
      postgres: (): Pair => {
        const schema = schemaName();
        return {
          dialect: "postgres",
          open: async () => [
            await postgresStore({ url: POSTGRES, schema }),
            await postgresStore({ url: POSTGRES, schema }),
          ],
          // The tests close theirs: the schema goes with a store of its own.
          close: async () => await (await postgresStore({ url: POSTGRES, schema })).drop(),
        };
      },
    }
    : {}),
};

const code = (error: unknown) => (error as { code?: string }).code;

/** A note's text, set by SQL: each dialect's JSON. */
const setText = (dialect: string) =>
  dialect === "postgres"
    ? "UPDATE nodes SET doc = jsonb_set(doc, '{text}', to_jsonb($1::text)) WHERE collection = 'note'"
    : "UPDATE nodes SET doc = json_set(doc, '$.text', ?1) WHERE collection = 'note'";

for (const [name, make] of Object.entries(pairs)) {
  test(`${name}: inspect reads one statement, with parameters, up to a limit`, async () => {
    const pair = make();
    const [store, other] = await pair.open();
    await other.close();
    const { epoch } = await store.open();
    await store.describe?.({ note: { type: "object", properties: { text: { type: "string" } } } });
    await store.transaction(
      epoch,
      (tx) => tx.insert("note", [1, 2, 3, 4, 5].map((n) => ({ _id: `n${n}`, text: `t${n}`, n }))),
    );
    const p = pair.dialect === "postgres" ? "$1" : "?1";
    // The collection's view, and the tables beside it.
    assertEquals(await store.inspect(`SELECT _id, text FROM note WHERE _id = ${p}`, ["n2"]), [
      { _id: "n2", text: "t2" },
    ]);
    assertEquals(
      (await store.inspect("SELECT id FROM nodes ORDER BY id", [], { limit: 2 })).map((r) => r.id),
      ["n1", "n2"],
    );
    // What isn't a query a cursor can hold is cut to the limit too.
    const explain = pair.dialect === "postgres"
      ? "EXPLAIN SELECT * FROM nodes"
      : "PRAGMA table_info(nodes)";
    assert((await store.inspect(explain, [], { limit: 1 })).length === 1);
    // A trailing `;` and comment are fine; a second statement isn't.
    assertEquals((await store.inspect("SELECT 1 AS one; -- that's all"))[0].one, 1);
    assertEquals(code(await assertRejects(() => store.inspect("SELECT 1; SELECT 2"))), "invalid");
    // It can't write.
    assertEquals(
      code(await assertRejects(() => store.inspect(setText(pair.dialect), ["x"]))),
      "read_only",
    );
    // With a limit too (SQLite steps a refused write as if it had ended).
    assertEquals(
      code(await assertRejects(() => store.inspect(setText(pair.dialect), ["x"], { limit: 5 }))),
      "read_only",
    );
    assertEquals(code(await assertRejects(() => store.inspect("SELEC 1"))), "sql");
    assertEquals((await store.find("note", { _id: "n1" }))[0].text, "t1");
    await store.close();
    await pair.close();
  });

  test(`${name}: execute writes in its transaction, and says how many rows it changed`, async () => {
    const pair = make();
    const [store, other] = await pair.open();
    await other.close();
    const { epoch } = await store.open();
    await store.transaction(
      epoch,
      (tx) => tx.insert("note", [1, 2, 3].map((n) => ({ _id: `n${n}`, text: `t${n}` }))),
    );
    const { result, events } = await store.transaction(epoch, async (tx) => {
      const done = await tx.execute!(setText(pair.dialect), ["fixed"]);
      tx.emit({ type: "audit", data: { changed: done.changed } });
      return done;
    }, { alone: true });
    assertEquals(result, { rows: [], changed: 3 });
    assertEquals(events.map((e) => [e.type, e.data]), [["audit", { changed: 3 }]]);
    assertEquals((await store.find("note", {})).map((d) => d.text), ["fixed", "fixed", "fixed"]);
    // RETURNING rows come back; a statement that changes no rows changed none.
    const returning = await store.transaction(epoch, (tx) =>
      tx.execute!(
        pair.dialect === "postgres"
          ? "DELETE FROM nodes WHERE id = $1 RETURNING id"
          : "DELETE FROM nodes WHERE id = ?1 RETURNING id",
        ["n3"],
      ), { alone: true });
    assertEquals(returning.result, { rows: [{ id: "n3" }], changed: 1 });
    const none = await store.transaction(
      epoch,
      (tx) => tx.execute!("CREATE INDEX IF NOT EXISTS maintained ON nodes (id)"),
      { alone: true },
    );
    assertEquals(none.result.changed, 0);
    // A failing statement rolls its transaction back, events and all.
    await assertRejects(() =>
      store.transaction(epoch, async (tx) => {
        tx.emit({ type: "lost", data: {} });
        await tx.execute!("UPDATE nowhere SET x = 1");
      }, { alone: true })
    );
    assertEquals((await store.events(0)).filter((e) => e.type === "lost"), []);
    await store.close();
    await pair.close();
  });

  test(`${name}: execute can't run once another owner holds the store`, async () => {
    const pair = make();
    const [first, second] = await pair.open();
    const { epoch } = await first.open();
    await first.transaction(epoch, (tx) => tx.insert("note", [{ _id: "n1", text: "kept" }]));
    await second.open();
    const error = await assertRejects(() =>
      first.transaction(epoch, async (tx) => {
        await tx.execute!(setText(pair.dialect), ["lost"]);
        tx.emit({ type: "audit", data: {} });
      }, { alone: true })
    );
    assertEquals(code(error), "fenced");
    assertEquals((await second.find("note", {}))[0].text, "kept");
    assertEquals((await second.events(0)).filter((e) => e.type === "audit"), []);
    await first.close();
    await second.close();
    await pair.close();
  });
}

test("pglite: execute runs only alone, and events it adds keep their numbers", async () => {
  const store = await postgresStore({ url: ":memory:" });
  const { epoch } = await store.open();
  const error = await assertRejects(() =>
    store.transaction(epoch, (tx) => tx.execute!("SELECT 1"))
  );
  assertEquals(code(error), "invalid");
  const { events } = await store.transaction(epoch, async (tx) => {
    // Into the log, past what the store numbered.
    await tx.execute!(
      "INSERT INTO events (tenant, seq, id, type, data, at) VALUES ('', 1, 'by-sql', 'fixed', " +
        "'{}', '2026-11-03')",
    );
    tx.emit({ type: "audit", data: {} });
  }, { alone: true });
  assertEquals(events.map((e) => [e.type, e.seq]), [["audit", 2]]);
  const next = await store.transaction(epoch, (tx) => {
    tx.emit({ type: "after", data: {} });
    return Promise.resolve();
  });
  assertEquals(next.events.map((e) => e.seq), [3]);
  await store.close();
});

test("pglite tenant: SQL refuses a schema other tenants share", async () => {
  const store = await pooled(":memory:");
  const { epoch } = await store.open();
  assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "shared_schema");
  const error = await assertRejects(() =>
    store.transaction(epoch, (tx) => tx.execute!("DELETE FROM nodes"), { alone: true })
  );
  assertEquals(code(error), "shared_schema");
  await store.close();
});

test("memory: no SQL", () => {
  const store = memoryStore();
  assertEquals(store.inspect, undefined);
});

if (POSTGRES) {
  test("postgres: a read runs at most its timeout", async () => {
    const store = await postgresStore({ url: POSTGRES, schema: schemaName() });
    await store.open();
    const error = await assertRejects(() =>
      store.inspect("SELECT pg_sleep(5)", [], { timeout: 100 })
    );
    assertEquals(code(error), "timeout");
    // The setting was the read's alone: the next read has none.
    assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
    await store.drop();
  });
}
