import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import type { Agent } from "../resources/index.ts";
import type { SqlSession } from "../events/index.ts";
import { createSqlSession } from "../events/index.ts";
import type { CopilotzEngine } from "../engine/index.ts";
import {
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "../engine/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type PluginRegistry,
  type Processor,
} from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { updateThreadRecord } from "../engine/collection-writes.ts";
import {
  type AttachmentOutput,
  type AttachmentStreamOutput,
  COPILOTZ_STREAM_WORKLOAD,
  createRealtimeStreamWorkload,
  defineRealtimeProviderResource,
  type RealtimeProviderResource,
} from "./index.ts";

const NAMESPACE = "tenant-attachments";
const SCHEMA = "copilotz_attachments";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  registry: PluginRegistry;
  engine: CopilotzEngine;
}>;

function agent(
  id: string,
  provider = "realtime.echo",
): Agent {
  return Object.freeze({
    id,
    name: id,
    role: `${id} agent`,
    runtimes: {
      realtime: { type: "realtime" as const, provider },
    },
  });
}

function echoProvider(
  id = "realtime.echo",
  onOpen?: (input: {
    streamId: string;
    signal: AbortSignal;
    metadata: Readonly<Record<string, unknown>>;
  }) => void,
): RealtimeProviderResource {
  return defineRealtimeProviderResource({
    id,
    type: "realtime",
    open(input) {
      onOpen?.(input);
      return {
        mediaType: "audio/pcm;rate=24000",
        metadata: { provider: id },
        output: input.input.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(
                encoder.encode(decoder.decode(chunk).toUpperCase()),
              );
            },
          }),
        ),
      };
    },
  });
}

async function registryFor(options: {
  agents?: readonly Agent[];
  providers?: readonly RealtimeProviderResource[];
  processors?: readonly Processor[];
} = {}): Promise<PluginRegistry> {
  const agents = options.agents ?? [agent("support")];
  const providers = options.providers ?? [echoProvider()];
  const processors = options.processors ?? [];
  return await createPluginRegistry({
    plugins: [coreCollectionsPlugin, definePlugin({
      manifest: {
        id: "test.attachments",
        version: "1.0.0",
        provides: {
          agents: agents.map((resource) => resource.id),
          llm: providers.map((resource) => resource.id),
          ...(processors.length
            ? { processors: processors.map((resource) => resource.id) }
            : {}),
        },
      },
      resources: {
        agents,
        llm: providers,
        ...(processors.length ? { processors } : {}),
      },
    })],
  });
}

async function createFixture(options: {
  registry?: PluginRegistry;
  execution?: Parameters<typeof createCopilotzEngine>[0]["execution"];
  transientProcessors?: Parameters<
    typeof createCopilotzEngine
  >[0]["transientProcessors"];
} = {}): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const registry = options.registry ?? await registryFor();
  let nextId = 0;
  const engine = await createCopilotzEngine({
    session,
    registry,
    transientProcessors: options.transientProcessors,
    defaultDatabaseSchema: SCHEMA,
    createId: () => `attachment-${++nextId}`,
    execution: options.execution,
    attachments: { settlementPollMs: 1 },
  });
  return Object.freeze({ db, session, registry, engine });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

async function createThread(
  engine: CopilotzEngine,
  agentIds: readonly string[] = ["support"],
): Promise<void> {
  await engine.conversation.createThread({
    namespace: NAMESPACE,
    id: "thread-a",
    participants: [
      {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
        name: "User A",
      },
      ...agentIds.map((id) => ({
        id: `participant:${id}`,
        externalId: id,
        participantType: "agent" as const,
        agentId: id,
        name: id,
      })),
    ],
    identity: { deduplicationId: "thread-a:create" },
  });
}

function isStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output &&
    output.payload instanceof ReadableStream;
}

async function nextStreamOutput(
  reader: ReadableStreamDefaultReader<AttachmentOutput>,
  streamId?: string,
): Promise<AttachmentStreamOutput> {
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("Attachment outputs closed unexpectedly.");
    if (
      isStreamOutput(next.value) &&
      (streamId === undefined || next.value.streamId === streamId)
    ) return next.value;
  }
}

