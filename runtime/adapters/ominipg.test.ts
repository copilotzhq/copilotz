import { assertEquals, assertRejects } from "@std/assert";

import {
  createManagedOminipgSession,
  createOminipgSqlSession,
} from "./ominipg.ts";

Deno.test("managed Ominipg session commits and rolls back atomically", async () => {
  const managed = await createManagedOminipgSession();
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

Deno.test("Ominipg adapter pins a direct PostgreSQL transaction client", async () => {
  const calls: string[] = [];
  let releases = 0;
  const session = createOminipgSqlSession({
    async query(sql) {
      calls.push(`database:${sql}`);
      return { rows: [] };
    },
    async close() {},
    pool: {
      async connect() {
        calls.push("pool:connect");
        return {
          async query(sql) {
            calls.push(`client:${sql}`);
            return { rows: [] };
          },
          release() {
            releases += 1;
          },
        };
      },
    },
  });

  await session.query("SELECT outside");
  await session.transaction(async (transaction) => {
    await transaction.query("SELECT inside");
  });

  assertEquals(calls, [
    "database:SELECT outside",
    "pool:connect",
    "client:BEGIN",
    "client:SELECT inside",
    "client:COMMIT",
  ]);
  assertEquals(releases, 1);
});
