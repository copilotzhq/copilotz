import { assertEquals, assertRejects } from "@std/assert";

import {
  createOminipgSqlSession,
  openManagedOminipgDatabase,
} from "./ominipg.ts";

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
    async query(sql) {
      calls.push(`database:${sql}`);
      return { rows: [] };
    },
    async close() {},
    async transaction(operation) {
      calls.push("database:transaction");
      return await operation({
        async query(sql) {
          calls.push(`transaction:${sql}`);
          return { rows: [] };
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
