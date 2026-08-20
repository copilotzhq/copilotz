import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createSqlSession,
  type DurableEvent,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createFeatureContext } from "../features/index.ts";
import {
  type CopilotzEngine,
  type CopilotzEngineDatabaseScope,
  createCopilotzEngine,
} from "../engine/index.ts";
import {
  createPluginRegistry,
  createTransientProcessorSet,
  withProcessorEventData,
} from "../plugins/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  type AttachmentOutput,
  type AttachmentStreamOutput,
  createAttachmentRuntime,
  type CreateAttachmentRuntimeOptions,
  type ThreadAttachment,
} from "./index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import type { AssetBodyHead, AssetBodyStore } from "../content/index.ts";

const NAMESPACE = "tenant-attachment-slice-1";
const THREAD_ID = "same-thread";
const PARTICIPANT_ID = "same-user";

type EngineFixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
}>;

async function createEngineFixture(schema: string): Promise<EngineFixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const registry = await createPluginRegistry({
    plugins: [coreCollectionsPlugin],
  });
  let nextId = 0;
  const engine = await createCopilotzEngine({
    session,
    registry,
    defaultDatabaseSchema: schema,
    createId: () => `attachment-regression-${++nextId}`,
    assets: { storage: { type: "memory" } },
    attachments: { settlementPollMs: 1 },
  });
  return Object.freeze({ db, engine });
}

async function createThread(
  engine: CopilotzEngine,
  scope: CopilotzEngineDatabaseScope,
): Promise<void> {
  const context = createFeatureContext({
    namespace: NAMESPACE,
    plugins: engine.plugins,
    collections: scope.collections,
    collectionRuntime: scope.collectionRuntime,
    contentResolver: scope.content.resolver,
    events: scope.events,
    deliveries: scope.deliveries,
    relations: scope.relations,
  });
  await context.features.thread.create({
    id: THREAD_ID,
    participants: [{
      id: PARTICIPANT_ID,
      externalId: PARTICIPANT_ID,
      participantType: "human",
      name: "Same User",
    }],
  }, {
    identity: {
      deduplicationId: `${scope.databaseSchema}:${THREAD_ID}:create`,
    },
  });
}

function isStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output;
}

async function nextStreamOutput(
  reader: ReadableStreamDefaultReader<AttachmentOutput>,
): Promise<AttachmentStreamOutput> {
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("Attachment outputs closed unexpectedly.");
    if (isStreamOutput(next.value)) return next.value;
  }
}

async function readBeforeTimeout(
  reader: ReadableStreamDefaultReader<AttachmentOutput>,
  timeoutMs: number,
): Promise<"timeout" | AttachmentOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then((next) => next.done ? "timeout" as const : next.value),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // Deliberately consume only after the no-demand assertion is sampled.
  }
}

Deno.test("attachment observers stay isolated to their physical database schema", async () => {
  const defaultSchema = "copilotz_attachment_scope_a";
  const otherSchema = "copilotz_attachment_scope_b";
  const fixture = await createEngineFixture(defaultSchema);
  const session = createSqlSession(fixture.db);
  let firstAttachment: ThreadAttachment | undefined;
  let secondAttachment: ThreadAttachment | undefined;
  let firstReader: ReadableStreamDefaultReader<AttachmentOutput> | undefined;
  let secondReader: ReadableStreamDefaultReader<AttachmentOutput> | undefined;
  try {
    await provisionCopilotzSchema(session, otherSchema);
    const first = await fixture.engine.databaseScope(defaultSchema);
    const second = await fixture.engine.databaseScope(otherSchema);
    await createThread(fixture.engine, first);
    await createThread(fixture.engine, second);
    firstAttachment = await first.connect({
      namespace: NAMESPACE,
      thread: THREAD_ID,
      participant: PARTICIPANT_ID,
    });
    secondAttachment = await second.connect({
      namespace: NAMESPACE,
      thread: THREAD_ID,
      participant: PARTICIPANT_ID,
    });
    firstReader = firstAttachment.outputs.getReader();
    secondReader = secondAttachment.outputs.getReader();

    const sent = await firstAttachment.send({
      content: "Schema A only",
      deduplicationId: "schema-a:message:create",
    });
    await sent.done;
    const firstOutput = await readBeforeTimeout(firstReader, 100);
    assert(
      firstOutput !== "timeout",
      "The sending attachment missed its event.",
    );

    const leaked = await readBeforeTimeout(secondReader, 50);
    assertEquals(
      leaked,
      "timeout",
      "An attachment in another physical schema observed the event.",
    );
  } finally {
    await firstReader?.cancel().catch(() => undefined);
    await secondReader?.cancel().catch(() => undefined);
    await firstAttachment?.close().catch(() => undefined);
    await secondAttachment?.close().catch(() => undefined);
    await fixture.engine.shutdown();
    await fixture.db.close();
  }
});

