import { createSchemaCommandRunner } from "../engine/commands.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  provisionCopilotzSchema,
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
  type BodyMaintenanceDeleteInput,
  type ContentError,
  createBodyStorageRuntime,
  createContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  createMemoryBodyStore,
  type DatabaseAssetRepository,
  digestContent,
  isPendingContentRef,
  maintainProgressiveBodies,
} from "./index.ts";
import { collectionAssetAdopterFor } from "./database-repository.ts";

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
  storage?: Parameters<typeof createBodyStorageRuntime>[0];
} = {}) {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const session = createSqlSession(db);
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await session.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  }
  await provisionCopilotzSchema(session, TEST_SCHEMA);
  const store = createEventStore({ session, schema: TEST_SCHEMA });
  const observed: string[] = [];
  const observer = defineProcessor({
    id: "asset.observe",
    on: [{ eventType: "asset.created" }, { eventType: "asset.deleted" }],
    handle(event) {
      observed.push(event.type);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.assets",
      version: "1.0.0",
      processors: { observer },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "asset-test",
    createContext: createTestProcessorContext,
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
    storage: createBodyStorageRuntime(
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
    assertEquals(
      (await fixture.assets.catalog.read(first.bodyId))!.copy.backendKind,
      "database",
    );
    assertEquals(
      (await fixture.assets.catalog.read(first.bodyId))!.copy.key,
      "schemas/copilotz_database_assets/namespaces/tenant-a/origins/namespace/tenant-a/assets/asset-a",
    );
    assertEquals(first.state, "ready");

    await waitForSettledDeliveries(fixture);
    assertEquals(fixture.observed, ["asset.created"]);
    const events = await fixture.store.listEvents({ namespace: "tenant-a" });
    assertEquals(events.length, 1);
    assert(
      typeof (events[0].payload as Record<string, unknown>).dataRef ===
        "object",
    );
    assert(!JSON.stringify(events[0]).includes("durable hello"));

    const row = await fixture.session.query<{ data: unknown }>(
      `SELECT data FROM ${fixture.store.tables.nodes} WHERE id = 'asset-a'`,
    );
    assertEquals(
      JSON.stringify(row.rows[0].data).includes("durable hello"),
      false,
    );
    const bodyRows = await fixture.session.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM "copilotz_database_assets"."content_bodies"
        WHERE body_id = $1`,
      [(await fixture.assets.catalog.read(first.bodyId))!.copy.key],
    );
    assertEquals(bodyRows.rows[0].n, 1);
    const refs = await fixture.session.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ${fixture.store.tables.nodes}
        WHERE namespace = 'tenant-a'
          AND type = 'asset'
          AND id = 'asset-a'
          AND data ->> 'state' = 'ready'
          AND data ->> 'bodyId' = $1`,
      [first.bodyId],
    );
    assertEquals(refs.rows[0].n, 1);
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

Deno.test("prepared bodies warm canonical reads after commit and remapping", async () => {
  const memory = createMemoryBodyStore({ backendId: "object:prepared-cache" });
  let bodyReads = 0;
  const objectStore = {
    ...memory,
    kind: "object" as const,
    async readRange(input: Parameters<typeof memory.readRange>[0]) {
      bodyReads += 1;
      return await memory.readRange(input);
    },
  };
  const storage = {
    storage: {
      type: "custom" as const,
      config: {
        store: objectStore,
        prefix: "prepared-cache",
        deployment: {
          durability: "ephemeral" as const,
          reach: "process" as const,
          readyGarbageCollection: false,
        },
      },
    },
  };
  const fixture = await createFixture({ storage });
  try {
    const bytes = new TextEncoder().encode("prepared cache body");
    const asset = await fixture.assets.publish({
      namespace: "tenant-a",
      id: "canonical-asset",
      idempotencyKey: "canonical-body",
      mediaType: "text/plain; charset=utf-8",
      body: bytes,
    });

    assertEquals(
      (await fixture.assets.read("tenant-a", asset.id)).bytes,
      bytes,
    );
    assertEquals(bodyReads, 0, "a freshly committed body is warm");

    const cold = createDatabaseAssetRepository({
      coordinator: fixture.coordinator,
      session: fixture.session,
      eventStore: fixture.store,
      databaseSchema: TEST_SCHEMA,
      storage: createBodyStorageRuntime(storage),
    });
    assertEquals((await cold.read("tenant-a", asset.id)).bytes, bytes);
    assertEquals(bodyReads, 1, "a new repository starts cold");

    const source = await createContentPreparer({
      createId: () => "prepared-loser",
    }).prepare("prepared cache body", {
      namespace: "tenant-a",
    });
    const refs = await cold.materialize({
      namespace: "tenant-a",
      content: {
        content: source.content,
        assets: [{ ...source.assets[0], idempotencyKey: "canonical-body" }],
      },
    });
    assertEquals(refs[0].assetId, asset.id, "dedup keeps the canonical ID");

    const beforeWarmRead = bodyReads;
    assertEquals((await cold.read("tenant-a", asset.id)).bytes, bytes);
    assertEquals(
      bodyReads,
      beforeWarmRead,
      "a remapped prepared body avoids a second storage read",
    );

    await cold.markDeleted("tenant-a", asset.id);
    await assertRejects(
      () => cold.read("tenant-a", asset.id),
      Error,
      "deleted",
    );
    assertEquals(bodyReads, beforeWarmRead, "deleted assets never serve cache");
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

Deno.test("standalone materialization emits its replayable Asset lifecycle", async () => {
  const fixture = await createFixture();
  try {
    const prepared = await createContentPreparer({
      createId: () => "asset-materialized",
    }).prepare("standalone result", {
      namespace: "tenant-a",
      idempotencyKey: "materialized-a",
    });
    const first = await fixture.assets.materialize({
      namespace: "tenant-a",
      content: prepared,
    });
    const retried = await fixture.assets.materialize({
      namespace: "tenant-a",
      content: prepared,
    });
    assertEquals(first, retried);
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).map(
        (event) => event.type,
      ),
      ["asset.created"],
    );

    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", "asset-materialized")).bytes,
      ),
      "standalone result",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("concurrent multi-Asset materialization remaps a raced idempotency key", async () => {
  const fixture = await createFixture();
  try {
    const prepare = async (
      id: string,
      value: string,
      idempotencyKey: string,
    ) =>
      await createContentPreparer({ createId: () => id }).prepare(value, {
        namespace: "tenant-a",
        idempotencyKey,
      });
    const [sharedLeft, sharedRight, leftOnly, rightOnly] = await Promise.all([
      prepare("asset-shared-left", "shared", "race-shared"),
      prepare("asset-shared-right", "shared", "race-shared"),
      prepare("asset-left-only", "left", "race-left"),
      prepare("asset-right-only", "right", "race-right"),
    ]);
    const left = Object.freeze({
      content: Object.freeze([
        sharedLeft.content[0],
        leftOnly.content[0],
      ]),
      assets: Object.freeze([
        sharedLeft.assets[0],
        leftOnly.assets[0],
      ]),
    });
    const right = Object.freeze({
      content: Object.freeze([
        sharedRight.content[0],
        rightOnly.content[0],
      ]),
      assets: Object.freeze([
        sharedRight.assets[0],
        rightOnly.assets[0],
      ]),
    });
    const [leftRefs, rightRefs] = await Promise.all([
      fixture.assets.materialize({ namespace: "tenant-a", content: left }),
      fixture.assets.materialize({ namespace: "tenant-a", content: right }),
    ]);
    assertEquals(leftRefs[0].assetId, rightRefs[0].assetId);
    assert(await fixture.assets.get("tenant-a", leftRefs[1].assetId));
    assert(await fixture.assets.get("tenant-a", rightRefs[1].assetId));
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).filter(
        (event) => event.type === "asset.created",
      ).length,
      3,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("prepared aggregate bodies roll back with their owner and semantic event", async () => {
  const fixture = await createFixture();
  try {
    const adopter = collectionAssetAdopterFor(fixture.assets);
    const prepared = await createContentPreparer({
      createId: () => "asset-aggregate",
    }).prepare("atomic body", {
      namespace: "tenant-a",
      idempotencyKey: "aggregate-a",
    });
    const plan = await adopter.prepareMaterialization({
      namespace: "tenant-a",
      content: prepared,
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
          await adopter.adoptMaterialization(context, plan);
          await context.transaction.query(
            `INSERT INTO ${context.tables.nodes}
               (id, namespace, type, name, data)
             VALUES ('owner-a', 'tenant-a', 'example', 'owner-a', '{}')`,
          );
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

Deno.test("external bodies are prepared before Asset graph adoption", async () => {
  const memory = createMemoryBodyStore({ backendId: "gcs:planned-assets" });
  let puts = 0;
  const objectStore = Object.freeze({
    ...memory,
    kind: "object" as const,
    async put(input: Parameters<typeof memory.put>[0]) {
      puts++;
      return await memory.put(input);
    },
  });
  const fixture = await createFixture({
    storage: {
      storage: {
        type: "custom",
        config: {
          store: objectStore,
          prefix: "copilotz",
          deployment: {
            durability: "ephemeral",
            reach: "process",
            readyGarbageCollection: true,
          },
        },
      },
    },
  });
  try {
    const adopter = collectionAssetAdopterFor(fixture.assets);
    const prepared = await createContentPreparer({
      createId: () => "asset-planned-object",
    }).prepare("prepared outside SQL", {
      namespace: "tenant-a",
      idempotencyKey: "planned-object",
    });
    const plan = await adopter.prepareMaterialization({
      namespace: "tenant-a",
      content: prepared,
    });

    assertEquals(puts, 1);
    assertEquals(plan.adoptions.map((item) => item.kind), ["ready"]);
    assertEquals(plan.assets.length, 1);
    assert(
      await memory.head({
        bodyId:
          (await fixture.assets.catalog.read(plan.assets[0].bodyId))!.copy.key,
      }),
    );
    assertEquals(
      await fixture.assets.get("tenant-a", "asset-planned-object"),
      null,
    );

    await createSchemaCommandRunner(fixture.session, TEST_SCHEMA)(
      "test.mutation",
      {},
      (_input, { transaction: transaction }) =>
        adopter.adoptMaterialization({
          transaction,
          tables: fixture.store.tables,
        }, plan),
    );

    assertEquals(puts, 1);
    assert(await fixture.assets.get("tenant-a", "asset-planned-object"));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("database bytes are reserved before atomic Asset graph adoption", async () => {
  const fixture = await createFixture();
  try {
    const adopter = collectionAssetAdopterFor(fixture.assets);
    const prepared = await createContentPreparer({
      createId: () => "asset-planned-database",
    }).prepare("adopt inside SQL", {
      namespace: "tenant-a",
      idempotencyKey: "planned-database",
    });
    const plan = await adopter.prepareMaterialization({
      namespace: "tenant-a",
      content: prepared,
    });
    const bodyId =
      (await fixture.assets.catalog.read(plan.assets[0].bodyId))!.copy.key;
    const bodyRows = async () =>
      (await fixture.session.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM "copilotz_database_assets"."content_bodies"
          WHERE body_id = $1`,
        [bodyId],
      )).rows[0].n;

    assertEquals(plan.adoptions.map((item) => item.kind), ["ready"]);
    assertEquals(await bodyRows(), 1);
    assertEquals(
      await fixture.assets.get("tenant-a", "asset-planned-database"),
      null,
    );

    await createSchemaCommandRunner(fixture.session, TEST_SCHEMA)(
      "test.mutation",
      {},
      (_input, { transaction: transaction }) =>
        adopter.adoptMaterialization({
          transaction,
          tables: fixture.store.tables,
        }, plan),
    );

    assertEquals(await bodyRows(), 1);
    assert(await fixture.assets.get("tenant-a", "asset-planned-database"));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("database asset policy stores large durable content through BodyStore", async () => {
  const fixture = await createFixture({ maxDatabaseBytes: 3 });
  try {
    const asset = await fixture.assets.publish({
      namespace: "tenant-a",
      mediaType: "application/octet-stream",
      body: new Uint8Array([1, 2, 3, 4]),
    });
    assertEquals(
      (await fixture.assets.catalog.read(asset.bodyId))!.copy.backendKind,
      "database",
    );
    assertEquals(
      (await fixture.assets.read("tenant-a", asset.id)).bytes,
      new Uint8Array([1, 2, 3, 4]),
    );
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).length,
      1,
    );
    const count = await fixture.session.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.nodes}`,
    );
    assertEquals(Number(count.rows[0].count), 1);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("object-backed assets persist provenance paths and keep bodies outside graph nodes", async () => {
  const memory = createMemoryBodyStore({ backendId: "gcs:assets" });
  const objectStore = Object.freeze({
    ...memory,
    kind: "object" as const,
  });
  const fixture = await createFixture({
    storage: {
      storage: {
        type: "custom",
        config: {
          store: objectStore,
          prefix: "copilotz",
          deployment: {
            durability: "ephemeral",
            reach: "process",
            readyGarbageCollection: true,
          },
        },
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
        type: " thread ",
        id: " thread-a ",
      },
    });
    assertEquals(asset.origin, { type: "thread", id: "thread-a" });
    assertEquals(
      (await fixture.assets.catalog.read(asset.bodyId))!.copy.backendKind,
      "object",
    );
    assertEquals(
      (await fixture.assets.catalog.read(asset.bodyId))!.copy.key,
      "copilotz/schemas/copilotz_database_assets/namespaces/tenant-a/origins/thread/thread-a/assets/asset-object",
    );
    const row = await fixture.session.query<{ data: unknown }>(
      `SELECT data FROM ${fixture.store.tables.nodes} WHERE id = 'asset-object'`,
    );
    assertEquals(Object.hasOwn(row.rows[0].data as object, "body"), false);
    assertEquals(
      JSON.stringify(row.rows[0].data).includes("gcs:assets"),
      false,
    );
    assertEquals(JSON.stringify(row.rows[0].data).includes("secret"), false);
    const missingReader = createDatabaseAssetRepository({
      coordinator: fixture.coordinator,
      session: fixture.session,
      eventStore: fixture.store,
      databaseSchema: TEST_SCHEMA,
      storage: createBodyStorageRuntime(),
    });
    const missingReaderError = await assertRejects(() =>
      missingReader.read("tenant-a", asset.id)
    );
    assertEquals(
      (missingReaderError as ContentError).code,
      "asset_storage_unavailable",
      "reading requires a configured object reader",
    );
    const mismatchedReader = createMemoryBodyStore({ backendId: "gcs:assets" });
    const bodyId = (await fixture.assets.catalog.read(asset.bodyId))!.copy.key;
    const wrongBytes = new TextEncoder().encode('{"ok":false}');
    await mismatchedReader.put({
      bodyId,
      bytes: wrongBytes,
      mediaType: "application/json",
      digest: await digestContent(wrongBytes),
    });
    const wrongReader = createDatabaseAssetRepository({
      coordinator: fixture.coordinator,
      session: fixture.session,
      eventStore: fixture.store,
      databaseSchema: TEST_SCHEMA,
      storage: createBodyStorageRuntime({ readers: [mismatchedReader] }),
    });
    const mismatchedReaderError = await assertRejects(() =>
      wrongReader.read("tenant-a", asset.id)
    );
    assertEquals(
      (mismatchedReaderError as ContentError).code,
      "asset_corrupted",
      "readers verify bytes against the immutable manifest",
    );
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
  const memory = createMemoryBodyStore({
    backendId: "gcs:maintenance",
  });
  let rejectNextDelete = true;
  const objectStore = Object.freeze({
    ...memory,
    kind: "object" as const,
    maintenance: {
      ...memory.maintenance,
      async delete(input: BodyMaintenanceDeleteInput) {
        if (rejectNextDelete) {
          rejectNextDelete = false;
          throw new Error("temporary object outage");
        }
        return await memory.maintenance.delete(input);
      },
    },
  });
  const fixture = await createFixture({
    storage: {
      storage: {
        type: "custom",
        config: {
          store: objectStore,
          prefix: "copilotz",
          deployment: {
            durability: "ephemeral",
            reach: "process",
            readyGarbageCollection: true,
          },
        },
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
    const key = (await fixture.assets.catalog.read(asset.bodyId))!.copy.key;
    await fixture.assets.markDeleted("tenant-a", asset.id);
    assert(await memory.head({ bodyId: key }));
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
         AND data->>'bodyId' IS NOT NULL`,
    );
    assertEquals(Number(pendingCount.rows[0].count), 1);

    const kept = await fixture.assets.publish({
      namespace: "tenant-a",
      id: "asset-keep",
      mediaType: "text/plain",
      body: new TextEncoder().encode("keep me"),
    });
    const keepKey = (await fixture.assets.catalog.read(kept.bodyId))!.copy.key;
    assert(await memory.head({ bodyId: keepKey }));

    const orphanBytes = new TextEncoder().encode("orphan");
    const orphanKey =
      "copilotz/schemas/copilotz_database_assets/namespaces/tenant-a/assets/orphan";
    await memory.put({
      bodyId: orphanKey,
      bytes: orphanBytes,
      mediaType: "text/plain",
      digest: await digestContent(orphanBytes),
      ifAbsent: true,
    });
    await createSchemaCommandRunner(fixture.session, TEST_SCHEMA)(
      "test.expire",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `UPDATE ${fixture.store.tables.content_logical_bodies} SET protected_until=NOW()-INTERVAL '1 second'`,
        );
      },
    );

    const maintained = await fixture.assets.maintainBodies({
      orphanAfterMs: 0,
    });
    assertEquals(maintained, {
      orphanedBodiesDeleted: 1,
    });
    assert(await memory.head({ bodyId: keepKey }));
    const pendingBody = await memory.head({ bodyId: key });
    const orphanBody = await memory.head({ bodyId: orphanKey });
    assertEquals(Number(pendingBody !== null) + Number(orphanBody !== null), 1);
    assertEquals(
      await fixture.assets.maintainBodies({
        orphanAfterMs: 0,
      }),
      { orphanedBodiesDeleted: 1 },
    );
    assertEquals(await memory.head({ bodyId: key }), null);
    assertEquals(await memory.head({ bodyId: orphanKey }), null);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("asset maintenance collects failed copies but preserves catalog retention", async () => {
  const memory = createMemoryBodyStore({
    backendId: "memory:incomplete-maintenance",
  });
  const fixture = await createFixture({
    storage: {
      storage: {
        type: "custom",
        config: { store: memory, prefix: "copilotz" },
      },
    },
  });
  const prefix = "copilotz/schemas/copilotz_database_assets/content-streams";
  const orphanId = `${prefix}/prepublication`;
  const retainedId = `${prefix}/catalog-retained`;
  try {
    for (const bodyId of [orphanId, retainedId]) {
      await fixture.assets.catalog.reserve({
        bodyId,
        writerId: bodyId,
        generation: 1,
        namespace: "tenant-a",
        copy: {
          key: bodyId,
          backendKind: memory.kind,
          backendId: memory.backendId,
        },
        protectForMs: 0,
      });
      const writer = await memory.reserve({
        bodyId,
        mediaType: "text/plain",
        reservationId: bodyId,
        generation: 1,
      });
      await memory.append({
        writer,
        expectedOffset: 0,
        appendId: "partial",
        bytes: new TextEncoder().encode("partial"),
      });
    }
    const recovered = await maintainProgressiveBodies(
      fixture.assets.catalog,
      () => memory,
    );
    assertEquals(recovered.terminated, 2);

    assertEquals(
      await fixture.assets.maintainBodies({
        orphanAfterMs: 0,
        isBodyRetained: (bodyId) => Promise.resolve(bodyId === retainedId),
      }),
      { orphanedBodiesDeleted: 1 },
    );
    assertEquals(await memory.head({ bodyId: orphanId }), null);
    assertEquals(
      (await memory.head({ bodyId: retainedId }))?.state,
      "open",
    );

    assertEquals(
      await fixture.assets.maintainBodies({
        orphanAfterMs: 0,
        isBodyRetained: () => Promise.resolve(false),
      }),
      { orphanedBodiesDeleted: 1 },
    );
    assertEquals(await memory.head({ bodyId: retainedId }), null);
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

Deno.test("retirement claim wins against later adoption without holding SQL across deletion", async () => {
  const memory = createMemoryBodyStore({ backendId: "memory:retirement-race" });
  let entered!: () => void, release!: () => void;
  const deleting = new Promise<void>((resolve) => entered = resolve),
    held = new Promise<void>((resolve) => release = resolve);
  const store = {
    ...memory,
    maintenance: {
      ...memory.maintenance,
      async delete(input: BodyMaintenanceDeleteInput) {
        entered();
        await held;
        return await memory.maintenance.delete(input);
      },
    },
  };
  const fixture = await createFixture({
    storage: { storage: { type: "custom", config: { store } } },
  });
  try {
    const prepared = await createContentPreparer({
      createId: () => "race-asset",
    }).prepare("original", { namespace: "tenant-a" });
    const plan = await collectionAssetAdopterFor(fixture.assets)
      .prepareMaterialization({ namespace: "tenant-a", content: prepared });
    const logical = (await fixture.assets.catalog.read(plan.assets[0].bodyId))!;
    await createSchemaCommandRunner(fixture.session, TEST_SCHEMA)(
      "test.expire",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `UPDATE ${fixture.store.tables.content_logical_bodies} SET protected_until=NOW()-INTERVAL '1 second'`,
        );
      },
    );
    const head = (await memory.head({ bodyId: logical.copy.key }))!;
    const retirement = fixture.assets.retireUnownedReadyBody({
      store,
      body: head,
    });
    await deleting;
    await assertRejects(() =>
      fixture.assets.materialize({ namespace: "tenant-a", content: prepared })
    );
    assertEquals(await fixture.assets.get("tenant-a", "race-asset"), null);
    release();
    assertEquals(await retirement, { status: "deleted" });
    await assertRejects(() =>
      fixture.assets.materialize({ namespace: "tenant-a", content: prepared })
    );
    assertEquals(
      (await fixture.session.query(
        `SELECT completed FROM ${fixture.store.tables.owner_body_retirements}`,
      )).rows[0]?.completed,
      true,
    );
  } finally {
    release();
    await closeFixture(fixture);
  }
});

Deno.test("pending adoption rolls back atomically, retries canonically, and rejects a different owner", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.assets.capture({
      namespace: "tenant-a",
      operationKey: "generated-three-roles",
      producer: "producer-a",
      content: [{ type: "text", text: "answer", role: "body" }, {
        type: "text",
        text: "reason",
        role: "reasoning",
      }, { type: "text", text: "native", role: "native-reasoning" }],
    });
    const origin = { type: "message", id: "owner-a" },
      adopter = collectionAssetAdopterFor(fixture.assets),
      plan = await adopter.prepareMaterialization({
        namespace: "tenant-a",
        content: pending,
        origin,
      });
    await assertRejects(() =>
      fixture.coordinator.commitMutation({
        draft: {
          type: "example.created",
          namespace: "tenant-a",
          subject: { type: "message", id: "owner-a" },
          payload: {},
        },
        mutate: async (context) => {
          await adopter.adoptMaterialization(context, plan);
          throw new Error("rollback owning mutation");
        },
      })
    );
    assertEquals(
      (await fixture.session.query(
        `SELECT 1 FROM ${fixture.store.tables.content_adoptions}`,
      )).rows.length,
      0,
    );
    assertEquals(
      (await fixture.session.query(
        `SELECT 1 FROM ${fixture.store.tables.nodes}`,
      )).rows.length,
      0,
    );
    const first = await fixture.assets.materialize({
      namespace: "tenant-a",
      content: pending,
      origin,
    });
    assertEquals(first.map((ref) => ref.role), [
      "body",
      "reasoning",
      "native-reasoning",
    ]);
    assertEquals(
      await fixture.assets.materialize({
        namespace: "tenant-a",
        content: pending,
        origin,
      }),
      first,
    );
    await assertRejects(() =>
      fixture.assets.materialize({
        namespace: "tenant-a",
        content: pending,
        origin: { type: "message", id: "owner-b" },
      })
    );
    assertEquals(
      (await fixture.session.query(
        `SELECT 1 FROM ${fixture.store.tables.content_adoptions}`,
      )).rows.length,
      3,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("conditional collection keeps pending and owned copies but retires superseded owned copies", async () => {
  const memory = createMemoryBodyStore({ backendId: "memory:owned-copy" }),
    target = createMemoryBodyStore({ backendId: "memory:replacement" });
  const fixture = await createFixture({
    storage: {
      storage: { type: "custom", config: { store: memory } },
      readers: [target],
    },
  });
  try {
    const pending = await fixture.assets.capture({
      namespace: "tenant-a",
      operationKey: "pending-keep",
      producer: "producer-a",
      content: "kept",
    });
    const descriptor = pending[0];
    assert(isPendingContentRef(descriptor));
    const logical =
        (await fixture.assets.catalog.resolvePending("tenant-a", descriptor))
          .body,
      head = (await memory.head({ bodyId: logical.copy.key }))!;
    await createSchemaCommandRunner(fixture.session, TEST_SCHEMA)(
      "test.expire",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `UPDATE ${fixture.store.tables.content_logical_bodies} SET protected_until=NOW()-INTERVAL '1 second'`,
        );
      },
    );
    assertEquals(
      await fixture.assets.retireUnownedReadyBody({
        store: memory,
        body: head,
      }),
      { status: "blocked" },
    );
    const refs = await fixture.assets.materialize({
      namespace: "tenant-a",
      content: pending,
      origin: { type: "message", id: "owner" },
    });
    assertEquals(
      (await fixture.assets.retireUnownedReadyBody({
        store: memory,
        body: head,
      })).status,
      "owned",
    );
    const { promoteLogicalBody } = await import("./promoted-body-store.ts");
    await promoteLogicalBody({
      catalog: fixture.assets.catalog,
      bodyId: logical.bodyId,
      storeFor: fixture.assets.storeForCopy,
      target,
      targetKey: "replacement",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    assertEquals(
      await fixture.assets.retireUnownedReadyBody({
        store: memory,
        body: head,
      }),
      { status: "deleted" },
    );
    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", refs[0].assetId)).bytes,
      ),
      "kept",
    );
    const unsupported = { ...target, conditionalDelete: false };
    const replacement = (await target.head({ bodyId: "replacement" }))!;
    assertEquals(
      await fixture.assets.retireUnownedReadyBody({
        store: unsupported,
        body: replacement,
      }),
      { status: "blocked" },
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("asset reads and pending adoption re-resolve a copy retired during head preflight", async () => {
  const memory = createMemoryBodyStore({
      backendId: "memory:preflight-source",
    }),
    target = createMemoryBodyStore({ backendId: "memory:preflight-target" });
  let switchCopy: (() => Promise<void>) | undefined;
  const store = {
    ...memory,
    async head(input: { bodyId: string }) {
      const switching = switchCopy;
      switchCopy = undefined;
      if (switching) await switching();
      return await memory.head(input);
    },
  };
  const fixture = await createFixture({
    storage: {
      storage: { type: "custom", config: { store } },
      readers: [target],
    },
  });
  try {
    const { promoteLogicalBody } = await import("./promoted-body-store.ts");
    const arm = async (bodyId: string, targetKey: string) => {
      const body = (await fixture.assets.catalog.read(bodyId))!,
        head = (await memory.head({ bodyId: body.copy.key }))!;
      switchCopy = async () => {
        await promoteLogicalBody({
          catalog: fixture.assets.catalog,
          bodyId,
          storeFor: fixture.assets.storeForCopy,
          target,
          targetKey,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
        await memory.maintenance.delete({
          bodyId: body.copy.key,
          expectedState: "ready",
          expectedVersionToken: head.versionToken,
          idleForMs: 0,
        });
      };
    };
    const asset = await fixture.assets.publish({
      namespace: "tenant-a",
      id: "read-race",
      mediaType: "text/plain",
      body: new TextEncoder().encode("preserved"),
    });
    await arm(asset.bodyId, "read-target");
    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", asset.id)).bytes,
      ),
      "preserved",
    );
    const pending = await fixture.assets.capture({
      namespace: "tenant-a",
      operationKey: "adoption-race",
      producer: "producer",
      content: "captured",
    });
    assert(isPendingContentRef(pending[0]));
    const body =
      (await fixture.assets.catalog.resolvePending("tenant-a", pending[0]))
        .body;
    await arm(body.bodyId, "adoption-target");
    const refs = await fixture.assets.materialize({
      namespace: "tenant-a",
      content: pending,
      origin: { type: "message", id: "owner" },
    });
    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", refs[0].assetId)).bytes,
      ),
      "captured",
    );
  } finally {
    await closeFixture(fixture);
  }
});
