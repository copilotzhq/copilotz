import { assert, assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  type SqlSession,
} from "../events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import {
  type ContentError,
  createAssetStorageRuntime,
  createContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  createMemoryAssetBodyStore,
  type DatabaseAssetRepository,
  digestContent,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_database_assets";

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  assets: DatabaseAssetRepository;
  observed: string[];
}>;

async function createFixture(options: {
  maxDatabaseBytes?: number;
  storage?: Parameters<typeof createAssetStorageRuntime>[0];
} = {}) {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema: TEST_SCHEMA });
  const observed: string[] = [];
  const observer = defineProcessor({
    id: "asset.observe",
    on: ["asset.created", "asset.deleted"],
    delivery: "durable",
    handle(event) {
      observed.push(event.type);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.assets",
        version: "1.0.0",
        provides: { processors: [observer.id] },
      },
      resources: { processors: [observer] },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "asset-test",
    createContext: (base) => ({ ...base }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    databaseSchema: TEST_SCHEMA,
    createId: () => `asset-store-${++nextId}`,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
    storage: createAssetStorageRuntime(
      options.storage ?? {
        storage: {
          type: "database",
          config: { maxBytes: options.maxDatabaseBytes ?? 8 * 1024 * 1024 },
        },
      },
    ),
  });
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    assets,
    observed,
  });
}