Deno.test("attachment message retries return the original deduplicated handle", async () => {
  const fixture = await createEngineFixture(
    "copilotz_attachment_deduplication",
  );
  let attachment: ThreadAttachment | undefined;
  try {
    const scope = await fixture.engine.databaseScope(
      "copilotz_attachment_deduplication",
    );
    await createThread(fixture.engine, scope);
    attachment = await scope.connect({
      namespace: NAMESPACE,
      thread: THREAD_ID,
      participant: PARTICIPANT_ID,
    });

    const first = await attachment.send({
      content: "Retry me once",
      deduplicationId: "message:stable-retry",
    });
    await first.done;
    const recovered = await attachment.send({
      content: "Retry me once",
      deduplicationId: "message:stable-retry",
    });
    await recovered.done;

    assertEquals(recovered.messageId, first.messageId);
    assertEquals(recovered.eventId, first.eventId);
    const messages = (await scope.events.list({
      namespace: NAMESPACE,
      threadId: THREAD_ID,
    })).filter((event) => event.type === "message.created");
    assertEquals(messages.length, 1);
  } finally {
    await attachment?.close().catch(() => undefined);
    await fixture.engine.shutdown();
    await fixture.db.close();
  }
});

type StreamHarness = Readonly<{
  attachment: ThreadAttachment;
  outputReader: ReadableStreamDefaultReader<AttachmentOutput>;
  output: AttachmentStreamOutput;
}>;

type StreamHarnessBase = Omit<StreamHarness, "output">;

type StreamHarnessOptions = Readonly<{
  waitForOutput: false;
  beforeStreamGet?: () => Promise<void>;
  onStoreOpen?: () => void;
}>;

function createStreamHarness(
  source: ReadableStream<Uint8Array>,
): Promise<StreamHarness>;
function createStreamHarness(
  source: ReadableStream<Uint8Array>,
  options: StreamHarnessOptions,
): Promise<StreamHarnessBase>;

