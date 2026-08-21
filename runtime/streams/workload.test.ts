import { coreFeatureAliases } from "@copilotz/copilotz/plugins/core";
import { assertEquals, assertRejects } from "@std/assert";
import {
  streamCollection,
  threadCollection,
} from "../../plugins/core/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";
import { createCollectionRuntime } from "../collections/index.ts";
import { createMemoryBodyStore } from "../content/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import {
  COPILOTZ_STREAM_RESULT_SCHEMA,
  COPILOTZ_STREAM_WORKLOAD,
  createStreamWorkload,
  jsonStreamDispatchMetadata,
} from "./index.ts";

const NAMESPACE = "tenant-a";
const NOW = "2026-08-18T00:00:00.000Z";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function byteStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

async function createFixture() {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_stream_workload";
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const processor = defineProcessor({
    id: "stream.audit",
    on: [{ eventType: "stream.created" }, { eventType: "stream.updated" }],
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.stream-workload",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const bodyStore = createMemoryBodyStore();
  let collectionRuntime!: ReturnType<typeof createCollectionRuntime>;
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "stream-workload-test",
    defaultDatabaseSchema: schema,
    workloads: {
      [COPILOTZ_STREAM_WORKLOAD]: createStreamWorkload({
        resolve: () => ({ collectionRuntime, store: bodyStore }),
      }),
    },
    localWorkloadWorkers: {
      [COPILOTZ_STREAM_WORKLOAD]: {
        workerId: "stream-oxian-test",
        capacity: 2,
      },
    },
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    now: () => new Date(NOW),
  });
  collectionRuntime = runtime;
  runtime.bind(threadCollection);
  runtime.bind(streamCollection);
  const { thread: threads, stream: streams } = runtime.withScope({
    namespace: NAMESPACE,
  });
  await threads.create({
    id: "thread-a",
    name: "Inbox",
    externalId: "ext-thread-a",
  });
  return Object.freeze({
    db,
    store,
    executor,
    streams,
    schema,
    close: async () => {
      await executor.shutdown();
      await db.close();
    },
  });
}

Deno.test("Oxian stream write persists bytes and returns a live follower", async () => {
  const fixture = await createFixture();
  try {
    const work = await fixture.executor.dispatchWork({
      workload: COPILOTZ_STREAM_WORKLOAD,
      metadata: jsonStreamDispatchMetadata({
        schema: "copilotz.stream.dispatch.v1",
        databaseSchema: fixture.schema,
        action: "write",
        namespace: NAMESPACE,
        threadId: "thread-a",
        lane: "content",
        mediaType: "text/plain",
        streamId: "stream-a",
      }),
      body: byteStream("hello oxian"),
    });
    const metadata = await work.metadata;
    assertEquals(metadata.schema, COPILOTZ_STREAM_RESULT_SCHEMA);
    assertEquals(metadata.action, "write");
    assertEquals(metadata.streamId, "stream-a");
    assertEquals(metadata.hasOutput, true);
    assertEquals(decoder.decode(await readAll(work.output)), "hello oxian");
    assertEquals((await work.completed).status, "completed");

    const events = await fixture.store.listEvents({
      namespace: NAMESPACE,
      limit: 100,
    });
    assertEquals(
      events.filter((event) => event.type.startsWith("stream.")).map((event) =>
        event.type
      ),
      ["stream.created", "stream.updated"],
    );
    assertEquals(
      events.some((event) => event.type.includes("delta")),
      false,
    );

    const follow = await fixture.executor.dispatchWork({
      workload: COPILOTZ_STREAM_WORKLOAD,
      metadata: jsonStreamDispatchMetadata({
        schema: "copilotz.stream.dispatch.v1",
        databaseSchema: fixture.schema,
        action: "follow",
        namespace: NAMESPACE,
        threadId: "thread-a",
        streamId: "stream-a",
        offset: 6,
      }),
    });
    assertEquals(decoder.decode(await readAll(follow.output)), "oxian");
  } finally {
    await fixture.close();
  }
});

Deno.test("Oxian stream cancel abandons the durable stream", async () => {
  const fixture = await createFixture();
  try {
    const input = new ReadableStream<Uint8Array>({
      start() {
        // Stay open until the Oxian operation is cancelled.
      },
    });
    const work = await fixture.executor.dispatchWork({
      workload: COPILOTZ_STREAM_WORKLOAD,
      metadata: jsonStreamDispatchMetadata({
        schema: "copilotz.stream.dispatch.v1",
        databaseSchema: fixture.schema,
        action: "write",
        namespace: NAMESPACE,
        threadId: "thread-a",
        lane: "content",
        mediaType: "text/plain",
        streamId: "stream-cancel",
      }),
      body: input,
    });
    await work.metadata;
    await work.cancel("barge_in");
    await work.completed.catch(() => undefined);
    await assertRejects(() => readAll(work.output));
    let state = "open";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = String(
        (await fixture.streams.get({ id: "stream-cancel" }))?.state ??
          "missing",
      );
      if (state === "abandoned") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(state, "abandoned");
  } finally {
    await fixture.close();
  }
});

Deno.test("engine stream workload write and follow share one body store", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const registry = await createPluginRegistry({
    plugins: [coreCollectionsPlugin],
  });
  const engine = await createCopilotzEngine({
    session,
    registry,
    defaultDatabaseSchema: "copilotz_stream_engine",
  });
  try {
    await createTestDomainContext(engine, NAMESPACE, coreFeatureAliases)
      .features.thread.create({
        id: "thread-a",
        participants: [{
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        }],
      });
    const work = await engine.execution.dispatchWork({
      workload: engine.execution.streamWorkload,
      metadata: jsonStreamDispatchMetadata({
        schema: "copilotz.stream.dispatch.v1",
        databaseSchema: engine.databaseSchema,
        action: "write",
        namespace: NAMESPACE,
        threadId: "thread-a",
        lane: "content",
        mediaType: "text/plain",
      }),
      body: byteStream("engine path"),
    });
    const metadata = await work.metadata;
    assertEquals(typeof metadata.streamId, "string");
    assertEquals(decoder.decode(await readAll(work.output)), "engine path");
    await work.completed;
    const events = await engine.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
    });
    assertEquals(
      events.filter((event) => event.type.startsWith("stream.")).map((event) =>
        event.type
      ),
      ["stream.created", "stream.updated"],
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
