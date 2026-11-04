/**
 * Maintenance SQL on the SQL stores: `inspect` reads one statement with its
 * parameters, at most `limit` rows, and can't write; a maintenance
 * transaction's `execute` runs one that writes, says how many rows it
 * changed, and is fenced like any commit. Neither leaves anything behind on
 * a connection the store shares, nor runs where SQL could reach another
 * tenant's rows; a write can't change the store's own state. On PostgreSQL
 * servers it runs as a least-privilege role of its own (maintainer.ts).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Store } from "../../runtime/store.ts";
import { memoryStore } from "../memory/mod.ts";
import { sqliteStore } from "../sql/sqlite/mod.ts";
import { postgresPool, postgresStore } from "../sql/postgres/mod.ts";
import { env, tempFile, test } from "../../testing/mod.ts";
import { pooled, schemaName } from "./pooled.ts";
import { type Maintainer, maintainer } from "./maintainer.ts";
import { connect } from "../sql/postgres/maintenance.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
/** Whether the test database's role can make a maintenance role (CREATEROLE). */
const ROLES = POSTGRES
  ? await maintainer(POSTGRES).then(async (m) => (await m?.drop(), !!m))
  : false;

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
  ...(POSTGRES && ROLES
    ? {
      postgres: (): Pair => {
        const schema = schemaName();
        let role: Maintainer;
        return {
          dialect: "postgres",
          async open() {
            role = (await maintainer(POSTGRES))!;
            const maintenance = { url: role.url };
            const stores: [Sql, Sql] = [
              await postgresStore({ url: POSTGRES, schema, maintenance }),
              await postgresStore({ url: POSTGRES, schema, maintenance }),
            ];
            await role.grant(schema);
            return stores;
          },
          // The tests close theirs: the schema goes with a store of its own, then the role.
          async close() {
            await (await postgresStore({ url: POSTGRES, schema })).drop();
            await role.drop();
          },
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
    }, { maintenance: true });
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
      ), { maintenance: true });
    assertEquals(returning.result, { rows: [{ id: "n3" }], changed: 1 });
    const none = await store.transaction(
      epoch,
      (tx) => tx.execute!("DELETE FROM nodes WHERE id = 'nowhere'"),
      { maintenance: true },
    );
    assertEquals(none.result.changed, 0);
    // A failing statement rolls its transaction back, events and all.
    await assertRejects(() =>
      store.transaction(epoch, async (tx) => {
        tx.emit({ type: "lost", data: {} });
        await tx.execute!("UPDATE nowhere SET x = 1");
      }, { maintenance: true })
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
      }, { maintenance: true })
    );
    assertEquals(code(error), "fenced");
    assertEquals((await second.find("note", {}))[0].text, "kept");
    assertEquals((await second.events(0)).filter((e) => e.type === "audit"), []);
    await first.close();
    await second.close();
    await pair.close();
  });
}

test("pglite: execute runs only in a maintenance transaction; events it adds keep their numbers", async () => {
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
  }, { maintenance: true });
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
    store.transaction(epoch, (tx) => tx.execute!("DELETE FROM nodes"), { maintenance: true })
  );
  assertEquals(code(error), "shared_schema");
  await store.close();
});

test("memory: no SQL", () => {
  const store = memoryStore();
  assertEquals(store.inspect, undefined);
});

// SQLite: what a statement leaves can't stand in for the store, and reads run apart.

/** A SQLite store with notes, on a file. */
async function notes(open?: Parameters<typeof sqliteStore>[0]["open"]) {
  const path = tempFile(".sqlite");
  const store = await sqliteStore({ path, ...(open ? { open } : {}) });
  const { epoch } = await store.open();
  await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "a", text: "A" }]));
  return { store, epoch, path };
}

