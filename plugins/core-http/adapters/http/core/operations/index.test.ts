import { assert, assertEquals } from "@std/assert";
import {
  createEventStore,
  provisionCopilotzSchema,
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

Deno.test("Core operation queries discover bounded thread associations", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "core_operation_queries";
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    const store = createEventStore({
      session: db,
      schema,
      indexOperationEvent: (tx, input) => catalog.indexEvent(tx, input),
    });
    const append = async (
      namespace: string,
      type: string,
      metadata: Readonly<Record<string, unknown>>,
    ) =>
      (await store.append({ namespace, type, metadata, payload: {} }, []))
        .event;
    const explicit = await append(
      "tenant",
      "test.explicit",
      { operationMetadata: { threadId: "thread" } },
    );
    const derived = await append(
      "tenant",
      "test.derived",
      { core: { threadId: "thread" } },
    );
    const both = await append(
      "tenant",
      "test.both",
      {
        operationMetadata: { threadId: "thread" },
        core: { threadId: "thread" },
      },
    );
    const foreignNamespace = await append(
      "other",
      "test.foreign-namespace",
      { operationMetadata: { threadId: "thread" } },
    );
    const otherThread = await append(
      "tenant",
      "test.other-thread",
      { core: { threadId: "other-thread" } },
    );
    const finishedOld = await append(
      "tenant",
      "test.finished-old",
      { core: { threadId: "thread" } },
    );
    const finishedRecent = await append(
      "tenant",
      "test.finished-recent",
      { operationMetadata: { threadId: "thread" } },
    );
    const active = await append(
      "tenant",
      "test.active",
      { core: { threadId: "thread" } },
    );
    const topLevelThread = await append(
      "tenant",
      "test.top-level-thread",
      { threadId: "thread" },
    );
    const mismatchedNesting = await append(
      "tenant",
      "test.mismatched-nesting",
      {
        operationMetadata: { core: { threadId: "thread" } },
        core: { operationMetadata: { threadId: "thread" } },
      },
    );
    await catalog.mark("tenant", finishedOld.id, "completed");
    await catalog.mark("tenant", finishedRecent.id, "completed");
    await db.query(
      `UPDATE "${schema}"."copilotz_operations"
          SET updated_at = CASE operation_id
            WHEN $1 THEN $2::timestamptz
            WHEN $3 THEN $4::timestamptz
            WHEN $5 THEN $6::timestamptz
            ELSE updated_at
          END
        WHERE namespace = $7 AND operation_id = ANY($8::text[])`,
      [
        finishedOld.id,
        "2026-01-01T00:00:00.000Z",
        finishedRecent.id,
        "2026-01-03T00:00:00.000Z",
        active.id,
        "2026-01-02T00:00:00.000Z",
        "tenant",
        [finishedOld.id, finishedRecent.id, active.id],
      ],
    );
    for (const result of [explicit, derived, both]) {
      assert(
        await operationBelongsToThread(
          catalog,
          "tenant",
          result.id,
          "thread",
        ),
      );
      assertEquals(
        await operationBelongsToThread(
          catalog,
          "other",
          result.id,
          "thread",
        ),
        false,
      );
    }
    assertEquals(
      await operationBelongsToThread(
        catalog,
        "tenant",
        foreignNamespace.id,
        "thread",
      ),
      false,
    );
    assertEquals(
      await operationBelongsToThread(
        catalog,
        "tenant",
        otherThread.id,
        "thread",
      ),
      false,
    );
    assertEquals(
      await operationBelongsToThread(
        catalog,
        "tenant",
        topLevelThread.id,
        "thread",
      ),
      false,
    );
    assertEquals(
      await operationBelongsToThread(
        catalog,
        "tenant",
        mismatchedNesting.id,
        "thread",
      ),
      false,
    );
    assertEquals(
      await threadEventWatermark(catalog, "tenant", "thread"),
      String(active.position),
    );
    const found = await listThreadOperations(catalog, {
      namespace: "tenant",
      threadId: "thread",
      limit: 20,
    });
    assertEquals(
      new Set(found.map((operation) => operation.operationId)),
      new Set([
        explicit.id,
        derived.id,
        both.id,
        finishedOld.id,
        finishedRecent.id,
        active.id,
      ]),
    );
    assertEquals(
      found.some((operation) => operation.operationId === foreignNamespace.id),
      false,
    );
    assertEquals(
      found.some((operation) => operation.operationId === otherThread.id),
      false,
    );
    assertEquals(
      found.some((operation) =>
        operation.operationId === topLevelThread.id ||
        operation.operationId === mismatchedNesting.id
      ),
      false,
    );
    const afterOld = await listThreadOperations(catalog, {
      namespace: "tenant",
      threadId: "thread",
      afterPosition: String(finishedOld.position),
      limit: 20,
    });
    assertEquals(
      new Set(afterOld.map((operation) => operation.operationId)),
      new Set([explicit.id, derived.id, both.id, finishedRecent.id, active.id]),
    );
    const completed = await listThreadOperations(catalog, {
      namespace: "tenant",
      threadId: "thread",
      states: ["completed"],
      limit: 20,
    });
    assertEquals(
      completed.map((operation) => operation.operationId),
      [finishedRecent.id, finishedOld.id],
    );
    assertEquals(
      (await listThreadOperations(catalog, {
        namespace: "tenant",
        threadId: "thread",
        states: ["completed"],
        limit: 1,
      })).map((operation) => operation.operationId),
      [finishedRecent.id],
    );
    assertEquals(
      (await listThreadOperations(catalog, {
        namespace: "tenant",
        threadId: "thread",
        states: ["completed"],
        afterPosition: String(finishedOld.position),
        limit: 20,
      })).map((operation) => operation.operationId),
      [finishedRecent.id],
    );
    assertEquals(
      (await listThreadOperations(catalog, {
        namespace: "other",
        threadId: "thread",
      })).map((operation) => operation.operationId),
      [foreignNamespace.id],
    );
  } finally {
    await db.close();
  }
});
