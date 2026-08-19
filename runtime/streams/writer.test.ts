import { assertEquals, assertRejects } from "@std/assert";

import {
  streamCollection,
  threadCollection,
} from "../../plugins/core/index.ts";
import { createCollectionRuntime } from "../collections/index.ts";
import {
  createMemoryAssetBodyStore,
  digestContent,
  isContentError,
} from "../content/index.ts";
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
import { createStreamWriter, openStreamFollower } from "./index.ts";

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

async function createFixture() {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_stream_writer";
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
        id: "test.streams",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "stream-writer-test",
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    createId: () => `stream-${++nextId}`,
    now: () => new Date(NOW),
  });
  const threads = runtime.bind(threadCollection);
  const streams = runtime.bind(streamCollection);
  await threads.create({
    id: "thread-a",
    name: "Inbox",
    externalId: "ext-thread-a",
  }, { namespace: NAMESPACE });
  return Object.freeze({
    db,
    session,
    store,
    executor,
    streams,
    bodyStore: createMemoryAssetBodyStore(),
    close: async () => {
      await executor.shutdown();
      await db.close();
    },
  });
}

Deno.test("stream writer commits created before bytes and one terminal updated", async () => {
  const fixture = await createFixture();
  try {
    const writer = await createStreamWriter({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      threadId: "thread-a",
      lane: "content",
      mediaType: "text/plain",
      id: "stream-a",
      assetId: "asset-a",
    });
    await Promise.all(
      writer.created.dispatch.handles.map((handle) => handle.done),
    );
    assertEquals(writer.created.event.eventType, "stream.created");
    assertEquals(writer.created.record.state, "open");

    const follower = await openStreamFollower({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      streamId: writer.id,
    });
    const pending = readAll(follower.body);
    await writer.write(encoder.encode("hel"));
    await writer.write(encoder.encode("lo"));
    const head = await writer.finalize();
    assertEquals(decoder.decode(await pending), "hello");
    assertEquals(head.digest, await digestContent(encoder.encode("hello")));

    const record = await fixture.streams.get(writer.id, NAMESPACE);
    assertEquals(record?.state, "closed");
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
      events.some((event) =>
        event.type.includes("delta") || event.type === "stream.delta"
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("stream followers start from a committed offset and ignore chunk count", async () => {
  const fixture = await createFixture();
  try {
    const writer = await createStreamWriter({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      threadId: "thread-a",
      lane: "content",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("abcd"));
    const follower = await openStreamFollower({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      streamId: writer.id,
      offset: 2,
    });
    const pending = readAll(follower.body);
    await writer.finalize();
    assertEquals(decoder.decode(await pending), "cd");
    const events = await fixture.store.listEvents({
      namespace: NAMESPACE,
      limit: 100,
    });
    assertEquals(
      events.filter((event) => event.type.startsWith("stream.")).length,
      2,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("abandoning a stream errors followers and writes no ready body", async () => {
  const fixture = await createFixture();
  try {
    const writer = await createStreamWriter({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      threadId: "thread-a",
      lane: "content",
      mediaType: "text/plain",
    });
    const follower = await openStreamFollower({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      streamId: writer.id,
    });
    const pending = assertRejects(() => readAll(follower.body));
    await writer.write(encoder.encode("partial"));
    await writer.abandon("cancelled");
    const error = await pending;
    assertEquals(isContentError(error) && error.code, "asset_deleted");
    assertEquals(await fixture.bodyStore.head(writer.key), null);
    assertEquals(
      (await fixture.streams.get(writer.id, NAMESPACE))?.state,
      "abandoned",
    );
    const later = await assertRejects(() =>
      openStreamFollower({
        streams: fixture.streams,
        store: fixture.bodyStore,
        namespace: NAMESPACE,
        streamId: writer.id,
      })
    );
    assertEquals(isContentError(later) && later.code, "asset_deleted");
  } finally {
    await fixture.close();
  }
});

Deno.test("retain keeps a verified prefix and closes the stream", async () => {
  const fixture = await createFixture();
  try {
    const writer = await createStreamWriter({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      threadId: "thread-a",
      lane: "content",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("hello world"));
    const head = await writer.retain(5);
    assertEquals(head.byteLength, 5);
    assertEquals(
      await fixture.bodyStore.read(writer.key),
      encoder.encode("hello"),
    );
    const follower = await openStreamFollower({
      streams: fixture.streams,
      store: fixture.bodyStore,
      namespace: NAMESPACE,
      streamId: writer.id,
    });
    assertEquals(decoder.decode(await readAll(follower.body)), "hello");
    assertEquals(
      (await fixture.streams.get(writer.id, NAMESPACE))?.state,
      "closed",
    );
  } finally {
    await fixture.close();
  }
});