test("sqlite: a write that leaves a temporary object, or changes meta, is rolled back", async () => {
  const { store, epoch, path } = await notes();
  for (
    const sql of [
      "CREATE TEMP TABLE events AS SELECT * FROM main.events WHERE 0",
      "CREATE TEMP VIEW meta AS SELECT 'epoch' AS key, 999 AS value",
      "UPDATE main.meta SET value = value + 1 WHERE key = 'epoch'",
    ]
  ) {
    const error = await assertRejects(() =>
      store.transaction(epoch, async (tx) => {
        await tx.execute!(sql);
        tx.emit({ type: "maintenance.sql", data: { sql } });
      }, { maintenance: true })
    );
    assertEquals(code(error), "forbidden", sql);
  }
  // The log and the fence are the file's own, and the store still writes to them.
  const after = await store.transaction(epoch, (tx) => {
    tx.emit({ type: "after", data: {} });
    return Promise.resolve();
  });
  assertEquals(after.events.map((e) => e.type), ["after"]);
  const { DatabaseSync } = await import("node:sqlite");
  const file = new DatabaseSync(path, { readOnly: true });
  const types = file.prepare("SELECT type FROM events ORDER BY seq").all().map((r) => r.type);
  assertEquals(types.filter((type) => type !== "note.created"), ["after"]);
  file.close();
  await store.close();
});

test("sqlite: a read runs apart: cut off at its timeout, while the process goes on", async () => {
  const { store } = await notes();
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 10);
  const started = performance.now();
  const error = await assertRejects(() =>
    store.inspect(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000000) " +
        "SELECT count(*) AS n FROM c",
      [],
      { timeout: 200 },
    )
  );
  clearInterval(ticking);
  assertEquals(code(error), "timeout");
  assert(performance.now() - started < 1500, "it answered at its timeout");
  assert(ticks >= 5, `the event loop ran meanwhile (${ticks} ticks)`);
  await store.close();
});

test("sqlite: a read's errors aren't lost to its limit, nor its pragmas kept", async () => {
  const { store } = await notes();
  // An error in the middle of a query that's cut to a limit still comes back.
  const overflow = await assertRejects(() =>
    store.inspect("SELECT 1 AS v UNION ALL SELECT abs(-9223372036854775808)", [], { limit: 5 })
  );
  assertEquals(code(overflow), "sql");
  // A pragma set by a read stays on its own connection, which is gone.
  await store.inspect("PRAGMA cache_size = 1");
  assertEquals((await store.inspect("PRAGMA cache_size"))[0], { cache_size: -2000 });
  // SQLite's line comment runs to an LF: what follows a CR is still comment.
  assertEquals(await store.inspect("SELECT 1 AS one -- x\r; DELETE FROM nodes"), [{ one: 1 }]);
  assertEquals((await store.find("note", {})).length, 1);
  await store.close();
});

test("sqlite: on a database it can't open apart, a read sets no pragma", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { store } = await notes((path) => new DatabaseSync(path));
  const error = await assertRejects(() => store.inspect("PRAGMA cache_size = 1"));
  assertEquals(code(error), "invalid");
  assert((await store.inspect("PRAGMA table_info(nodes)")).length > 0);
  await store.close();
});

test("pglite: what maintenance SQL leaves on the one session is discarded", async () => {
  const store = await postgresStore({ url: ":memory:" });
  const { epoch } = await store.open();
  await store.inspect("SELECT pg_advisory_lock(4242) AS locked");
  await store.transaction(
    epoch,
    (tx) => tx.execute!("SELECT set_config('statement_timeout', '1', false)"),
    { maintenance: true },
  );
  assertEquals(
    await store.inspect(
      "SELECT (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory')::int AS locks, " +
        "current_setting('statement_timeout') AS timeout",
    ),
    [{ locks: 0, timeout: "0" }],
  );
  // The store goes on, and so does a write.
  await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "b", text: "B" }]));
  const error = await assertRejects(() =>
    store.transaction(
      epoch,
      (tx) => tx.execute!("UPDATE meta SET value = value + 1 WHERE key = 'epoch'"),
      { maintenance: true },
    )
  );
  assertEquals(code(error), "forbidden");
  await store.close();
});

test("pglite: SQL refuses a database where other schemas are within reach", async () => {
  const pool = await postgresPool({ url: ":memory:" });
  const other = await postgresStore({ pool, schema: schemaName() });
  const store = await postgresStore({ pool, schema: schemaName() });
  await other.open();
  await store.open();
  assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "unsafe_role");
  await other.close();
  await store.close();
  await pool.close();
});