async function nextSemanticType(
  reader: ReadableStreamDefaultReader<AttachmentOutput>,
  type: string,
) {
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("Attachment outputs closed unexpectedly.");
    if (!isStreamOutput(next.value) && next.value.type === type) {
      return next.value;
    }
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(merged);
}

function bytes(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

Deno.test("event-native run is a temporary attachment over one causal scope", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "test.run-gate",
    on: [{ eventType: "message.created" }],
    handle: () => gate,
  });
  const fixture = await createFixture({
    registry: await registryFor({ processors: [processor] }),
  });
  try {
    await createThread(fixture.engine);
    const run = await fixture.engine.run({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
      content: "Hello from run",
      correlationId: "run-a",
    });
    assertEquals(run.threadId, "thread-a");
    assertEquals(run.correlationId, "run-a");
    assert(!("queueId" in run));

    const event = await run.events.getReader().read();
    assertEquals(event.done, false);
    assertEquals(event.value?.type, "message.created");
    assert(event.value?.durable);
    assertEquals(event.value.id, run.eventId);

    let settled = false;
    run.done.then(() => settled = true).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(settled, false);
    release();
    await run.done;
    assertEquals(settled, true);

    const messageId = event.value?.durable ? event.value.subject?.id : null;
    assertExists(messageId);
    const message = await fixture.engine.conversation.getMessage(
      NAMESPACE,
      messageId,
    );
    assertExists(message);
    assertEquals(message.sender.id, "user-a");
    assertEquals(message.recipientIds, ["participant:support"]);
    assertEquals(
      (await fixture.engine.content.resolver.get(message.content[0], {
        namespace: NAMESPACE,
      })).text,
      "Hello from run",
    );
  } finally {
    release?.();
    await closeFixture(fixture);
  }
});

Deno.test("detached durable descendants do not block the triggering run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let announceDescendant!: () => void;
  const descendantStarted = new Promise<void>((resolve) => {
    announceDescendant = resolve;
  });
  const reserve = defineProcessor<CopilotzProcessorContext>({
    id: "test.detached-reserve",
    on: [{ eventType: "message.created" }],
    settlement: "detached",
    async handle(_event, context) {
      await updateThreadRecord(context, "thread-a", {
        metadata: { detached: true },
      }, { operationKey: "detached-reserve-thread" });
    },
  });
  const descendant = defineProcessor<CopilotzProcessorContext>({
    id: "test.detached-descendant",
    on: [{ eventType: "thread.updated" }],
    async handle() {
      announceDescendant();
      await gate;
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({ processors: [reserve, descendant] }),
  });
  try {
    await createThread(fixture.engine);
    const run = await fixture.engine.run({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
      content: "Consolidate later",
    });
    await descendantStarted;
    await run.done;

    const deliveries = await fixture.engine.deliveries.list({
      namespace: NAMESPACE,
    });
    const reserveDelivery = deliveries.find((delivery) =>
      delivery.consumerId === "processor:test.detached-reserve"
    );
    const descendantDelivery = deliveries.find((delivery) =>
      delivery.consumerId === "processor:test.detached-descendant"
    );
    assertExists(reserveDelivery);
    assertExists(descendantDelivery);
    assertEquals(
      descendantDelivery.settlementScopeId,
      reserveDelivery.settlementScopeId,
    );
    assert(
      reserveDelivery.settlementScopeId !== run.eventId,
      "detached processor must fork the foreground settlement scope",
    );
    assertEquals(descendantDelivery.status, "leased");
  } finally {
    release?.();
    await closeFixture(fixture);
  }
});