async function createStreamHarness(
  source: ReadableStream<Uint8Array>,
  options?: StreamHarnessOptions,
): Promise<StreamHarness | StreamHarnessBase> {
  const timestamp = "2026-08-19T00:00:00.000Z";
  const head: AssetBodyHead = Object.freeze({
    key: "ignored-by-regression-store",
    byteLength: 64,
    mediaType: "application/octet-stream",
    digest: "sha256:attachment-stream-regression",
  });
  const store: AssetBodyStore = Object.freeze({
    kind: "memory",
    backendId: "memory:attachment-stream-regression",
    put: () => Promise.resolve(head),
    head: () => Promise.resolve(head),
    read: () => Promise.resolve(new Uint8Array()),
    open: () => {
      options?.onStoreOpen?.();
      return Promise.resolve(source);
    },
    delete: () => Promise.resolve(),
    async *list() {
      yield head;
    },
  });
  const records = {
    thread: {
      id: THREAD_ID,
      namespace: NAMESPACE,
      status: "active",
      participantIds: [PARTICIPANT_ID],
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    participant: {
      id: PARTICIPANT_ID,
      namespace: NAMESPACE,
      externalId: PARTICIPANT_ID,
      participantType: "human",
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    stream: {
      id: "stream-a",
      namespace: NAMESPACE,
      threadId: THREAD_ID,
      participantId: PARTICIPANT_ID,
      lane: "content",
      mediaType: "application/octet-stream",
      state: "closed",
      content: [{
        assetId: "asset-stream-a",
        kind: "binary",
        role: "body",
        mediaType: "application/octet-stream",
      }],
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  } as const;
  const transients = createTransientProcessorSet();
  const runtime = createAttachmentRuntime({
    databaseSchema: "copilotz_attachment_stream_harness",
    collectionRuntime: {
      withScope() {
        return Object.freeze(Object.fromEntries(
          Object.entries(records).map(([name, record]) => [
            name,
            Object.freeze({
              async get() {
                if (name === "stream") await options?.beforeStreamGet?.();
                return record;
              },
              queries: Object.freeze({}),
            }),
          ]),
        ));
      },
    },
    transients,
    streamBodyStore: store,
    createId: () => "stream-harness",
  } as unknown as CreateAttachmentRuntimeOptions);
  const attachment = await runtime.connect({
    namespace: NAMESPACE,
    thread: THREAD_ID,
    participant: PARTICIPANT_ID,
  });
  const outputReader = attachment.outputs.getReader();
  const event = Object.freeze({
    durable: true,
    id: "event-stream-created",
    position: "1",
    schemaVersion: 3,
    type: "stream.created",
    namespace: NAMESPACE,
    threadId: THREAD_ID,
    subject: { type: "stream", id: "stream-a" },
    payload: {},
    routing: { senderId: PARTICIPANT_ID },
    visibility: { kind: "public" },
    metadata: {},
    correlationId: "stream-correlation",
    createdAt: timestamp,
  }) as DurableEvent;
  const observer = transients.match(event).at(0);
  assertExists(observer);
  await observer.handle(withProcessorEventData(event, event.payload), {});
  if (options?.waitForOutput === false) {
    return Object.freeze({ attachment, outputReader });
  }
  const output = await nextStreamOutput(outputReader);
  return Object.freeze({ attachment, outputReader, output });
}

Deno.test("attachment stream followers do not drain before downstream demand", async () => {
  const totalChunks = 64;
  let pulls = 0;
  let announceDrained!: () => void;
  const fullyDrained = new Promise<void>((resolve) =>
    announceDrained = resolve
  );
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array([pulls]));
      if (pulls === totalChunks) {
        controller.close();
        announceDrained();
      }
    },
  }, { highWaterMark: 0 });
  const harness = await createStreamHarness(source);
  let pullsBeforeDemand = 0;
  try {
    await Promise.race([
      fullyDrained,
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
    pullsBeforeDemand = pulls;
    await drain(harness.output.payload);
  } finally {
    await harness.outputReader.cancel().catch(() => undefined);
    await harness.attachment.close().catch(() => undefined);
  }
  assert(
    pullsBeforeDemand < totalChunks,
    `The follower drained all ${totalChunks} chunks before the payload consumer read.`,
  );
});

Deno.test("closing an attachment cancels a reader-locked stream follower", async () => {
  let sourceCancelled = false;
  let pullCount = 0;
  let releasePendingPull: (() => void) | undefined;
  let announcePendingPull!: () => void;
  const pendingPull = new Promise<void>((resolve) => {
    announcePendingPull = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(new Uint8Array([1]));
        return;
      }
      announcePendingPull();
      return new Promise<void>((resolve) => releasePendingPull = resolve);
    },
    cancel() {
      sourceCancelled = true;
      releasePendingPull?.();
    },
  }, { highWaterMark: 0 });
  const harness = await createStreamHarness(source);
  const payloadReader = harness.output.payload.getReader();
  let cancelledByAttachment = false;
  try {
    await pendingPull;
    await harness.attachment.close("attachment_test_close");
    cancelledByAttachment = sourceCancelled;
  } finally {
    await payloadReader.cancel("regression_cleanup").catch(() => undefined);
    await harness.outputReader.cancel().catch(() => undefined);
    await harness.attachment.close().catch(() => undefined);
  }
  assertEquals(
    cancelledByAttachment,
    true,
    "Attachment close did not cancel the locked payload's follower.",
  );
});

Deno.test("closing during stream lookup prevents a late follower from opening", async () => {
  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    announceLookup = resolve
  );
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let opens = 0;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  const harness = await createStreamHarness(source, {
    waitForOutput: false,
    async beforeStreamGet() {
      announceLookup();
      await lookupBlocked;
    },
    onStoreOpen() {
      opens += 1;
    },
  });
  try {
    await lookupStarted;
    await harness.attachment.close("close_during_stream_lookup");
    releaseLookup();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assertEquals(opens, 0);
  } finally {
    releaseLookup?.();
    await harness.outputReader.cancel().catch(() => undefined);
    await harness.attachment.close().catch(() => undefined);
  }
});
