import { assert, assertEquals } from "@std/assert";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlSession,
} from "@copilotz/copilotz/events";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "@copilotz/copilotz/streams";
import { createTestDatabase } from "../../../../../../runtime/testing/ominipg.ts";
import {
  listThreadOperations,
  operationBelongsToThread,
  threadEventWatermark,
} from "./index.ts";

Deno.test("Core operation queries handle explicit and event associations with bounded SQL plans", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "core_operation_queries";
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const queries: { sql: string; params?: unknown[] }[] = [];
    const session: SqlSession = {
      ...db,
      query(sql, params) {
        queries.push({ sql, params });
        return db.query(sql, params);
      },
    };
    const catalog = createOperationCatalog(session, schema);
    const store = createEventStore({
      session,
      schema,
      indexOperationEvent: (tx, input) => catalog.indexEvent(tx, input),
    });
    const explicit = await store.append({
      namespace: "tenant",
      type: "test.explicit",
      metadata: { operationMetadata: { threadId: "thread" } },
      payload: {},
    }, []);
    const derived = await store.append({
      namespace: "tenant",
      type: "test.derived",
      metadata: { core: { threadId: "thread" } },
      payload: {},
    }, []);
    for (const result of [explicit, derived]) {
      assert(
        await operationBelongsToThread(
          catalog,
          "tenant",
          result.event.id,
          "thread",
        ),
      );
      assertEquals(
        await operationBelongsToThread(
          catalog,
          "other",
          result.event.id,
          "thread",
        ),
        false,
      );
    }
    assertEquals(
      await threadEventWatermark(catalog, "tenant", "thread"),
      String(derived.event.position),
    );
    queries.length = 0;
    const found = await listThreadOperations(catalog, {
      namespace: "tenant",
      threadId: "thread",
      limit: 1,
    });
    assertEquals(found.length, 1);
    const association = queries[0];
    const plan = await db.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${association.sql}`,
      association.params,
    );
    assert(JSON.stringify(plan.rows).includes("Limit"));
    assertEquals(
      (await listThreadOperations(catalog, {
        namespace: "other",
        threadId: "thread",
      })).length,
      0,
    );
  } finally {
    await db.close();
  }
});
