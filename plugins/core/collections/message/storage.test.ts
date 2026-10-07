import { assertEquals, assertRejects } from "@std/assert";
import {
  provisionCopilotzSchema,
  type SqlExecutor,
} from "../../../../runtime/events/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { provisionCoreHistoryIndexes } from "./storage.ts";

Deno.test("Core history provisioning is explicit and repeatable without changing records", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(db, "history_storage");
    await db.query(`INSERT INTO history_storage.nodes
      (id, namespace, type, name, data) VALUES
      ('m', 'tenant', 'message', '', '{"threadId":"thread"}')`);
    const before = await db.query("SELECT * FROM history_storage.nodes");
    await provisionCoreHistoryIndexes(db, "history_storage");
    await provisionCoreHistoryIndexes(db, "history_storage");
    assertEquals(await db.query("SELECT * FROM history_storage.nodes"), before);
    const index = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'history_storage' AND indexname = 'core_message_thread_created_idx'",
    );
    assertEquals(index.rows.length, 1);
    await assertRejects(
      () => provisionCoreHistoryIndexes(db, "missing_history_storage"),
      Error,
      "not provisioned",
    );
    await db.query(
      "DROP INDEX history_storage.core_message_thread_created_idx",
    );
    await db.query(
      "CREATE INDEX core_message_thread_created_idx ON history_storage.nodes (id)",
    );
    await assertRejects(
      () => provisionCoreHistoryIndexes(db, "history_storage"),
      Error,
      "unexpected definition",
    );
  } finally {
    await db.close();
  }
});

Deno.test("Core history provisioning refuses to accept a failed concurrent index build", async () => {
  const statements: string[] = [];
  const executor: SqlExecutor = {
    query(sql) {
      statements.push(sql);
      if (sql.includes("information_schema.columns")) {
        // Reuse a real provisioned fixture for schema validation below.
        throw new Error("Unexpected schema query");
      }
      return Promise.resolve({ rows: [{ valid: false }] } as never);
    },
  };
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(db, "history_invalid");
    await assertRejects(
      () =>
        provisionCoreHistoryIndexes(
          {
            query: (sql, params) =>
              sql.includes("information_schema.columns") ||
                sql.includes("SELECT version")
                ? db.query(sql, params)
                : executor.query(sql, params),
          },
          "history_invalid",
          { concurrently: true },
        ),
      Error,
      "invalid",
    );
    assertEquals(statements[0].includes("CREATE INDEX CONCURRENTLY"), true);
    assertEquals(statements.some((sql) => sql.startsWith("ANALYZE")), false);
  } finally {
    await db.close();
  }
});
