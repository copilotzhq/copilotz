import { assertEquals, assertRejects } from "@std/assert";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import type { ActionRecoveryCatalog } from "../actions/recovery.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  createOwnerOperationCatalogCore,
  OPERATION_CATALOG_FINGERPRINT,
  provisionOperationCatalog,
} from "./catalog.ts";
import { provisionOwnerContentCatalog } from "./owner-catalog-schema.ts";

Deno.test("catalog core extraction preserves ordered legacy SQL and parameters", async () => {
  const captured: unknown[] = [];
  const session: SqlSession = {
    query: (sql, params) => {
      captured.push({ sql, params });
      return Promise.resolve({
        rows: sql.startsWith("SELECT fingerprint")
          ? [{ fingerprint: OPERATION_CATALOG_FINGERPRINT }]
          : [],
      } as never);
    },
    transaction() {
      throw new Error("unused");
    },
  };
  const catalog = createOperationCatalog(session, "core_parity");
  for (const root of [true, false]) {
    for (const cancellationTerminal of [false, true]) {
      const params: unknown[] = [];
      const param = (v: unknown) => `$${params.push(v)}`;
      const operationId = "operation", eventId = root ? operationId : "child";
      captured.push({
        admit: catalog.admitEventSql({
          namespace: "tenant",
          operationId,
          cancellationTerminal,
          requireScope: !root,
        }, param),
        params: [...params],
      });
      captured.push({
        index: catalog.indexEventSql({
          namespace: "tenant",
          operationId,
          eventId,
          correlationId: "correlation",
          createdAt: "2026-10-18T00:00:00Z",
          metadata: { observationKeys: ["b", "a"] },
        }, param),
        params: [...params],
      });
      await catalog.indexEvent(session, {
        namespace: "tenant",
        operationId,
        eventId,
        position: "2",
        correlationId: "correlation",
        createdAt: "2026-10-18T00:00:00Z",
        metadata: { observationKeys: ["b", "a"] },
      });
    }
  }
  await catalog.lockScope(session, "operation");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(captured)),
  );
  assertEquals(
    Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0"))
      .join(""),
    "19b8f0a31edb06628a5a9eb52a83d7876ed97b4af13ab781166ecce79e461a18",
  );
});

Deno.test("owner catalog core is synchronous, fixed-format and physically excludes stream capabilities", () => {
  let calls = 0;
  const session: SqlSession = {
    query() {
      calls++;
      throw new Error("unexpected SQL");
    },
    transaction() {
      throw new Error("unexpected transaction");
    },
  };
  const core = createOwnerOperationCatalogCore(session, "public");
  assertEquals(calls, 0);
  assertEquals(Object.keys(core).sort(), [
    "admitEventSql",
    "assertFormat",
    "databaseSchema",
    "indexEvent",
    "indexEventSql",
    "lockScope",
  ]);
  assertEquals(Object.isFrozen(core), true);
  assertEquals(Reflect.set(core, "failDeliveryStreams", () => {}), false);
  const requiresRecovery = (value: ActionRecoveryCatalog) => value;
  // @ts-expect-error Event indexing does not silently grant stream recovery.
  requiresRecovery(core);
});

async function snapshot(db: SqlExecutor, schema: string) {
  const result: Record<string, unknown> = {};
  for (
    const table of new Set(Object.values(createOperationCatalogTables(schema)))
  ) {
    result[table] = (await db.query(
      `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
    )).rows;
  }
  return result;
}

Deno.test("owner core indexes real events and duplicate replay under its exact private format", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = `core_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const core = createOwnerOperationCatalogCore(db, schema);
    await provisionCopilotzSchema(db, schema);
    await provisionOwnerContentCatalog(db, schema);
    await core.assertFormat();
    const store = createEventStore({
      session: db,
      schema,
      assertOperationCatalog: core.assertFormat,
      admitOperationEventSql: core.admitEventSql,
      indexOperationEvent: core.indexEvent,
      indexOperationEventSql: core.indexEventSql,
    });
    const input = {
      type: "work.created",
      namespace: "tenant",
      payload: { value: 1 },
      metadata: { observationKeys: ["team:a"] },
      deduplicationId: "root",
    };
    const first = await store.append(input, []);
    const before = await snapshot(db, schema);
    const duplicate = await store.append(input, []);
    assertEquals(duplicate.event.id, first.event.id);
    assertEquals(await snapshot(db, schema), before);
    const tables = createOperationCatalogTables(schema);
    assertEquals(
      (await db.query(
        `SELECT state,next_event_ordinal::text AS ordinal FROM ${tables.operations}`,
      )).rows,
      [{ state: "accepted", ordinal: "2" }],
    );
    assertEquals(
      (await db.query(
        `SELECT selection_key,change_ordinal::text AS ordinal FROM ${tables.selectionHeads}`,
      )).rows,
      [{ selection_key: "team:a", ordinal: "1" }],
    );
    await db.transaction((tx) => core.lockScope(tx, first.event.id));
    const legacy = createOperationCatalog(db, schema);
    await assertRejects(() => legacy.assertFormat());
    await assertRejects(() =>
      db.transaction((tx) => legacy.lockScope(tx, first.event.id))
    );
    await assertRejects(() =>
      legacy.indexEvent(db, {
        namespace: "tenant",
        operationId: "forbidden",
        eventId: "forbidden",
        position: "99",
        correlationId: "c",
        createdAt: "2026-10-18T00:00:00Z",
      })
    );
    assertEquals(await snapshot(db, schema), before);
  } finally {
    await db.close();
  }
});

Deno.test("owner core refuses legacy schemas in both asynchronous preflight and generated indexing SQL", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = `core_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const core = createOwnerOperationCatalogCore(db, schema);
    const before = await snapshot(db, schema);
    await assertRejects(() => core.assertFormat());
    await assertRejects(() => core.lockScope(db, "operation"));
    const input = {
      namespace: "tenant",
      operationId: "operation",
      eventId: "operation",
      correlationId: "correlation",
      createdAt: "2026-10-18T00:00:00Z",
    };
    await assertRejects(() => core.indexEvent(db, { ...input, position: "1" }));
    const params: unknown[] = [];
    const param = (v: unknown) => `$${params.push(v)}`;
    const ctes = core.indexEventSql(input, param);
    await db.query(
      `WITH inserted_event AS (SELECT 1::bigint AS position),inserted_deliveries AS (SELECT 'operation'::text AS settlement_scope_id,'pending'::text AS status WHERE FALSE),${ctes} SELECT * FROM indexed_event`,
      params,
    );
    assertEquals(await snapshot(db, schema), before);
    const store = createEventStore({
      session: db,
      schema,
      assertOperationCatalog: core.assertFormat,
      admitOperationEventSql: core.admitEventSql,
      indexOperationEvent: core.indexEvent,
      indexOperationEventSql: core.indexEventSql,
    });
    await assertRejects(() =>
      store.append({ type: "forbidden", namespace: "tenant", payload: {} }, [])
    );
    assertEquals(await snapshot(db, schema), before);
  } finally {
    await db.close();
  }
});
