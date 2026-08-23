import { assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import {
  createBodyStorageRuntime,
  createDatabaseAssetRepository,
  createDatabaseBodyStore,
  createMemoryBodyStore,
} from "../content/index.ts";
import {
  type ContentStreamOpened,
  createContentStreamRuntime,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_content_streams";

Deno.test("content stream open reports only its normalized runtime-neutral descriptor", async () => {
  let opened: ContentStreamOpened | undefined;
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store: createMemoryBodyStore(),
    onOpen(input) {
      opened = input;
    },
  });

  const writer = await stream.open({
    id: " stream-a ",
    mediaType: " text/plain ",
    role: " assistant ",
    name: " answer.txt ",
    alt: " answer ",
    language: " en ",
    disposition: "inline",
    metadata: { lane: "content" },
    correlationId: " correlation-a ",
  });

  assertEquals(opened, {
    id: "stream-a",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    name: "answer.txt",
    alt: "answer",
    language: "en",
    disposition: "inline",
    metadata: { lane: "content" },
    correlationId: "correlation-a",
  });
  assertEquals(
    "threadId" in (opened as unknown as Record<string, unknown>),
    false,
  );
  assertEquals(
    "participantId" in (opened as unknown as Record<string, unknown>),
    false,
  );
  assertEquals(
    "routing" in (opened as unknown as Record<string, unknown>),
    false,
  );
  assertEquals(
    "visibility" in (opened as unknown as Record<string, unknown>),
    false,
  );
  await writer.abort();
});

Deno.test("content stream open rejects unsafe metadata before opening a Body", async () => {
  let opened = 0;
  let reservations = 0;
  const backing = createMemoryBodyStore();
  const store = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === "reserve") {
        return async (...args: Parameters<typeof target.reserve>) => {
          reservations += 1;
          return await target.reserve(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    onOpen() {
      opened += 1;
    },
  });
  let read = false;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      read = true;
      return "forbidden";
    },
  });

  await assertRejects(
    () =>
      stream.open({
        mediaType: "text/plain",
        role: "assistant",
        metadata: accessor,
      }),
    TypeError,
    "enumerable data",
  );
  await assertRejects(
    () =>
      stream.open({
        mediaType: "text/plain",
        role: "assistant",
        metadata: { date: new Date() },
      }),
    TypeError,
    "plain",
  );
  assertEquals(read, false);
  assertEquals(opened, 0);
  assertEquals(reservations, 0);
});

Deno.test("content stream close returns prepared content without creating an Asset node", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    const session = createSqlSession(database);
    for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
      await session.query(statement);
    }
    const store = createEventStore({ session, schema: TEST_SCHEMA });
    const bodyStore = createDatabaseBodyStore({
      session,
      schema: TEST_SCHEMA,
    });
    const stream = createContentStreamRuntime({
      namespace: "tenant-a",
      store: bodyStore,
      createId: () => "stream-a",
    });

    const writer = await stream.open({
      mediaType: "text/plain; charset=utf-8",
      role: "body",
    });
    await writer.append({
      bytes: new TextEncoder().encode("hello"),
      appendId: "chunk-1",
    });
    const prepared = await writer.close({ assetId: "asset-a" });

    assertEquals(prepared.content, [{
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain; charset=utf-8",
    }]);
    assertEquals(prepared.assets.length, 1);
    assertEquals(prepared.assets[0].id, "asset-a");
    assertEquals(prepared.assets[0].readyBody?.state, "ready");

    const assets = await session.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ${store.tables.nodes}
        WHERE namespace = 'tenant-a'
          AND type = 'asset'`,
    );
    assertEquals(assets.rows[0].n, 0);

    const registry = createPluginRegistry();
    const executor = createDeliveryExecutor({
      store,
      registry,
      createContext: createTestProcessorContext,
      workerId: "content-stream-test",
    });
    try {
      const coordinator = createEventCoordinator({ store, registry, executor });
      const assets = createDatabaseAssetRepository({
        coordinator,
        session,
        eventStore: store,
        databaseSchema: TEST_SCHEMA,
        storage: createBodyStorageRuntime({
          storage: { type: "database" },
        }),
      });
      const adopted = await assets.materialize({
        namespace: "tenant-a",
        content: prepared,
      });
      assertEquals(adopted, prepared.content);
    } finally {
      await executor.shutdown();
    }

    const adoptedAssets = await session.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ${store.tables.nodes}
        WHERE namespace = 'tenant-a'
          AND type = 'asset'`,
    );
    assertEquals(adoptedAssets.rows[0].n, 1);

    const adoptedRefs = await session.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ${store.tables.nodes}
        WHERE namespace = 'tenant-a'
          AND type = 'asset'
          AND id = 'asset-a'
          AND data ->> 'state' = 'ready'
          AND COALESCE(data ->> 'bodyId', '') <> ''`,
    );
    assertEquals(adoptedRefs.rows[0].n, 1);
  } finally {
    await database.close();
  }
});