async function closeFixture(fixture: Fixture) {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

async function waitForSettledDeliveries(fixture: Fixture) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const deliveries = await fixture.store.listDeliveries({
      namespace: "tenant-a",
    });
    if (
      deliveries.length > 0 &&
      deliveries.every((delivery) => delivery.status === "succeeded")
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Asset deliveries did not settle.");
}

Deno.test("database assets publish immutable bodies, events, and deliveries without body duplication", async () => {
  const fixture = await createFixture();
  try {
    const body = new TextEncoder().encode("durable hello");
    const first = await fixture.assets.publish({
      namespace: "tenant-a",
      id: "asset-a",
      idempotencyKey: "upload-a",
      mediaType: "text/plain; charset=utf-8",
      body,
      metadata: { origin: "test" },
    });
    assertEquals(first.id, "asset-a");
    assertEquals(first.location, { kind: "database", encoding: "utf8" });
    assertEquals(first.state, "ready");

    await waitForSettledDeliveries(fixture);
    assertEquals(fixture.observed, ["asset.created"]);
    const events = await fixture.store.listEvents({ namespace: "tenant-a" });
    assertEquals(events.length, 1);
    assertEquals(events[0].payload, { assetId: "asset-a" });
    assert(!JSON.stringify(events[0]).includes("durable hello"));

    const row = await fixture.session.query<{ data: unknown }>(
      `SELECT data FROM ${fixture.store.tables.nodes} WHERE id = 'asset-a'`,
    );
    assert(JSON.stringify(row.rows[0].data).includes("durable hello"));
    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", "asset-a")).bytes,
      ),
      "durable hello",
    );

    const replay = await fixture.assets.publish({
      namespace: "tenant-a",
      idempotencyKey: "upload-a",
      mediaType: "text/plain; charset=utf-8",
      body,
    });
    assertEquals(replay.id, first.id);
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).length,
      1,
    );

    const conflict = await assertRejects(() =>
      fixture.assets.publish({
        namespace: "tenant-a",
        idempotencyKey: "upload-a",
        mediaType: "text/plain; charset=utf-8",
        body: new TextEncoder().encode("different"),
      })
    );
    assertEquals((conflict as ContentError).code, "asset_conflict");
    assertEquals(await fixture.assets.get("tenant-b", "asset-a"), null);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("database assets batch and stream UTF-8, JSON, and binary bodies in caller order", async () => {
  const fixture = await createFixture();
  try {
    const values = [
      {
        id: "text-a",
        mediaType: "text/plain",
        body: new TextEncoder().encode("text"),
      },
      {
        id: "json-a",
        mediaType: "application/json",
        body: new TextEncoder().encode('{"answer":42}'),
      },
      {
        id: "binary-a",
        mediaType: "audio/pcm",
        body: new Uint8Array([0, 127, 128, 255]),
      },
    ];
    for (const value of values) {
      await fixture.assets.publish({ namespace: "tenant-a", ...value });
    }
    const bodies = await fixture.assets.readMany("tenant-a", [
      "binary-a",
      "text-a",
      "binary-a",
      "json-a",
    ]);
    assertEquals(bodies.map((item) => item.asset.id), [
      "binary-a",
      "text-a",
      "binary-a",
      "json-a",
    ]);
    assertEquals(bodies[0].bytes, new Uint8Array([0, 127, 128, 255]));

    const resolved = await createContentResolver({ assets: fixture.assets })
      .getMany([
        {
          assetId: "json-a",
          kind: "json",
          role: "tool.output",
          mediaType: "application/json",
        },
        {
          assetId: "text-a",
          kind: "text",
          role: "body",
          mediaType: "text/plain",
        },
      ], { namespace: "tenant-a" });
    assertEquals(resolved[0].value, { answer: 42 });
    assertEquals(resolved[1].text, "text");

    const reader = (await fixture.assets.open("tenant-a", "binary-a"))
      .getReader();
    assertEquals(
      (await reader.read()).value,
      new Uint8Array([0, 127, 128, 255]),
    );
    assertEquals((await reader.read()).done, true);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("prepared aggregate bodies roll back with their owner and semantic event", async () => {
  const fixture = await createFixture();
  try {
    const prepared = await createContentPreparer({
      createId: () => "asset-aggregate",
    }).prepare("atomic body", {
      namespace: "tenant-a",
      idempotencyKey: "aggregate-a",
    });
    await assertRejects(() =>
      fixture.coordinator.commitMutation({
        draft: {
          type: "example.created",
          namespace: "tenant-a",
          subject: { type: "example", id: "owner-a" },
          payload: { id: "owner-a" },
          deduplicationId: "example:owner-a",
        },
        mutate: async (context) => {
          const content = await fixture.assets.materialize(context, {
            namespace: "tenant-a",
            content: prepared,
          });
          await context.transaction.query(
            `INSERT INTO ${context.tables.nodes}
               (id, namespace, type, name, data)
             VALUES ('owner-a', 'tenant-a', 'example', 'owner-a', '{}')`,
          );
          await fixture.assets.linkOwner(context, {
            namespace: "tenant-a",
            ownerId: "owner-a",
            content,
          });
          throw new Error("fail after all aggregate writes");
        },
      })
    );
    assertEquals(await fixture.assets.get("tenant-a", "asset-aggregate"), null);
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).length,
      0,
    );
    const counts = await fixture.session.query<{
      nodes: number | string;
      edges: number | string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM ${fixture.store.tables.nodes}) AS nodes,
         (SELECT COUNT(*) FROM ${fixture.store.tables.edges}) AS edges`,
    );
    assertEquals(Number(counts.rows[0].nodes), 0);
    assertEquals(Number(counts.rows[0].edges), 0);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("database asset policy rejects oversized durable content before any write", async () => {
  const fixture = await createFixture({ maxDatabaseBytes: 3 });
  try {
    const error = await assertRejects(() =>
      fixture.assets.publish({
        namespace: "tenant-a",
        mediaType: "application/octet-stream",
        body: new Uint8Array([1, 2, 3, 4]),
      })
    );
    assertEquals(
      (error as ContentError).code,
      "asset_storage_unavailable",
    );
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).length,
      0,
    );
    const count = await fixture.session.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.nodes}`,
    );
    assertEquals(Number(count.rows[0].count), 0);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("object-backed assets persist provenance paths and keep bodies outside graph nodes", async () => {
  const memory = createMemoryAssetBodyStore({ backendId: "gcs:assets" });
  const objectStore = Object.freeze({ ...memory, kind: "object" as const });
  const fixture = await createFixture({
    storage: {
      storage: {
        type: "custom",
        config: { store: objectStore, prefix: "copilotz" },
      },
    },
  });
  try {
    const asset = await fixture.assets.publish({
      namespace: "tenant-a",
      id: "asset-object",
      mediaType: "application/json",
      body: new TextEncoder().encode('{"ok":true}'),
      origin: {
        scope: { type: "thread", id: "thread-a" },
        producer: { type: "tool_execution", id: "tool-a" },
        path: "/imageUrl",
      },
    });
    assertEquals(asset.location.kind, "object");
    assertEquals(
      asset.location.kind === "object" ? asset.location.key : "",
      "copilotz/schemas/copilotz_database_assets/namespaces/tenant-a/threads/thread-a/tool_execution/tool-a/assets/asset-object",
    );
    const row = await fixture.session.query<{ data: unknown }>(
      `SELECT data FROM ${fixture.store.tables.nodes} WHERE id = 'asset-object'`,
    );
    assertEquals(Object.hasOwn(row.rows[0].data as object, "body"), false);
    assertEquals(JSON.stringify(row.rows[0].data).includes("gcs:assets"), true);
    assertEquals(JSON.stringify(row.rows[0].data).includes("secret"), false);
    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", asset.id)).bytes,
      ),
      '{"ok":true}',
    );
    const streamed = await new Response(
      await fixture.assets.open("tenant-a", asset.id),
    ).text();
    assertEquals(streamed, '{"ok":true}');
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("asset maintenance retries body deletion and removes old orphan uploads", async () => {
  const memory = createMemoryAssetBodyStore({ backendId: "gcs:maintenance" });
  let rejectNextDelete = true;
  const objectStore = Object.freeze({
    ...memory,
    kind: "object" as const,
    async delete(key: string) {
      if (rejectNextDelete) {
        rejectNextDelete = false;
        throw new Error("temporary object outage");
      }
      await memory.delete(key);
    },
  });
  const fixture = await createFixture({
    storage: {
      storage: {
        type: "custom",
        config: { store: objectStore, prefix: "copilotz" },
      },
    },
  });
  try {
    const body = new TextEncoder().encode("delete me");
    const asset = await fixture.assets.publish({
      namespace: "tenant-a",
      id: "asset-delete",
      mediaType: "text/plain",
      body,
    });
    const key = asset.location.kind === "object" ? asset.location.key : "";
    await fixture.assets.markDeleted("tenant-a", asset.id);
    assert(await memory.head(key));
    const pendingDeletion = await fixture.session.query<{ data: unknown }>(
      `SELECT data FROM ${fixture.store.tables.nodes}
       WHERE id = 'asset-delete' AND type = 'asset'`,
    );
    assertEquals(
      (pendingDeletion.rows[0].data as Record<string, unknown>).bodyDeletedAt,
      undefined,
    );
    const pendingCount = await fixture.session.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.nodes}
       WHERE type = 'asset' AND (data ->> 'state') = 'deleted'
         AND (data ->> 'bodyDeletedAt') IS NULL
         AND (data -> 'location' ->> 'kind') <> 'database'`,
    );
    assertEquals(Number(pendingCount.rows[0].count), 1);

    const orphanBytes = new TextEncoder().encode("orphan");
    const orphanKey =
      "copilotz/schemas/copilotz_database_assets/namespaces/tenant-a/assets/orphan";
    await memory.put({
      key: orphanKey,
      bytes: orphanBytes,
      mediaType: "text/plain",
      digest: await digestContent(orphanBytes),
      ifAbsent: true,
    });

    const maintained = await fixture.assets.maintainBodies({
      now: new Date("2030-01-01T00:00:00.000Z"),
      orphanAfterMs: 24 * 60 * 60 * 1_000,
    });
    assertEquals(maintained, {
      retriedDeletions: 1,
      orphanedBodiesDeleted: 1,
    });
    assertEquals(await memory.head(key), null);
    assertEquals(await memory.head(orphanKey), null);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 database content core remains factory-first and Web-standard", async () => {
  for (
    const module of [
      "database-repository.ts",
      "digest.ts",
      "errors.ts",
      "index.ts",
      "input.ts",
      "normalizer.ts",
      "preparer.ts",
      "repository.ts",
      "resolver.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
  }
});