if (POSTGRES && ROLES) {
  /** A store whose maintenance SQL runs as a role of its own, on a schema of its own. */
  const owned = async () => {
    const role = (await maintainer(POSTGRES))!;
    const schema = schemaName();
    const store = await postgresStore({ url: POSTGRES, schema, maintenance: { url: role.url } });
    await role.grant(schema);
    const { epoch } = await store.open();
    await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "a", text: "A" }]));
    return {
      store,
      epoch,
      schema,
      role,
      done: async () => (await store.drop(), await role.drop()),
    };
  };

  test("postgres: a read runs at most its timeout", async () => {
    const { store, done } = await owned();
    const error = await assertRejects(() =>
      store.inspect("SELECT pg_sleep(5)", [], { timeout: 100 })
    );
    assertEquals(code(error), "timeout");
    // The setting was the read's alone: the next read has none.
    assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
    await done();
  });

  test("postgres: one statement, over the extended protocol, strings read as checked", async () => {
    const { store, role, done } = await owned();
    // The check sees through a comment a CR ends.
    const hidden = "SELECT 1 -- x\r; COMMIT; DELETE FROM nodes";
    assertEquals(code(await assertRejects(() => store.inspect(hidden))), "invalid");
    // And the server refuses a second statement anyway, parameters or not.
    const db = await connect(role.url);
    const twice = await assertRejects(() => db.query("SELECT 1; SELECT 2"));
    assertEquals((twice as { code?: string }).code, "42601");
    await db.end();
    // Strings are read as the check reads them, whatever the role's default.
    await role.run(`ALTER ROLE "${role.role}" SET standard_conforming_strings = off`);
    assertEquals(await store.inspect("SHOW standard_conforming_strings"), [
      { standard_conforming_strings: "on" },
    ]);
    assertEquals((await store.find("note", {})).length, 1);
    await done();
  });

  test("postgres: nothing a statement leaves outlives its own connection", async () => {
    const { store, epoch, done } = await owned();
    await store.inspect("SELECT pg_advisory_lock(4242) AS locked");
    await store.transaction(
      epoch,
      (tx) => tx.execute!("SELECT set_config('default_transaction_read_only', 'on', false)"),
      { maintenance: true },
    );
    // The store's own connections write on, and the lock went with its connection.
    for (let i = 0; i < 3; i++) {
      await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: `x${i}`, text: "x" }]));
    }
    const [locks] = await store.inspect(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
    );
    assertEquals(locks.n, 0);
    await done();
  });

  test("postgres: the maintenance role reaches its schema only, and appends to the log", async () => {
    const { store, epoch, schema, role, done } = await owned();
    // It can't stop the app's connections.
    const kill = await assertRejects(() =>
      store.inspect(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() " +
          "AND usename <> current_user",
      )
    );
    assertEquals(code(kill), "sql");
    // Nor rewrite the log, nor move the fence.
    const rewrite = await assertRejects(() =>
      store.transaction(epoch, (tx) => tx.execute!("DELETE FROM events"), { maintenance: true })
    );
    assertEquals(code(rewrite), "sql");
    const fence = await assertRejects(() =>
      store.transaction(
        epoch,
        (tx) => tx.execute!("UPDATE meta SET value = value + 1 WHERE key = 'epoch'"),
        { maintenance: true },
      )
    );
    assertEquals(code(fence), "forbidden");
    // A role let rewrite the log, or reach another schema, is refused.
    await role.run(`GRANT UPDATE ON "${schema}".events TO "${role.role}"`);
    assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "unsafe_role");
    await role.run(`REVOKE UPDATE ON "${schema}".events FROM "${role.role}"`);
    const elsewhere = schemaName();
    await role.run(`CREATE SCHEMA "${elsewhere}"`);
    await role.run(`CREATE TABLE "${elsewhere}".secrets (x text)`);
    await role.run(`GRANT USAGE ON SCHEMA "${elsewhere}" TO "${role.role}"`);
    await role.run(`GRANT SELECT ON "${elsewhere}".secrets TO "${role.role}"`);
    assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "unsafe_role");
    await role.run(`DROP SCHEMA "${elsewhere}" CASCADE`);
    assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
    await done();
  });

  test("postgres: as the store's own role, SQL runs only where it reaches nothing else", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url: POSTGRES, schema });
    await store.open();
    // The test database holds other schemas of this role's: one, at least.
    const elsewhere = await postgresStore({ url: POSTGRES, schema: schemaName() });
    assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "unsafe_role");
    await elsewhere.drop();
    await store.drop();
  });
}
