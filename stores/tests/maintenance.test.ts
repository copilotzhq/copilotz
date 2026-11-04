/**
 * Maintenance SQL on the SQL stores: `inspect` reads one statement with its
 * parameters, at most `limit` rows, and can't write; a maintenance
 * transaction's `execute` runs one that writes, says how many rows it
 * changed, and is fenced like any commit. Neither leaves anything behind on
 * a connection the store shares, nor runs where SQL could reach another
 * tenant's rows; a write can't change the store's own state. On PostgreSQL
 * servers it runs as a least-privilege role of its own (maintainer.ts), or,
 * told so (`storeRole`), as the store's own, never one that could run server
 * commands or reach its files.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import type { Store } from "../../runtime/store.ts";
import { memoryStore } from "../memory/mod.ts";
import { sqliteStore } from "../sql/sqlite/mod.ts";
import { postgresPool, postgresStore } from "../sql/postgres/mod.ts";
import { env, tempFile, test } from "../../testing/mod.ts";
import { pooled, schemaName } from "./pooled.ts";
import { type Login, type Maintainer, maintainer, storeLogin } from "./maintainer.ts";
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
      // As the store's own role, told so: an app's own login, not a superuser.
      "postgres (store role)": (): Pair => {
        const schema = schemaName();
        let login: Login;
        return {
          dialect: "postgres",
          async open() {
            login = (await storeLogin(POSTGRES))!;
            const maintenance = { storeRole: true } as const;
            return [
              await postgresStore({ url: login.url, schema, maintenance }),
              await postgresStore({ url: login.url, schema, maintenance }),
            ];
          },
          async close() {
            await (await postgresStore({ url: login.url, schema })).drop();
            await login.drop();
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

test("postgres: maintenance as a role of its own or as the store's, not both", async () => {
  const both = {
    url: "postgres://nobody@127.0.0.1:1/none",
    storeRole: true,
  } as unknown as { storeRole: true };
  // Refused as the store opens, before it connects anywhere.
  const error = await assertRejects(() =>
    postgresStore({ url: "postgres://nobody@127.0.0.1:1/none", maintenance: both })
  );
  assertMatch((error as Error).message, /role of its own \(url\) or as the store's own role/);
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

test("sqlite: a read runs apart, and a runaway one is killed at its timeout", async () => {
  const { store, path } = await notes();
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 10);
  const started = performance.now();
  // It never ends on its own: only killing its process stops it.
  const error = await assertRejects(() =>
    store.inspect(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
      [],
      { timeout: 300 },
    )
  );
  clearInterval(ticking);
  assertEquals(code(error), "timeout");
  assert(performance.now() - started < 2000, "it answered at its timeout");
  assert(ticks >= 5, `the event loop ran meanwhile (${ticks} ticks)`);
  // Gone with its process: nothing holds the log, so it checkpoints whole.
  const { epoch } = await store.open().catch(() => ({ epoch: 0 }));
  void epoch;
  const { DatabaseSync } = await import("node:sqlite");
  const file = new DatabaseSync(path);
  assertEquals(file.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(), {
    busy: 0,
    log: 0,
    checkpointed: 0,
  });
  file.close();
  await store.close();
});

test("sqlite: reads apart stop at their bytes, and a third at once is busy", async () => {
  const path = tempFile(".sqlite");
  const store = await sqliteStore({ path, maintenance: { connections: 1 } });
  const { epoch } = await store.open();
  await store.transaction(
    epoch,
    (tx) =>
      tx.insert(
        "note",
        Array.from({ length: 50 }, (_, n) => ({ _id: `n${n}`, text: "x".repeat(100) })),
      ),
  );
  const rows = await store.inspect("SELECT id, doc FROM nodes", [], { bytes: 500 });
  assert(rows.length > 1 && rows.length < 10, `${rows.length} rows within 500 bytes, and one past`);
  const slow = store.inspect(
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
    [],
    { timeout: 500 },
  ).catch((error) => error);
  const busy = await assertRejects(() => store.inspect("SELECT 1"));
  assertEquals(code(busy), "busy");
  assertEquals(code(await slow), "timeout");
  assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
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

test("sqlite: reads on the store's own connection say so, once and on each answer", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { store } = await notes((path) => new DatabaseSync(path));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    const first = await store.inspect("SELECT 1 AS one");
    const second = await store.inspect("SELECT 2 AS two");
    assertEquals([first.inline, second.inline], [true, true]);
  } finally {
    console.warn = warn;
  }
  assertEquals(warned.length, 1);
  assertMatch(warned[0], /no timeout: the database is opened another way/);
  await store.close();
});

test("sqlite: a read's process takes nothing of the app's environment", async () => {
  const { store } = await notes();
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env;
  const before = env?.NODE_OPTIONS;
  // Were it passed on, a Node process couldn't start.
  if (env) env.NODE_OPTIONS = "--require=/nowhere/copilotz-missing.cjs";
  try {
    const rows = await store.inspect("SELECT 1 AS one");
    assertEquals([rows[0].one, rows.inline], [1, undefined]);
  } finally {
    if (env) before === undefined ? delete env.NODE_OPTIONS : env.NODE_OPTIONS = before;
  }
  await store.close();
});

test("sqlite: on a database it can't open apart, a read sets no pragma", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { store } = await notes((path) => new DatabaseSync(path));
  for (
    const sql of [
      "PRAGMA cache_size = 1",
      "PRAGMA cache_size /**/ = 1",
      "PRAGMA reverse_unordered_selects -- x\n= 1",
      "PRAGMA cache_size(1)",
      "PRAGMA optimize",
      "PRAGMA writable_schema",
    ]
  ) {
    assertEquals(code(await assertRejects(() => store.inspect(sql))), "invalid", sql);
  }
  assert((await store.inspect("PRAGMA table_info(nodes)")).length > 0);
  assert((await store.inspect('PRAGMA main.index_list("nodes") -- which')).length > 0);
  assertEquals((await store.inspect("/* a */ PRAGMA user_version"))[0], { user_version: 0 });
  await store.close();
});

