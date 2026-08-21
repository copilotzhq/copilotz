import { coreFeatureAliases } from "@copilotz/copilotz/plugins/core";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "../engine/index.ts";
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
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type PluginRegistry,
  type Processor,
} from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import type { AttachmentOutput, AttachmentStreamOutput } from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import type { SqlSession } from "../events/index.ts";
import { createSqlSession } from "../events/index.ts";
import type { CopilotzEngine } from "../engine/index.ts";

const NAMESPACE = "tenant-attachments";
const SCHEMA = "copilotz_attachments";

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  registry: PluginRegistry;
  engine: CopilotzEngine;
}>;

function agent(id: string): Agent {
  return Object.freeze(
    {
      id,
      name: id,
      role: `${id} agent`,
      runtime: { provider: "openai", model: "gpt-4.1-mini" },
    } satisfies Agent,
  );
}

async function registryFor(options: {
  agents?: readonly Agent[];
  processors?: readonly Processor[];
} = {}): Promise<PluginRegistry> {
  const agents = options.agents ?? [agent("support")];
  const processors = options.processors ?? [];
  return await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        manifest: {
          id: "test.attachments",
          version: "1.0.0",
          provides: {
            agents: agents.map((resource) => resource.id),
            ...(processors.length
              ? { processors: processors.map((resource) => resource.id) }
              : {}),
          },
        },
        resources: {
          agents,
          ...(processors.length ? { processors } : {}),
        },
      }),
    ],
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
  await createTestDomainContext(engine, NAMESPACE, coreFeatureAliases).features
    .thread.create({
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
    }, { identity: { deduplicationId: "thread-a:create" } });
}

function isStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output &&
    output.payload instanceof ReadableStream;
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

async function nextStreamOutput(
  reader: ReadableStreamDefaultReader<AttachmentOutput>,
) {
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("Attachment outputs closed unexpectedly.");
    if (isStreamOutput(next.value)) return next.value;
  }
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
    const message = await projectMessageById(
      fixture.engine,
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
      await context.collections.thread.update({
        id: "thread-a",
        set: { metadata: { detached: true } },
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

Deno.test("attachment outputs follow stream.created as a live byte stream", async () => {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "test.attachment-stream-write",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.durable || !event.threadId) return;
      const writer = await context.streams.write({
        threadId: event.threadId,
        lane: "content",
        mediaType: "text/plain",
        participantId: event.routing.senderId,
      });
      await writer.write(new TextEncoder().encode("hello stream"));
      await writer.finalize();
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({ processors: [processor] }),
  });
  try {
    await createThread(fixture.engine);
    const attachment = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
    });
    const reader = attachment.outputs.getReader();
    const sent = attachment.send({
      content: [{ type: "text", text: "Start a stream." }],
    });
    const created = await nextSemanticType(reader, "stream.created");
    assert(created.durable);
    assertEquals(created.subject?.type, "stream");
    const output = await nextStreamOutput(reader);
    assertEquals(output.type, "stream.output");
    assertEquals(output.streamId, created.subject?.id);
    assertEquals(output.mediaType, "text/plain");
    assertEquals(output.metadata.lane, "content");
    const pending = output.payload.getReader();
    const chunks: Uint8Array[] = [];
    const reading = (async () => {
      while (true) {
        const next = await pending.read();
        if (next.done) break;
        chunks.push(next.value);
      }
    })();
    await (await sent).done;
    await reading;
    const bytes = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    assertEquals(new TextDecoder().decode(bytes), "hello stream");
    await reader.cancel();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("attachment reconnects from afterPosition and streamOffsets", async () => {
  const fixture = await createFixture();
  try {
    await createThread(fixture.engine);
    const first = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
    });
    const firstReader = first.outputs.getReader();
    const created = await first.send({
      content: [{ type: "text", text: "first" }],
      id: "message-first",
    });
    const firstEvent = await nextSemanticType(firstReader, "message.created");
    assert(firstEvent.durable);
    await created.done;
    await firstReader.cancel();
    await first.close();

    const replay = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      afterPosition: "0",
    });
    const replayReader = replay.outputs.getReader();
    const replayed = await nextSemanticType(replayReader, "message.created");
    assert(replayed.durable);
    assertEquals(replayed.id, firstEvent.id);
    await replayReader.cancel();
    await replay.close();

    const skipped = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      afterPosition: firstEvent.position,
    });
    const skippedReader = skipped.outputs.getReader();
    const second = await skipped.send({
      content: [{ type: "text", text: "second" }],
      id: "message-second",
    });
    const next = await nextSemanticType(skippedReader, "message.created");
    assert(next.durable);
    assertEquals(next.id, second.eventId);
    await second.done;
    await skippedReader.cancel();
    await skipped.close();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("attachment follows in-flight streams from a byte offset after stream.created", async () => {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "test.attachment-stream-resume",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.durable || !event.threadId) return;
      const writer = await context.streams.write({
        threadId: event.threadId,
        lane: "content",
        mediaType: "text/plain",
        participantId: event.routing.senderId,
      });
      await writer.write(new TextEncoder().encode("hello stream"));
      await writer.finalize();
    },
  });
  const fixture = await createFixture({
    registry: await registryFor({ processors: [processor] }),
  });
  try {
    await createThread(fixture.engine);
    const first = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
    });
    const firstReader = first.outputs.getReader();
    const sent = first.send({
      content: [{ type: "text", text: "Start a stream." }],
    });
    const created = await nextSemanticType(firstReader, "stream.created");
    assert(created.durable);
    const output = await nextStreamOutput(firstReader);
    assertEquals(output.streamId, created.subject?.id);
    await (await sent).done;
    await firstReader.cancel();
    await first.close();

    const resumed = await fixture.engine.connect({
      namespace: NAMESPACE,
      thread: "thread-a",
      participant: "user-a",
      afterPosition: created.position,
      streamOffsets: Object.freeze({
        [created.subject!.id]: 6,
      }),
    });
    const resumedReader = resumed.outputs.getReader();
    const resumedOutput = await nextStreamOutput(resumedReader);
    assertEquals(resumedOutput.streamId, created.subject?.id);
    const rest = resumedOutput.payload.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await rest.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    assertEquals(new TextDecoder().decode(bytes), "stream");
    await resumedReader.cancel();
    await resumed.close();
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("attachment core is factory-first and runtime-neutral", async () => {
  for (
    const module of ["attachment.ts", "index.ts", "types.ts"]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source), module);
  }
});
