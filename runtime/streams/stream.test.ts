import { assertEquals, assertExists, assertRejects } from "@std/assert";

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
  ContentStreamOwnershipLostError,
  createContentStreamRuntime,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_content_streams";

async function streamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

Deno.test("content stream open reports only its normalized runtime-neutral descriptor", async () => {
  let opened: ContentStreamOpened | undefined;
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store: createMemoryBodyStore(),
    onOpen(input, publication) {
      opened = input;
      publication.established();
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
    semanticId: "stream-a",
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

Deno.test("content stream execution incarnations use distinct physical lanes", async () => {
  const store = createMemoryBodyStore();
  const opened: ContentStreamOpened[] = [];
  const first = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    incarnationId: "dispatch/one",
    onOpen(stream, publication) {
      opened.push(stream);
      publication.established();
    },
  });
  const second = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    incarnationId: "dispatch/two",
    onOpen(stream, publication) {
      opened.push(stream);
      publication.established();
    },
  });

  const stale = await first.open({
    id: "run-a:content:text/plain",
    mediaType: "text/plain",
    role: "content",
  });
  await stale.append({
    bytes: new TextEncoder().encode("partial-old"),
    appendId: "old-1",
  });
  const recovered = await second.open({
    id: "run-a:content:text/plain",
    mediaType: "text/plain",
    role: "content",
  });
  await recovered.append({
    bytes: new TextEncoder().encode("new"),
    appendId: "new-1",
  });

  assertEquals(opened.map((stream) => stream.semanticId), [
    "run-a:content:text/plain",
    "run-a:content:text/plain",
  ]);
  assertEquals(opened[0].id === opened[1].id, false);
  assertEquals(opened.map((stream) => stream.incarnationId), [
    "dispatch/one",
    "dispatch/two",
  ]);
  assertEquals(stale.offset(), "partial-old".length);
  assertEquals(recovered.offset(), "new".length);
  await stale.abort();
  await recovered.abort();
});

Deno.test("published stream abort freezes and replays its committed prefix", async () => {
  const store = createMemoryBodyStore();
  const callbacks: string[] = [];
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    onOpen(_opened, publication) {
      publication.established();
      callbacks.push("published");
    },
    onTerminalizing(_opened, terminal) {
      callbacks.push(`terminalizing:${terminal.outcome}:${terminal.capture}`);
    },
    onTerminate(_opened, body, terminal) {
      callbacks.push(`terminal:${terminal.outcome}:${body?.state ?? "purged"}`);
    },
  });
  const writer = await stream.open({
    id: "failed-prefix",
    mediaType: "text/plain",
    role: "assistant",
  });
  await writer.append({
    bytes: new TextEncoder().encode("committed prefix"),
    appendId: "prefix:1",
  });
  await writer.abort({ outcome: "cancelled" });

  const head = await store.head({
    bodyId: "content-streams/tenant-a/failed-prefix",
  });
  assertExists(head);
  assertEquals(head.state, "incomplete");
  assertEquals(callbacks, [
    "published",
    "terminalizing:cancelled:truncated",
    "terminal:cancelled:incomplete",
  ]);
  const follower = await stream.follow({ id: "failed-prefix" });
  assertEquals(
    new TextDecoder().decode(await streamBytes(follower.body)),
    "committed prefix",
  );
});

Deno.test("execution cancellation freezes a published lane as cancelled", async () => {
  const store = createMemoryBodyStore();
  const lifetime = new AbortController();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => settle = resolve);
  let outcome: string | undefined;
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    signal: lifetime.signal,
    onOpen(_opened, publication) {
      publication.established();
    },
    onTerminate(_opened, _body, terminal) {
      outcome = terminal.outcome;
      settle();
    },
  });
  const writer = await stream.open({
    id: "cancelled-by-lifetime",
    mediaType: "text/plain",
    role: "assistant",
  });
  await writer.append({
    bytes: new TextEncoder().encode("prefix"),
    appendId: "prefix:1",
  });
  lifetime.abort(new DOMException("cancelled", "AbortError"));
  await writer.abort({ outcome: "cancelled" });
  await settled;

  assertEquals(outcome, "cancelled");
  assertEquals(
    (await store.head({
      bodyId: "content-streams/tenant-a/cancelled-by-lifetime",
    }))?.state,
    "incomplete",
  );
});

