import { assertEquals, assertRejects } from "@std/assert";

import {
  createOminipgSqlSession,
  openManagedOminipgDatabase,
} from "./ominipg.ts";

Deno.test({
  name:
    "offline statement timeout is explicit and does not change online defaults",
  ignore: !Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"),
  async fn() {
    for (
      const [statementTimeoutMs, expected] of [[undefined, "1s"], [null, "0"], [
        100,
        "100ms",
      ]] as const
    ) {
      const managed = await openManagedOminipgDatabase({
        url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"),
        requestTimeoutMs: 2000,
        statementTimeoutMs,
        pgPoolMax: 1,
      });
      try {
        assertEquals(
          (await managed.session.query("SHOW statement_timeout")).rows[0]
            .statement_timeout,
          expected,
        );
      } finally {
        await managed.close();
      }
    }
  },
});

Deno.test("custom single connection configuration uses ordinary transactions", async () => {
  const managed = await openManagedOminipgDatabase({
    pgliteConfig: { extensions: {} },
  });
  try {
    assertEquals(managed.session.concurrentReads, false);
    assertEquals(
      await managed.session.readTransaction!(() => Promise.resolve("read")),
      "read",
    );
  } finally {
    await managed.close();
  }
});

Deno.test("managed Ominipg database commits and rolls back atomically", async () => {
  const managed = await openManagedOminipgDatabase();
  try {
    await managed.session.query(
      "CREATE TABLE atomic_records (id TEXT PRIMARY KEY)",
    );
    await managed.session.transaction(async (transaction) => {
      await transaction.query(
        "INSERT INTO atomic_records (id) VALUES ($1)",
        ["committed"],
      );
    });
    await assertRejects(
      () =>
        managed.session.transaction(async (transaction) => {
          await transaction.query(
            "INSERT INTO atomic_records (id) VALUES ($1)",
            ["rolled-back"],
          );
          throw new Error("abort transaction");
        }),
      Error,
      "abort transaction",
    );
    const result = await managed.session.query<{ id: string }>(
      "SELECT id FROM atomic_records ORDER BY id",
    );
    assertEquals(result.rows, [{ id: "committed" }]);
  } finally {
    await managed.close();
    await managed.close();
  }
});

Deno.test("Ominipg SQL adapter delegates transaction ownership to Ominipg", async () => {
  const calls: string[] = [];
  const session = createOminipgSqlSession({
    query(sql) {
      calls.push(`database:${sql}`);
      return Promise.resolve({ rows: [] });
    },
    async close() {},
    async transaction(operation) {
      calls.push("database:transaction");
      return await operation({
        query(sql) {
          calls.push(`transaction:${sql}`);
          return Promise.resolve({ rows: [] });
        },
      });
    },
  });

  await session.query("SELECT outside");
  await session.transaction(async (transaction) => {
    await transaction.query("SELECT inside");
  });

  assertEquals(calls, [
    "database:SELECT outside",
    "database:transaction",
    "transaction:SELECT inside",
  ]);
});

Deno.test("read snapshots set isolation on BEGIN instead of a SET TRANSACTION round trip", async () => {
  const calls: unknown[] = [];
  const session = createOminipgSqlSession({
    query: () => Promise.resolve({ rows: [] }),
    async close() {},
    async transaction(operation, options) {
      calls.push(options);
      return await operation({
        query(sql) {
          calls.push(sql);
          return Promise.resolve({ rows: [] });
        },
      });
    },
  });

  await session.readTransaction!((snapshot) => snapshot.query("SELECT 1"));

  assertEquals(calls, [
    { isolation: "repeatable read", readOnly: true },
    "SELECT 1",
  ]);
});

Deno.test("managed read snapshots are repeatable read and read only", async () => {
  const managed = await openManagedOminipgDatabase();
  try {
    const modes = await managed.session.readTransaction!(async (snapshot) => [
      (await snapshot.query("SHOW transaction_isolation")).rows[0]
        .transaction_isolation,
      (await snapshot.query("SHOW transaction_read_only")).rows[0]
        .transaction_read_only,
    ]);
    assertEquals(modes, ["repeatable read", "on"]);
    await assertRejects(() =>
      managed.session.readTransaction!((snapshot) =>
        snapshot.query("CREATE TABLE refused (id TEXT)")
      )
    );
  } finally {
    await managed.close();
  }
});
