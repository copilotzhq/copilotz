import { assertEquals, assertRejects } from "@std/assert";
import { provisionCopilotzSchema } from "../../../../runtime/events/index.ts";
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
      "differs from its declaration",
    );
  } finally {
    await db.close();
  }
});

Deno.test("Core history provisioning rejects an invalid index without analyzing it", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const statements: string[] = [];
  const session = {
    query: db.query,
    transaction: <T>(
      run: (
        tx: import("../../../../runtime/events/session.ts").SqlExecutor,
      ) => Promise<T>,
    ) =>
      db.transaction((tx) =>
        run({
          query(sql, params) {
            statements.push(sql);
            if (sql.includes("pg_index")) {
              return Promise.resolve(
                {
                  rows: [{
                    name: "core_message_thread_created_idx",
                    valid: false,
                  }],
                } as never,
              );
            }
            return tx.query(sql, params);
          },
        })
      ),
  };
  try {
    await provisionCopilotzSchema(session, "history_invalid");
    await assertRejects(
      () => provisionCoreHistoryIndexes(session, "history_invalid"),
      Error,
      "invalid",
    );
    assertEquals(statements.some((sql) => sql.startsWith("ANALYZE")), false);
  } finally {
    await db.close();
  }
});