Deno.test("run cancellation aborts only its foreground settlement scope", async () => {
  let announceForegroundStarted!: () => void;
  const foregroundStarted = new Promise<void>((resolve) => {
    announceForegroundStarted = resolve;
  });
  let foregroundAborted = false;
  const foreground = defineProcessor<CopilotzProcessorContext>({
    id: "test.run-cancellation",
    on: [{ eventType: "message.created" }],
    async handle(_event, context) {
      announceForegroundStarted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          foregroundAborted = true;
          reject(context.signal.reason);
        };
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  let releaseDetached!: () => void;
  const detachedGate = new Promise<void>((resolve) => {
    releaseDetached = resolve;
  });
  let announceDetachedStarted!: () => void;
  const detachedStarted = new Promise<void>((resolve) => {
    announceDetachedStarted = resolve;
  });
  let detachedAborted = false;
  const detached = defineProcessor<CopilotzProcessorContext>({
    id: "test.detached-cancellation",
    on: [{ eventType: "message.created" }],
    settlement: "detached",
    async handle(_event, context) {
      announceDetachedStarted();
      context.signal.addEventListener("abort", () => detachedAborted = true, {
        once: true,
      });
      await detachedGate;
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({ processors: [foreground, detached] }),
  });
  try {
    await createThread(fixture.engine);
    const run = await fixture.engine.run({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
      content: "Cancel this run",
    });
    await Promise.all([foregroundStarted, detachedStarted]);
    const rejected = assertRejects(() => run.done, Error, "user_stop");
    await run.cancel("user_stop");
    await rejected;
    assertEquals(foregroundAborted, true);
    assertEquals(detachedAborted, false);

    let deliveries = await fixture.engine.deliveries.list({
      namespace: NAMESPACE,
    });
    assertEquals(deliveries.length, 2);
    assertEquals(
      deliveries.find((delivery) =>
        delivery.consumerId === "processor:test.run-cancellation"
      )?.status,
      "cancelled",
    );
    assertEquals(
      deliveries.find((delivery) =>
        delivery.consumerId === "processor:test.detached-cancellation"
      )?.status,
      "leased",
    );

    releaseDetached();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      deliveries = await fixture.engine.deliveries.list({
        namespace: NAMESPACE,
      });
      if (
        deliveries.find((delivery) =>
          delivery.consumerId === "processor:test.detached-cancellation"
        )?.status === "succeeded"
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assertEquals(detachedAborted, false);
    assertEquals(
      deliveries.find((delivery) =>
        delivery.consumerId === "processor:test.detached-cancellation"
      )?.status,
      "succeeded",
    );
  } finally {
    releaseDetached?.();
    await closeFixture(fixture);
  }
});

Deno.test("persistent attachments unify messages and discrete durable/live events", async () => {
  const fixture = await createFixture();
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();

    const message = await attachment.send({
      content: [{ type: "text", text: "Persistent hello" }],
      correlationId: "message-correlation",
    });
    await message.done;
    const messageEvent = await nextSemanticType(reader, "message.created");
    assert(messageEvent.durable);
    assertEquals(messageEvent.id, message.eventId);

    const durable = await attachment.send({
      type: "control.ping",
      payload: { sequence: 1 },
      correlationId: "durable-correlation",
    });
    await durable.done;
    assertEquals(
      (await nextSemanticType(reader, "control.ping")).durable,
      true,
    );

    const live = await attachment.send({
      type: "control.cursor",
      payload: { x: 10 },
      durable: false,
      correlationId: "live-correlation",
    });
    await live.done;
    const liveOutput = await nextSemanticType(reader, "control.cursor");
    assertEquals(liveOutput.durable, false);
    assertEquals(live.eventId, undefined);

    await assertRejects(
      () => attachment.send({ content: "forged", sender: "support" }),
      Error,
      "cannot send as another participant",
    );
    const persisted = await fixture.engine.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
    });
    assert(persisted.some((event) => event.type === "control.ping"));
    assertEquals(
      persisted.some((event) => event.type === "control.cursor"),
      false,
    );

    await reader.cancel();
    await attachment.close();
    await attachment.close();
    await assertRejects(
      () => attachment.send({ type: "after.close", payload: null }),
      Error,
      "closed",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("ephemeral attachment handles settle with independent live processors", async () => {
  let release!: () => void;
  let announceStarted!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const started = new Promise<void>((resolve) => announceStarted = resolve);
  const live = defineProcessor({
    id: "test.attachment-live",
    on: [{ eventType: "control.cursor" }],
    async handle() {
      announceStarted();
      await gate;
    },
  });
  const fixture = await createFixture({
    transientProcessors: [live],
  });
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "control.cursor",
      payload: { x: 42 },
      durable: false,
      correlationId: "live-handle",
    });
    await started;
    let settled = false;
    handle.done.then(() => settled = true).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(settled, false);
    const event = await nextSemanticType(reader, "control.cursor");
    assertEquals(event.durable, false);
    release();
    await handle.done;
    assertEquals(settled, true);
    assertEquals(
      await fixture.engine.deliveries.list({ namespace: NAMESPACE }),
      [],
    );
    await reader.cancel();
  } finally {
    release?.();
    await closeFixture(fixture);
  }
});

Deno.test("one-call stream ingress stays raw and returns participant-labelled output", async () => {
  let inputController!: ReadableStreamDefaultController<Uint8Array>;
  let providerSignal: AbortSignal | undefined;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      inputController = controller;
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({
      providers: [echoProvider("realtime.echo", ({ signal }) => {
        providerSignal = signal;
      })],
    }),
  });
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await Promise.race([
      attachment.send({
        type: "audio.input",
        mediaType: "audio/pcm;rate=24000",
        payload: input,
        correlationId: "stream-correlation",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Stream send waited for input EOF.")),
          500,
        )
      ),
    ]);
    const output = await nextStreamOutput(reader, handle.streamId);
    assertExists(providerSignal);
    assertEquals(providerSignal.aborted, false);
    assertEquals(output.participant.id, "participant:support");
    assertEquals(output.participant.externalId, "support");
    assertEquals(output.mediaType, "audio/pcm;rate=24000");
    assertEquals(output.correlationId, "stream-correlation");

    for (const value of ["one-", "two-", "three"]) {
      inputController.enqueue(encoder.encode(value));
    }
    inputController.close();
    assertEquals(await readText(output.payload), "ONE-TWO-THREE");
    await handle.done;
    await nextSemanticType(reader, "stream.closed");

    const events = await fixture.engine.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
      correlationId: "stream-correlation",
    });
    assertEquals(events.map((event) => event.type), [
      "stream.opened",
      "stream.closed",
    ]);
    assertEquals(
      events.some((event) => event.type.endsWith(".delta")),
      false,
    );
    assertEquals(
      await fixture.engine.deliveries.list({ namespace: NAMESPACE }),
      [],
    );
    const assets = await fixture.session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${SCHEMA}.nodes
       WHERE namespace = $1 AND type = 'asset'
         AND id NOT LIKE 'event-body:%'`,
      [NAMESPACE],
    );
    assertEquals(Number(assets.rows[0].count), 0);

    await reader.cancel();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("realtime ingress and output preserve Web Stream backpressure", async () => {
  // Oxian intentionally buffers a bounded amount at each side of the
  // in-process bridge. Make the source substantially larger than those
  // transport windows so this verifies backpressure instead of zero buffering.
  const totalChunks = 1024;
  const chunk = encoder.encode("x".repeat(1024));
  let pulls = 0;
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
      if (pulls === totalChunks) controller.close();
    },
  }, { highWaterMark: 0 });
  const fixture = await createFixture();
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: input,
    });
    const output = await nextStreamOutput(reader, handle.streamId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      pulls < totalChunks,
      `Input was fully drained before the output consumer read (${pulls} pulls).`,
    );
    let outputBytes = 0;
    for await (const value of output.payload) outputBytes += value.byteLength;
    assertEquals(outputBytes, totalChunks * chunk.byteLength);
    assertEquals(pulls, totalChunks);
    await handle.done;
    await reader.cancel();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("realtime providers can emit durable semantic work in the stream causal scope", async () => {
  const semanticProvider = defineRealtimeProviderResource({
    id: "realtime.semantic",
    type: "realtime",
    open(input) {
      assertExists(input.context);
      const context = input.context;
      return {
        mediaType: "audio/pcm;rate=24000",
        output: input.input.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
            },
            async flush() {
              await context.send({
                id: `message:${input.streamId}:final`,
                sender: "agent",
                recipientIds: [input.participantId],
                content: "Final realtime answer",
                visibility: { kind: "public" },
                metadata: { modality: "realtime" },
                operationKey: "final-answer:message",
              });
            },
          }),
        ),
      };
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({
      agents: [agent("support", semanticProvider.id)],
      providers: [semanticProvider],
    }),
  });
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: bytes("answer"),
      correlationId: "semantic-stream",
    });
    const output = await nextStreamOutput(reader, handle.streamId);
    assertEquals(await readText(output.payload), "answer");
    const messageEvent = await nextSemanticType(reader, "message.created");
    assert(messageEvent.durable);
    assertEquals(messageEvent.causationId, handle.eventId);
    assertEquals(messageEvent.correlationId, "semantic-stream");
    assertEquals(messageEvent.metadata.sourceStreamId, handle.streamId);
    const message = await fixture.engine.conversation.getMessage(
      NAMESPACE,
      messageEvent.subject!.id,
    );
    assertExists(message);
    assertEquals(message.sender.id, "participant:support");
    assertEquals(message.recipientIds, ["user-a"]);
    assertEquals(message.metadata.modality, "realtime");
    assertEquals(
      (await fixture.engine.content.resolver.get(message.content[0], {
        namespace: NAMESPACE,
      })).text,
      "Final realtime answer",
    );
    await handle.done;
    await nextSemanticType(reader, "stream.closed");
    await reader.cancel();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("stream cancellation is semantic and aborts the Oxian workload", async () => {
  let providerSignal: AbortSignal | undefined;
  let inputCancelled = false;
  const input = new ReadableStream<Uint8Array>({
    cancel() {
      inputCancelled = true;
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({
      providers: [echoProvider("realtime.echo", ({ signal }) => {
        providerSignal = signal;
      })],
    }),
  });
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: input,
    });
    const output = await nextStreamOutput(reader, handle.streamId);
    await handle.cancel("barge_in");
    await output.payload.cancel("consumer_cancelled").catch(() => undefined);
    await assertRejects(() => handle.done, Error, "barge_in");
    assertEquals(providerSignal?.aborted, true);
    assertEquals(inputCancelled, true);
    const cancelled = await nextSemanticType(reader, "stream.cancelled");
    assertEquals(cancelled.causationId, handle.eventId);
    await reader.cancel();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("concurrent realtime outputs retain distinct participant labels", async () => {
  const fixture = await createFixture({
    registry: await registryFor({
      agents: [agent("alpha"), agent("beta")],
    }),
  });
  try {
    await createThread(fixture.engine, ["alpha", "beta"]);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
    });
    const reader = attachment.outputs.getReader();
    const [alpha, beta] = await Promise.all([
      attachment.send({
        type: "audio.input",
        mediaType: "audio/pcm;rate=24000",
        payload: bytes("alpha"),
        recipientId: "alpha",
      }),
      attachment.send({
        type: "audio.input",
        mediaType: "audio/pcm;rate=24000",
        payload: bytes("beta"),
        recipientId: "beta",
      }),
    ]);
    const outputs = [
      await nextStreamOutput(reader),
      await nextStreamOutput(reader),
    ];
    const decoded = await Promise.all(outputs.map(async (output) => ({
      participant: output.participant.externalId,
      text: await readText(output.payload),
    })));
    assertEquals(
      decoded.sort((left, right) =>
        left.participant.localeCompare(right.participant)
      ),
      [
        { participant: "alpha", text: "ALPHA" },
        { participant: "beta", text: "BETA" },
      ],
    );
    await Promise.all([alpha.done, beta.done]);
    await reader.cancel();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("injected stream dispatcher survives engine shutdown", async () => {
  const registry = await registryFor();
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.stream.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transport],
  });
  const worker = createWorker({
    id: "application-worker",
    transport,
    workloads: {
      [COPILOTZ_STREAM_WORKLOAD]: createRealtimeStreamWorkload({ registry }),
      "application.probe.v1": () => ({ metadata: { alive: true } }),
    },
  });
  await worker.ready;
  const fixture = await createFixture({
    registry,
    execution: {
      dispatcher: hypervisor,
      target: { workerId: "application-worker" },
    },
  });
  try {
    assertEquals(fixture.engine.execution.ownership, "injected_dispatcher");
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: bytes("remote"),
    });
    const output = await nextStreamOutput(reader, handle.streamId);
    assertEquals(await readText(output.payload), "REMOTE");
    await handle.done;
    await reader.cancel();

    await fixture.engine.shutdown();
    assertEquals(hypervisor.snapshot().inProcessWorkers, 1);
    const probe = await hypervisor.dispatch({
      workload: "application.probe.v1",
      target: { workerId: "application-worker" },
    });
    assertEquals(await probe.metadata, { alive: true });
    assertEquals((await probe.completed).status, "completed");
  } finally {
    await fixture.engine.shutdown();
    await worker.stop();
    await worker.closed;
    await hypervisor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("attachment core is factory-first and runtime-neutral", async () => {
  for (
    const module of ["attachment.ts", "index.ts", "types.ts", "workload.ts"]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source), module);
  }
});