test("sqlite: a trigger stops maintenance writes: one already there, or one a write makes", async () => {
  const { store, epoch, path } = await notes();
  // A single statement can't make one (its body has statements of its own).
  const made = await assertRejects(() =>
    store.transaction(
      epoch,
      (tx) => tx.execute!("CREATE TRIGGER t AFTER INSERT ON events BEGIN SELECT 1; END"),
      { maintenance: true },
    )
  );
  assertEquals(code(made), "invalid");
  // One someone else made: nothing runs while it's there.
  const { DatabaseSync } = await import("node:sqlite");
  const file = new DatabaseSync(path);
  file.exec(
    "CREATE TRIGGER scrub AFTER INSERT ON events BEGIN DELETE FROM events WHERE " +
      "type = 'maintenance.sql'; END",
  );
  file.close();
  const refused = await assertRejects(() =>
    store.transaction(epoch, (tx) => tx.execute!("DELETE FROM nodes WHERE id = 'none'"), {
      maintenance: true,
    })
  );
  assertEquals(code(refused), "forbidden");
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

test("pglite: a write that makes a trigger on the store's tables is rolled back", async () => {
  const store = await postgresStore({ url: ":memory:" });
  const { epoch } = await store.open();
  const sql = "CREATE TRIGGER scrub BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION " +
    "suppress_redundant_updates_trigger()";
  const error = await assertRejects(() =>
    store.transaction(epoch, (tx) => tx.execute!(sql), { maintenance: true })
  );
  assertEquals(code(error), "forbidden");
  assertEquals(
    (await store.inspect("SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal"))[0].n,
    0,
  );
  await store.close();
});

test("pglite: the checks after a statement read the catalog, whatever stands in for it", async () => {
  const pool = await postgresPool({ url: ":memory:" });
  const store = await postgresStore({ pool, schema: schemaName() });
  const { epoch } = await store.open();
  // Temporary tables on the one session, named as catalogs the checks read.
  for (
    const sql of [
      "CREATE TEMP TABLE pg_trigger (tgrelid oid, tgisinternal bool, tgname name)",
      "CREATE TEMP TABLE pg_stat_xact_user_tables (n_tup_ins bigint, n_tup_upd bigint, " +
      "n_tup_del bigint)",
      "INSERT INTO pg_stat_xact_user_tables VALUES (1000000, 0, 0)",
    ]
  ) await pool.writes.query(sql);
  const sql = "CREATE TRIGGER scrub BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION " +
    "suppress_redundant_updates_trigger()";
  const error = await assertRejects(() =>
    store.transaction(epoch, (tx) => tx.execute!(sql), { maintenance: true })
  );
  assertEquals(code(error), "forbidden");
  await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "a", text: "A" }]));
  const done = await store.transaction(
    epoch,
    (tx) => tx.execute!("UPDATE nodes SET doc = doc || '{}' WHERE id = 'a'"),
    { maintenance: true },
  );
  assertEquals(done.result.changed, 1);
  await store.close();
  await pool.close();
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
    // A role with settings of its own is refused (they'd outlive any statement)…
    await role.run(`ALTER ROLE "${role.role}" SET standard_conforming_strings = off`);
    const settings = await assertRejects(() => store.inspect("SELECT 1"));
    assertMatch((settings as Error).message, /settings of its own/);
    await role.run(`ALTER ROLE "${role.role}" RESET ALL`);
    // …and strings are read as the check reads them.
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

  test("postgres: on a server, raw SQL runs only as a role of its own, or the store's told so", async () => {
    const schema = schemaName();
    const store = await postgresStore({ url: POSTGRES, schema });
    const { epoch } = await store.open();
    const read = await assertRejects(() => store.inspect("SELECT 1"));
    assertEquals(code(read), "unsafe_role");
    // It names both ways.
    assertMatch((read as Error).message, /maintenance: \{ url \}/);
    assertMatch((read as Error).message, /maintenance: \{ storeRole: true \}/);
    const write = await assertRejects(() =>
      store.transaction(epoch, (tx) => tx.execute!("SELECT 1"), { maintenance: true })
    );
    assertEquals(code(write), "unsafe_role");
    // The store itself goes on.
    await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "a", text: "A" }]));
    assertEquals((await store.find("note", {})).length, 1);
    await store.drop();
  });

  test("postgres: a role that is a member of any role is refused, whatever it inherits", async () => {
    const { store, role, done } = await owned();
    const other = `cpz_o_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await role.run(`CREATE ROLE "${other}" NOLOGIN`);
    await role.run(`GRANT "${other}" TO "${role.role}"`);
    // With it, `set_config('role', …)` would read as the other role, with no DO at all.
    const error = await assertRejects(() =>
      store.inspect(
        `SELECT set_config('role', '${other}', true) AS r, query_to_xml('SELECT 1', false, ` +
          `false, '') AS x`,
      )
    );
    assertEquals(code(error), "unsafe_role");
    assertMatch((error as Error).message, new RegExp(`member of ${other}`));
    await role.run(`REVOKE "${other}" FROM "${role.role}"`);
    await role.run(`DROP ROLE "${other}"`);
    assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
    await done();
  });

  test("postgres: a role holding anything beyond maintenance's grants is refused", async () => {
    const { store, epoch, schema, role, done } = await owned();
    const elsewhere = schemaName();
    await role.run(`CREATE SCHEMA "${elsewhere}"`);
    await role.run(`CREATE TABLE "${elsewhere}".secrets (x text)`);
    const r = `"${role.role}"`;
    const refusedWith = async (grant: string, revoke: string, what: RegExp) => {
      await role.run(grant);
      const error = await assertRejects(() => store.inspect("SELECT 1"));
      assertEquals(code(error), "unsafe_role", grant);
      assertMatch((error as Error).message, what);
      await role.run(revoke);
      assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1, revoke);
    };
    // A column of another schema's table, or anything granted there at all.
    await refusedWith(
      `GRANT USAGE ON SCHEMA "${elsewhere}" TO ${r}; GRANT SELECT (x) ON "${elsewhere}".secrets ` +
        `TO ${r}`,
      `REVOKE SELECT (x) ON "${elsewhere}".secrets FROM ${r}; REVOKE USAGE ON SCHEMA ` +
        `"${elsewhere}" FROM ${r}`,
      /may use .*secrets/,
    );
    // Making anything, anywhere.
    await refusedWith(
      `GRANT CREATE ON SCHEMA "${elsewhere}" TO ${r}`,
      `REVOKE CREATE ON SCHEMA "${elsewhere}" FROM ${r}`,
      /may create in schema/,
    );
    // More than appending to the log.
    await refusedWith(
      `GRANT TRIGGER ON "${schema}".events TO ${r}`,
      `REVOKE TRIGGER ON "${schema}".events FROM ${r}`,
      /may TRIGGER/,
    );
    await refusedWith(
      `GRANT UPDATE (data) ON "${schema}".events TO ${r}`,
      `REVOKE UPDATE (data) ON "${schema}".events FROM ${r}`,
      /may UPDATE/,
    );
    // A function that runs as its owner: EXECUTE is everyone's until revoked.
    await role.run(
      `CREATE FUNCTION "${elsewhere}".peek() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER ` +
        `AS $f$ SELECT x FROM "${elsewhere}".secrets $f$`,
    );
    const definer = await assertRejects(() => store.inspect("SELECT 1"));
    assertMatch((definer as Error).message, /SECURITY DEFINER/);
    await role.run(`REVOKE EXECUTE ON FUNCTION "${elsewhere}".peek() FROM PUBLIC`);
    assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
    // A trigger the store didn't make, on its tables: nothing runs, a read nor a write.
    await role.run(
      `CREATE TRIGGER noted BEFORE UPDATE ON "${schema}".nodes FOR EACH ROW EXECUTE FUNCTION ` +
        `suppress_redundant_updates_trigger()`,
    );
    assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "unsafe_role");
    const write = await assertRejects(() =>
      store.transaction(epoch, (tx) => tx.execute!("SELECT 1"), { maintenance: true })
    );
    assertEquals(code(write), "unsafe_role");
    await role.run(`DROP TRIGGER noted ON "${schema}".nodes`);
    await role.run(`DROP SCHEMA "${elsewhere}" CASCADE`);
    await done();
  });

  test("postgres: nothing a statement does outlives it in the role", async () => {
    const { store, epoch, role, done } = await owned();
    const write = (sql: string) =>
      store.transaction(epoch, (tx) => tx.execute!(sql), { maintenance: true });
    // Its own password, settings or members: refused before anything runs.
    for (
      const sql of [
        `ALTER ROLE "${role.role}" PASSWORD 'known'`,
        `ALTER USER CURRENT_USER SET work_mem = '64kB'`,
      ]
    ) assertEquals(code(await assertRejects(() => write(sql))), "invalid", sql);
    // Nor through dynamic SQL: a query can't change a role.
    const dynamic = await assertRejects(() =>
      write(
        `SELECT query_to_xml('ALTER ROLE "${role.role}" SET work_mem = ''1MB''', false, ` +
          `false, '') AS x`,
      )
    );
    assertEquals(code(dynamic), "sql");
    // Settings someone gave it: refused until they're gone.
    await role.run(`ALTER ROLE "${role.role}" SET work_mem = '64kB'`);
    assertMatch(
      ((await assertRejects(() => store.inspect("SELECT 1"))) as Error).message,
      /settings of its own/,
    );
    await role.run(`ALTER ROLE "${role.role}" RESET ALL`);
    // A large object it makes is its own, outside the schema: rolled back.
    const made = await assertRejects(() => write("SELECT lo_from_bytea(0, 'kept'::bytea) AS lo"));
    assertEquals(code(made), "unsafe_role");
    assertMatch((made as Error).message, /owns large object/);
    const left = await role.run(
      `SELECT count(*)::int AS n FROM pg_largeobject_metadata m JOIN pg_roles r ON ` +
        `r.oid = m.lomowner WHERE r.rolname = '${role.role}'`,
    ) as { n: number }[];
    assertEquals(left[0].n, 0);
    // One someone else made, everyone's to read: refused until it's gone.
    const [lo] = await role.run("SELECT lo_from_bytea(0, 'a secret'::bytea)::int AS oid") as {
      oid: number;
    }[];
    await role.run(`GRANT SELECT ON LARGE OBJECT ${lo.oid} TO PUBLIC`);
    assertMatch(
      ((await assertRejects(() => store.inspect("SELECT 1"))) as Error).message,
      /may read large object/,
    );
    await role.run(`SELECT lo_unlink(${lo.oid})`);
    // A temporary table named as a catalog the checks read stands in for nothing.
    const shadow = await write(
      "CREATE TEMP TABLE pg_stat_xact_user_tables AS SELECT 1000000::bigint AS n_tup_ins, " +
        "0::bigint AS n_tup_upd, 0::bigint AS n_tup_del",
    );
    assert(shadow.result.changed < 10, `it changed what it changed (${shadow.result.changed})`);
    await done();
  });

  test("postgres: a Cloud SQL IAM marker may hold nothing, its membership no ADMIN OPTION", async () => {
    const { store, schema, role, done } = await owned();
    const r = `"${role.role}"`;
    // A marker this cluster lacks (made here, so ours to grant), else one we administer.
    const [pick] = await role.run(
      `SELECT m AS marker, NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = m) AS made FROM ` +
        `unnest(ARRAY['cloudsqliamserviceaccount', 'cloudsqliamuser', 'cloudsqliamgroup']) m ` +
        `WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = m) OR ` +
        `pg_has_role(current_user, m, 'MEMBER WITH ADMIN OPTION') ORDER BY 2 DESC LIMIT 1`,
    ) as { marker: string; made: boolean }[];
    assert(pick, "every Cloud SQL marker exists here, and none is ours to grant");
    const { marker, made } = pick;
    if (made) await role.run(`CREATE ROLE ${marker} NOLOGIN`);
    const refused = async (what: RegExp) =>
      assertMatch(((await assertRejects(() => store.inspect("SELECT 1"))) as Error).message, what);
    try {
      // As Cloud SQL makes an IAM user: a member of a marker holding nothing.
      await role.run(`GRANT ${marker} TO ${r}`);
      assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
      // The grants given to the marker instead: every IAM user's then. Refused.
      await role.run(
        `GRANT USAGE ON SCHEMA "${schema}" TO ${marker}; GRANT SELECT ON ALL TABLES IN SCHEMA ` +
          `"${schema}" TO ${marker}`,
      );
      await refused(new RegExp(`\\(as ${marker}\\) is granted something`));
      await role.run(
        `REVOKE SELECT ON ALL TABLES IN SCHEMA "${schema}" FROM ${marker}; REVOKE USAGE ON ` +
          `SCHEMA "${schema}" FROM ${marker}`,
      );
      assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
      // A membership the role could hand to anyone: refused.
      await role.run(`REVOKE ${marker} FROM ${r}; GRANT ${marker} TO ${r} WITH ADMIN OPTION`);
      await refused(/ADMIN OPTION/);
    } finally {
      await role.run(`REVOKE ${marker} FROM ${r}`).catch(() => {});
      if (made) await role.run(`DROP ROLE ${marker}`).catch(() => {});
    }
    await done();
  });

  test("postgres: a read stops fetching at its bytes, and a third at once is busy", async () => {
    const role = (await maintainer(POSTGRES))!;
    const schema = schemaName();
    const store = await postgresStore({
      url: POSTGRES,
      schema,
      maintenance: { url: role.url, connections: 1 },
    });
    await role.grant(schema);
    const { epoch } = await store.open();
    await store.transaction(
      epoch,
      (tx) =>
        tx.insert(
          "note",
          Array.from({ length: 500 }, (_, n) => ({ _id: `n${n}`, text: "x".repeat(100) })),
        ),
    );
    const rows = await store.inspect("SELECT id, doc FROM nodes", [], { bytes: 1000 });
    assert(
      rows.length > 1 && rows.length < 20,
      `${rows.length} rows within 1,000 bytes, and one past`,
    );
    const slow = store.inspect("SELECT pg_sleep(0.5)").catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "busy");
    await slow;
    assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
    await store.drop();
    await role.drop();
  });

  /** A store as its own role, told to run maintenance SQL as it, with a note. */
  const asStore = async (attributes = "", connections?: number) => {
    const login = (await storeLogin(POSTGRES, attributes))!;
    const schema = schemaName();
    const store = await postgresStore({
      url: login.url,
      schema,
      maintenance: { storeRole: true, ...(connections ? { connections } : {}) },
    });
    const { epoch } = await store.open();
    await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "a", text: "A" }]));
    return {
      store,
      epoch,
      schema,
      login,
      done: async () => (await store.drop(), await login.drop()),
    };
  };

  test("postgres (store role): raw SQL runs as the store's own role, every other guard kept", async () => {
    const { store, epoch, schema, login, done } = await asStore("", 1);
    const write = (sql: string, params: unknown[] = []) =>
      store.transaction(epoch, (tx) => tx.execute!(sql, params), { maintenance: true });
    try {
      // As the store's role, which owns its tables (the log too), on a connection of its own.
      assertEquals(
        await store.inspect(
          "SELECT current_user AS who, has_table_privilege('events', 'UPDATE') AS rewrites, " +
            "application_name AS app FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        ),
        [{ who: login.role, rewrites: true, app: "copilotz maintenance" }],
      );
      // A read is still read only, and a write still writes, audited in its commit.
      assertEquals(
        code(await assertRejects(() => store.inspect("DELETE FROM nodes WHERE id = 'a'"))),
        "read_only",
      );
      const { result, events } = await store.transaction(epoch, async (tx) => {
        const done = await tx.execute!(
          "UPDATE nodes SET doc = jsonb_set(doc, '{text}', to_jsonb($1::text)) WHERE id = 'a'",
          ["fixed"],
        );
        tx.emit({ type: "maintenance.sql", data: { changed: done.changed } });
        return done;
      }, { maintenance: true });
      assertEquals(result.changed, 1);
      assertEquals(events.map((e) => [e.type, e.data]), [["maintenance.sql", { changed: 1 }]]);
      assertEquals((await store.find("note", {}))[0].text, "fixed");
      // The statement filter: nothing that ends its transaction or reaches past it.
      for (
        const sql of [
          "COMMIT",
          "SET work_mem = '64kB'",
          `ALTER ROLE "${login.role}" SET work_mem = '64kB'`,
          "DO $$ BEGIN END $$",
          "LOCK TABLE nodes",
          "SELECT 1 -- x\r; DELETE FROM nodes",
        ]
      ) assertEquals(code(await assertRejects(() => write(sql))), "invalid", sql);
      // A timeout, and nothing outliving the statement's own connection.
      const slow = await assertRejects(() =>
        store.inspect("SELECT pg_sleep(5)", [], { timeout: 100 })
      );
      assertEquals(code(slow), "timeout");
      await store.inspect("SELECT pg_advisory_lock(4242) AS locked");
      const [locks] = await store.inspect(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
      );
      assertEquals(locks.n, 0);
      // The store's own state, and a trigger on its tables, are rolled back.
      assertEquals(
        code(
          await assertRejects(() => write("UPDATE meta SET value = value + 1 WHERE key = 'epoch'")),
        ),
        "forbidden",
      );
      const trigger = await assertRejects(() =>
        write(
          `CREATE TRIGGER noted BEFORE UPDATE ON "${schema}".nodes FOR EACH ROW EXECUTE ` +
            `FUNCTION suppress_redundant_updates_trigger()`,
        )
      );
      assertEquals(code(trigger), "forbidden");
      const [triggers] = await store.inspect(
        "SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = " +
          "'nodes'::regclass",
      );
      assertEquals(triggers.n, 0);
      // The fence held: the owner writes on.
      await store.transaction(epoch, (tx) => tx.insert("note", [{ _id: "b", text: "B" }]));
      // Rows past a limit are cut, and a second statement at once is busy (connections: 1).
      assertEquals((await store.inspect("SELECT id FROM nodes", [], { limit: 1 })).length, 1);
      const held = store.inspect("SELECT pg_sleep(0.5)").catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(code(await assertRejects(() => store.inspect("SELECT 1"))), "busy");
      await held;
    } finally {
      await done();
    }
  });

  test("postgres (store role): one that could run server commands or reach its files is refused", async () => {
    const pool = await postgresPool({ url: POSTGRES, writes: 1, reads: 1 });
    const run = async (sql: string) => (await pool.writes.query(sql)).rows;
    const [me] = await run(
      "SELECT rolsuper AS superuser, current_setting('server_version_num')::int AS version FROM " +
        "pg_roles WHERE rolname = current_user",
    ) as { superuser: boolean; version: number }[];
    const refused = async (store: Sql, what: RegExp) => {
      const error = await assertRejects(() => store.inspect("SELECT 1"));
      assertEquals(code(error), "unsafe_role");
      assertMatch((error as Error).message, what);
    };
    try {
      if (me.superuser) {
        // The test database's own role, a superuser: its store's role is one.
        const schema = schemaName();
        const store = await postgresStore({
          url: POSTGRES,
          schema,
          maintenance: { storeRole: true },
        });
        try {
          const { epoch } = await store.open();
          await refused(store, /is a superuser/);
          const write = await assertRejects(() =>
            store.transaction(epoch, (tx) => tx.execute!("SELECT 1"), { maintenance: true })
          );
          assertEquals(code(write), "unsafe_role");
        } finally {
          await store.drop();
        }
        // A member of a role that may run programs or reach files, however it got there.
        const { store: as, epoch, login, done } = await asStore();
        const r = `"${login.role}"`;
        const between = `cpz_b_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
        try {
          for (
            const server of [
              "pg_execute_server_program",
              "pg_read_server_files",
              "pg_write_server_files",
            ]
          ) {
            await run(`GRANT ${server} TO ${r}`);
            await refused(as, new RegExp(`member of ${server}`));
            await run(`REVOKE ${server} FROM ${r}`);
          }
          await run(`CREATE ROLE ${between} NOLOGIN NOINHERIT`);
          await run(`GRANT pg_read_server_files TO ${between}; GRANT ${between} TO ${r}`);
          await refused(as, /member of pg_read_server_files/);
          // One that could become a superuser (set_config('role', …) in a statement).
          await run(`REVOKE pg_read_server_files FROM ${between}; ALTER ROLE ${between} SUPERUSER`);
          await refused(as, new RegExp(`may become superuser ${between}`));
          await run(`REVOKE ${between} FROM ${r}; DROP ROLE ${between}`);
          // One let read the server's files by a function.
          await run(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${r}`);
          await refused(as, /may run pg_read_file\(text\)/);
          await run(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM ${r}`);
          assertEquals((await as.inspect("SELECT 1 AS one"))[0].one, 1);
          // A write that makes it one is rolled back: checked again after, in its transaction.
          const elsewhere = schemaName();
          await run(
            `CREATE SCHEMA ${elsewhere}; CREATE FUNCTION ${elsewhere}.promote() RETURNS void ` +
              `LANGUAGE sql SECURITY DEFINER AS $f$ GRANT pg_read_server_files TO ${r} $f$; ` +
              `GRANT USAGE ON SCHEMA ${elsewhere} TO ${r}; GRANT EXECUTE ON FUNCTION ` +
              `${elsewhere}.promote() TO ${r}`,
          );
          try {
            const write = await assertRejects(() =>
              as.transaction(epoch, (tx) => tx.execute!(`SELECT ${elsewhere}.promote()`), {
                maintenance: true,
              })
            );
            assertEquals(code(write), "unsafe_role");
            const [member] = await run(
              `SELECT pg_has_role('${login.role}', 'pg_read_server_files', 'MEMBER') AS is`,
            );
            assertEquals(member.is, false);
          } finally {
            await run(`DROP SCHEMA ${elsewhere} CASCADE`);
          }
        } finally {
          await run(`DROP ROLE IF EXISTS ${between}`).catch(() => {});
          await done();
        }
      }
      // A role that may make roles, as Cloud SQL's postgres user: before PostgreSQL 16 it could
      // grant itself any of them; from 16, only roles it administers.
      const { store, done } = await asStore("CREATEROLE");
      try {
        if (me.version < 160000) await refused(store, /CREATEROLE/);
        else assertEquals((await store.inspect("SELECT 1 AS one"))[0].one, 1);
      } finally {
        await done();
      }
    } finally {
      await pool.close();
    }
  });
}