Deno.test("execution teardown marks a leaked published writer abandoned", async () => {
  const store = createMemoryBodyStore();
  const lifetime = new AbortController();
  let settle!: (outcome: string) => void;
  const settled = new Promise<string>((resolve) => settle = resolve);
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    signal: lifetime.signal,
    onOpen(_opened, publication) {
      publication.established();
    },
    onTerminate(_opened, _body, terminal) {
      settle(terminal.outcome);
    },
  });
  const writer = await stream.open({
    id: "leaked-after-success",
    mediaType: "text/plain",
    role: "assistant",
  });
  await writer.append({
    bytes: new TextEncoder().encode("prefix"),
    appendId: "prefix:1",
  });
  lifetime.abort(new Error("execution ended"));

  assertEquals(await settled, "abandoned");
  assertEquals(
    (await store.head({
      bodyId: "content-streams/tenant-a/leaked-after-success",
    }))?.state,
    "incomplete",
  );
});

Deno.test("lost durable ownership fences the physical writer", async () => {
  const store = createMemoryBodyStore();
  let terminalOutcome: string | undefined;
  const stream = createContentStreamRuntime({
    namespace: "tenant-a",
    store,
    onOpen(_opened, publication) {
      publication.established();
    },
    onAppend(opened) {
      throw new ContentStreamOwnershipLostError(opened.id);
    },
    onTerminate(_opened, _body, terminal) {
      terminalOutcome = terminal.outcome;
    },
  });
  const writer = await stream.open({
    id: "superseded-writer",
    mediaType: "text/plain",
    role: "assistant",
  });
  const follower = await stream.follow({ id: writer.id });
  await assertRejects(
    () =>
      writer.append({
        bytes: new TextEncoder().encode("zombie"),
        appendId: "zombie:1",
      }),
    ContentStreamOwnershipLostError,
    "lost durable write ownership",
  );
  assertEquals(
    new TextDecoder().decode(await streamBytes(follower.body)),
    "zombie",
  );
  assertEquals(terminalOutcome, "superseded");
  assertEquals(
    (await store.head({
      bodyId: "content-streams/tenant-a/superseded-writer",
    }))?.state,
    "incomplete",
  );
  await assertRejects(
    () =>
      writer.append({
        bytes: new Uint8Array([1]),
        appendId: "zombie:2",
      }),
    Error,
    "already settling",
  );
});

Deno.test("stream publication boundary separates discard from retained failure", async () => {
  const unpublishedStore = createMemoryBodyStore();
  let discarded = 0;
  await assertRejects(
    () =>
      createContentStreamRuntime({
        namespace: "tenant-a",
        store: unpublishedStore,
        onOpen() {
          throw new Error("not published");
        },
        onDiscard() {
          discarded += 1;
        },
      }).open({
        id: "unpublished",
        mediaType: "text/plain",
        role: "assistant",
      }),
    Error,
    "not published",
  );
  assertEquals(discarded, 1);
  assertEquals(
    await unpublishedStore.head({
      bodyId: "content-streams/tenant-a/unpublished",
    }),
    null,
  );

  const publishedStore = createMemoryBodyStore();
  let retainedState: string | undefined;
  await assertRejects(
    () =>
      createContentStreamRuntime({
        namespace: "tenant-a",
        store: publishedStore,
        onOpen(_opened, publication) {
          publication.established();
          throw new Error("publication relay failed");
        },
        onTerminate(_opened, body) {
          retainedState = body?.state;
        },
      }).open({
        id: "published",
        mediaType: "text/plain",
        role: "assistant",
      }),
    Error,
    "publication relay failed",
  );
  assertEquals(retainedState, "incomplete");
  assertEquals(
    (await publishedStore.head({
      bodyId: "content-streams/tenant-a/published",
    }))?.state,
    "incomplete",
  );
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
      bodyPrefix: `schemas/${TEST_SCHEMA}`,
      onOpen(_opened, publication) {
        publication.established();
      },
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
    assertEquals(
      prepared.assets[0].readyBody?.bodyId,
      `schemas/${TEST_SCHEMA}/content-streams/tenant-a/stream-a`,
    );

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
