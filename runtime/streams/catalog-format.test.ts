import { createCoreTableNames } from "../events/schema.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createCopilotzEngine } from "../engine/engine.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import type { BodyStorageOptions } from "../content/body-store.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  OPERATION_CATALOG_FINGERPRINT,
  provisionOperationCatalog,
  terminalizeOperationSettlement,
} from "./catalog.ts";
import { createStreamOutputDescriptor } from "./observation.ts";

async function fixture() {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const schema = `format_${crypto.randomUUID().replaceAll("-", "")}`;
    // Construction remains synchronous and safe before tables exist.
    const catalog = createOperationCatalog(db, schema);
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const prefix = `"${schema}"`;
    const foreign = async () => {
      await db.query(
        `ALTER TABLE ${prefix}.copilotz_operation_catalog_metadata DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`,
      );
      await db.query(
        `UPDATE ${prefix}.copilotz_operation_catalog_metadata SET fingerprint='owner-content-v1'`,
      );
    };
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      const tables = new Set([
        ...Object.values(createCoreTableNames(schema)),
        ...Object.values(createOperationCatalogTables(schema)),
      ]);
      for (const table of tables) {
        result[table] = (await db.query(
          `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )).rows;
      }
      return result;
    };
    const store = createEventStore({
      session: db,
      schema,
      assertOperationCatalog: catalog.assertFormat,
      admitOperationEventSql: catalog.admitEventSql,
      indexOperationEventSql: catalog.indexEventSql,
      indexOperationEvent: catalog.indexEvent,
    });
    return { db, schema, prefix, catalog, foreign, snapshot, store };
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function refused(work: () => Promise<unknown>) {
  const error = await assertRejects(work);
  assertEquals(
    (error as { code?: string }).code,
    "copilotz_operation_catalog_schema_unsupported",
  );
}
Deno.test("catalog format preflight supports construction before matching fresh provisioning", async () => {
  const f = await fixture();
  try {
    await f.catalog.assertFormat();
    const result = await f.store.append({
      type: "example.created",
      namespace: "tenant",
      payload: {},
    }, []);
    assertEquals(
      (await f.catalog.get("tenant", result.event.id))?.state,
      "accepted",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("foreign catalog format refuses legacy stream and supplied-transaction mutations before hints", async () => {
  const f = await fixture();
  try {
    const scope = {
      namespace: "tenant",
      operationId: "operation",
      streamId: "stream",
    };
    await f.catalog.indexEvent(f.db, {
      ...scope,
      eventId: "operation",
      position: "1",
      correlationId: "operation",
      createdAt: "2026-10-18T00:00:00Z",
    });
    const descriptor = createStreamOutputDescriptor({
      id: "stream",
      semanticId: "stream",
      kind: "text",
      mediaType: "text/plain",
      role: "assistant",
      metadata: {},
    }, { namespace: "tenant" });
    await f.catalog.openStream({
      ...scope,
      semanticStreamId: "stream",
      bodyId: "private-body",
      descriptor,
    });
    let hints = 0, callbacks = 0;
    const unsubscribe = await f.catalog.onChange(() => {
      hints++;
    });
    await f.foreign();
    const before = await f.snapshot();
    const body = {
      bodyId: "private-body",
      byteLength: 0,
      mediaType: "text/plain",
      digest: `sha256:${"a".repeat(64)}` as const,
      maintenanceVersion: 1,
    };
    const operations: Array<() => Promise<unknown>> = [
      () =>
        f.catalog.openStream({
          ...scope,
          semanticStreamId: "stream",
          bodyId: "private-body",
          descriptor,
        }),
      () => f.catalog.commitStreamOffset({ ...scope, committedOffset: 1 }),
      () =>
        f.catalog.sealStream({ ...scope, body: { ...body, state: "ready" } }),
      () =>
        f.catalog.beginStreamTerminalization({ ...scope, outcome: "failed" }),
      () =>
        f.catalog.terminateStream({
          ...scope,
          outcome: "failed",
          body: { ...body, state: "incomplete" },
        }),
      () =>
        f.catalog.markStreamUnavailable({
          ...scope,
          outcome: "failed",
          availability: "missing",
        }),
      () => f.catalog.discardStream(scope),
      () => f.catalog.retainStream({ ...scope, retention: "observation" }),
      () => f.catalog.pruneStream(scope),
      () => f.catalog.markStreamPurgePending(scope),
      () =>
        f.catalog.pruneTerminalMetadata({
          retentionMs: 0,
          now: new Date("2030-01-01"),
        }),
      () => f.catalog.reconcile(),
      () =>
        f.db.transaction((tx) => f.catalog.lockScope(tx, scope.operationId)),
      () =>
        f.db.transaction((tx) =>
          f.catalog.failDeliveryStreams(tx, {
            operationId: scope.operationId,
            deliveryId: "delivery",
            outcome: "failed",
          })
        ),
      () =>
        f.db.transaction((tx) =>
          f.catalog.requestCancellation(
            tx,
            scope.namespace,
            scope.operationId,
            "cancel",
          )
        ),
      () =>
        f.db.transaction((tx) =>
          terminalizeOperationSettlement(tx, f.schema, scope, {
            commandTime: "2026-10-18T00:00:00Z",
            expected: { nextEventOrdinal: "2", nextStreamOrdinal: "2" },
            beforeTerminal() {
              callbacks++;
              return Promise.resolve();
            },
          })
        ),
    ];
    for (const operation of operations) {
      await refused(operation);
      assertEquals(await f.snapshot(), before);
    }
    assertEquals(hints, 0);
    assertEquals(callbacks, 0);
    unsubscribe();
  } finally {
    await f.db.close();
  }
});
Deno.test("foreign format blocks absent-operation admission and duplicate recovery callbacks", async () => {
  const f = await fixture();
  try {
    const draft = {
      type: "example.created",
      namespace: "tenant",
      payload: { id: "one" },
      deduplicationId: "dedup",
    };
    await f.store.append(draft, []);
    await f.foreign();
    const before = await f.snapshot();
    let recovered = 0, mutated = 0;
    await refused(() =>
      f.store.commitMutation({
        draft,
        consumers: [],
        recoverDuplicate() {
          recovered++;
          return Promise.resolve();
        },
      })
    );
    await assertRejects(() =>
      f.store.commitMutation({
        draft: { ...draft, deduplicationId: "fresh" },
        body: { id: "body", json: { important: true } },
        consumers: [{ consumerId: "consumer", settlement: "inherit" }],
        mutate() {
          mutated++;
          return Promise.resolve();
        },
      })
    );
    assertEquals(recovered, 0);
    assertEquals(mutated, 0);
    assertEquals(await f.snapshot(), before);
  } finally {
    await f.db.close();
  }
});
Deno.test("foreign format blocks standalone synchronous catalog indexing CTEs", async () => {
  const f = await fixture();
  try {
    await f.foreign();
    const before = await f.snapshot();
    const params: unknown[] = [];
    const sql = f.catalog.indexEventSql({
      namespace: "tenant",
      operationId: "new",
      eventId: "new",
      correlationId: "new",
      createdAt: "2026-10-18T00:00:00Z",
    }, (value) => `$${params.push(value)}`);
    await f.db.query(
      `WITH inserted_event AS (SELECT 1::bigint AS position), inserted_deliveries AS (SELECT 'internal'::text AS settlement_scope_id, 'pending'::text AS status), ${sql} SELECT * FROM indexed_event`,
      params,
    );
    assertEquals(await f.snapshot(), before);
  } finally {
    await f.db.close();
  }
});
Deno.test("core provisioning refuses a foreign catalog-only namespace without adding relations", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await db.query("CREATE SCHEMA foreign_catalog");
    await db.query(
      "CREATE TABLE foreign_catalog.copilotz_operation_catalog_metadata(singleton boolean PRIMARY KEY, fingerprint text NOT NULL)",
    );
    await db.query(
      "INSERT INTO foreign_catalog.copilotz_operation_catalog_metadata VALUES(TRUE,'owner-content-v1')",
    );
    await assertRejects(() => provisionCopilotzSchema(db, "foreign_catalog"));
    assertEquals(
      (await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='foreign_catalog'",
      )).rows,
      [{ table_name: "copilotz_operation_catalog_metadata" }],
    );
    await db.query(
      "UPDATE foreign_catalog.copilotz_operation_catalog_metadata SET fingerprint=$1",
      [OPERATION_CATALOG_FINGERPRINT],
    );
    await provisionCopilotzSchema(db, "foreign_catalog");
  } finally {
    await db.close();
  }
});
Deno.test("legacy memory and S3 engine scopes refuse foreign catalog format before storage work", async () => {
  const f = await fixture();
  try {
    const registry = await createPluginRegistry();
    await f.foreign();
    const before = await f.snapshot();
    const assets: BodyStorageOptions[] = [{ storage: { type: "memory" } }, {
      storage: {
        type: "s3",
        config: {
          backendId: "test",
          endpoint: "http://127.0.0.1:1",
          region: "auto",
          bucket: "bucket",
          accessKeyId: "test",
          secretAccessKey: "test",
        },
      },
    }];
    for (const storage of assets) {
      await refused(() =>
        createCopilotzEngine({
          session: f.db,
          registry,
          defaultDatabaseSchema: f.schema,
          assets: storage,
        })
      );
      const engine = await createCopilotzEngine({
        session: f.db,
        registry,
        defaultDatabaseSchema: "public",
        assets: storage,
      });
      try {
        await refused(() => engine.databaseScope(f.schema));
      } finally {
        await engine.shutdown();
      }
      assertEquals(await f.snapshot(), before);
    }
  } finally {
    await f.db.close();
  }
});

Deno.test("cached legacy scope refuses foreign format before recovery and maintenance", async () => {
  const f = await fixture();
  let engine: Awaited<ReturnType<typeof createCopilotzEngine>> | undefined;
  try {
    const registry = await createPluginRegistry();
    engine = await createCopilotzEngine({
      session: f.db,
      registry,
      defaultDatabaseSchema: f.schema,
      assets: { storage: { type: "memory" } },
    });
    const cached = await engine.databaseScope(f.schema);
    await f.foreign();
    const before = await f.snapshot();
    await refused(() => cached.recover());
    await refused(() => cached.maintenance());
    assertEquals(await f.snapshot(), before);
  } finally {
    try {
      await engine?.shutdown();
    } finally {
      await f.db.close();
    }
  }
});
