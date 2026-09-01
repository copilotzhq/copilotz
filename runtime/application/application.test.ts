import { message as coreMessage } from "@copilotz/copilotz/core";
import type { LlmAdapter } from "@copilotz/copilotz/llm";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { type ActionCallers, defineAction } from "../actions/index.ts";
import {
  type AnyCopilotzPlugin,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { createTestDomainContext } from "../../plugins/core/internal/testing/context.ts";
import { waitForTestDelivery } from "../../runtime/testing/deliveries.ts";
import { projectMessages } from "../../plugins/core/internal/testing/projections.ts";
import { createCopilotzApplication } from "./application.ts";
import type { CopilotzDatabase } from "@copilotz/copilotz/persistence";
import { isCopilotzPersistenceError } from "@copilotz/copilotz/persistence";
import { loadMessageRecord } from "@copilotz/copilotz/core";
import {
  coreCollectionsPlugin,
  corePlugin,
} from "../../plugins/core/plugin.ts";
import {
  createCoreTableNames,
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "../events/index.ts";
import type { TestDatabase } from "../testing/ominipg.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  type BodyStore,
  createMemoryBodyStore,
  digestContent,
  readBodyBytes,
} from "../content/index.ts";
import {
  type ApplicationOutput,
  createOperationCatalog,
  createStreamOutputDescriptor,
  decodeOperationReplayCursor,
  provisionOperationCatalog,
  type StreamOutput,
} from "../streams/index.ts";

const SCHEMA = "copilotz_application";
const NAMESPACE = "tenant-a";
const LARGE_STREAM_BYTES = 1024 * 1024 + 1;

function replyPlugin(): AnyCopilotzPlugin {
  const processor = defineProcessor<ProcessorContext>({
    id: "application.reply",
    on: [{ eventType: "message.created", routing: { senderId: "user-a" } }],
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const incoming = await loadMessageRecord(
        context,
        event.subject.id,
      );
      assertExists(incoming);
      const content = await context.content.prepare(
        { type: "text", text: "application reply" },
        { operationKey: "reply-content" },
      );
      await context.collections.message.create({
        id: `reply:${incoming.id}`,
        threadId: incoming.threadId,
        senderId: "agent-a",
        recipientIds: [incoming.sender.id],
        content,
      }, { operationKey: "reply-message" });
    },
  });
  return definePlugin({
    id: "test.application.reply",
    version: "1.0.0",
    processors: { reply: processor },
  });
}

function runtimeNeutralStreamPlugin(): AnyCopilotzPlugin {
  const processor = defineProcessor<ProcessorContext>({
    id: "application.runtime-neutral-stream",
    on: [{ eventType: "test.runtime-neutral-stream" }],
    async handle(event, context) {
      const writer = await context.streams.open({
        id: "runtime-neutral-stream-a",
        mediaType: "text/plain",
        role: "output",
        metadata: { source: "test-plugin" },
        correlationId: event.correlationId,
      });
      await writer.append({
        bytes: new Uint8Array(LARGE_STREAM_BYTES).fill(0x78),
        appendId: "runtime-neutral-stream-chunk",
      });
      await writer.close({ assetId: "runtime-neutral-stream-asset" });
    },
  });
  return definePlugin({
    id: "test.application.runtime-neutral-stream",
    version: "1.0.0",
    processors: { runtimeNeutralStream: processor },
  });
}

function correlatedOutputPlugin(): AnyCopilotzPlugin {
  const processor = defineProcessor<ProcessorContext>({
    id: "application.correlated-output",
    on: [{ eventType: "test.correlated-output" }],
    async handle(event, context) {
      const writer = await context.streams.open({
        id: `correlated-output:${event.correlationId}`,
        mediaType: "text/plain",
        role: "output",
      });
      await writer.append({
        bytes: new TextEncoder().encode(`output:${event.correlationId}`),
        appendId: `correlated-output:${event.correlationId}:chunk`,
      });
      await writer.close({
        assetId: `correlated-output:${event.correlationId}:asset`,
      });
    },
  });
  return definePlugin({
    id: "test.application.correlated-output",
    version: "1.0.0",
    processors: { correlatedOutput: processor },
  });
}

function detachableOperationPlugin(
  probe: { completed: number },
): AnyCopilotzPlugin {
  return definePlugin({
    id: "test.application.detachable-operation",
    version: "1.0.0",
    processors: {
      delayed: defineProcessor<ProcessorContext>({
        id: "application.detachable-operation",
        on: [{ eventType: "test.detachable-operation" }],
        async handle() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          probe.completed += 1;
        },
      }),
    },
  });
}

function startupRecoveryPlugin(calls: { count: number }): AnyCopilotzPlugin {
  return definePlugin({
    id: "test.application.startup-recovery",
    version: "1.0.0",
    processors: {
      complete: defineProcessor<ProcessorContext>({
        id: "test.application.startup-recovery-complete",
        on: [{ eventType: "test.application.startup-recovery" }],
        handle() {
          calls.count += 1;
        },
      }),
    },
  });
}

const lifecycleProbeAction = defineAction({
  id: "test.application.lifecycle-probe",
  execute(input: Readonly<{ value: string }>) {
    return Object.freeze({ echoed: input.value });
  },
});

type LifecycleProbeContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ lifecycleProbe: typeof lifecycleProbeAction }>,
  ProcessorContext["collections"]
>;

function lifecycleProbePlugin(): AnyCopilotzPlugin {
  return definePlugin({
    id: "test.application.lifecycle-probe",
    version: "1.0.0",
    actions: { lifecycleProbe: lifecycleProbeAction },
    processors: {
      invokeLifecycleProbe: defineProcessor<LifecycleProbeContext>({
        id: "test.application.invoke-lifecycle-probe",
        on: [{ eventType: "test.application.invoke-lifecycle-probe" }],
        async handle(_event, context) {
          const invoke = context.actions.lifecycleProbe;
          if (typeof invoke !== "function") {
            throw new Error("Lifecycle probe Action is not composed.");
          }
          await invoke({ value: "genuine" }, { operationKey: "probe" });
        },
      }),
    },
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function closeDb(db: TestDatabase): Promise<void> {
  await db.close();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached before the test deadline.");
}

Deno.test("application factory composes plugins and supplies the default tenant scope", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [coreCollectionsPlugin, replyPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    assert(Object.isFrozen(application));
    assertEquals(application.config, {
      namespace: NAMESPACE,
      databaseSchema: SCHEMA,
      pluginIds: ["@copilotz/core-collections", "test.application.reply"],
      databaseOwnership: "injected",
    });
    await createTestDomainContext(application, NAMESPACE).actions.createThread(
      {
        id: "thread-a",
        participants: [
          {
            id: "user-a",
            externalId: "user-a",
            participantType: "human",
          },
          {
            id: "agent-a",
            externalId: "support",
            participantType: "agent",
            agentId: "support",
          },
        ],
      },
    );
    const run = await application.send(coreMessage({
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
      content: "hello",
    }));
    const observed = collect(run.outputs);
    await run.done;
    assertEquals(
      (await observed).filter((event) => event.type === "message.created")
        .length,
      2,
    );
    const messages = await projectMessages(application, NAMESPACE, "thread-a");
    assertEquals(messages.length, 2);
    const reply = await application.content.resolver.getMany(
      messages[1].content,
      { namespace: NAMESPACE },
    );
    assertEquals(reply[0].text, "application reply");

    await application.shutdown();
    await db.query("SELECT 1");
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("application send publishes one session output stream", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [coreCollectionsPlugin, replyPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await createTestDomainContext(application, NAMESPACE).actions.createThread(
      {
        id: "thread-a",
        participants: [
          {
            id: "user-a",
            externalId: "user-a",
            participantType: "human",
          },
          {
            id: "agent-a",
            externalId: "support",
            participantType: "agent",
            agentId: "support",
          },
        ],
      },
    );
    const observed = (async () => {
      const outputs = [];
      for await (const output of application.observe()) {
        outputs.push(output);
        if (
          outputs.filter((item) => item.type === "message.created").length >= 2
        ) {
          break;
        }
      }
      return outputs;
    })();

    const sent = await application.send(coreMessage({
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
      content: "hello",
    }));
    await sent.done;

    const outputs = await observed;
    assertEquals(
      outputs.filter((output) => output.type === "message.created").length,
      2,
    );
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).some((event) =>
        event.id === sent.eventId
      ),
      true,
    );

    await application.close();
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("public ingress reserves registered Action lifecycle identities", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const databaseSchema = `${SCHEMA}_action_lifecycle_authority`;
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [lifecycleProbePlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const trigger = await application.send({
      type: "test.application.invoke-lifecycle-probe",
      deduplicationId: "lifecycle-probe:trigger",
    });
    await trigger.done;

    const genuine = (await application.events.list({
      namespace: NAMESPACE,
      correlationId: trigger.correlationId,
      limit: 100,
    })).filter((event) =>
      event.type === "test.application.lifecycle-probe.completed"
    );
    assertEquals(genuine.length, 1);
    const terminal = genuine[0];
    assertExists(terminal.subject);

    await assertRejects(
      () =>
        application.send({
          type: terminal.type,
          payload: terminal.payload,
          metadata: structuredClone(terminal.metadata),
          correlationId: terminal.correlationId,
          causationId: terminal.causationId,
          deduplicationId: "forged-lifecycle:application-send",
        }),
      TypeError,
      "reserved for the registered Action lifecycle",
    );
    await assertRejects(
      async () =>
        await application.events.append({
          type: terminal.type,
          namespace: terminal.namespace,
          subject: structuredClone(terminal.subject),
          payload: structuredClone(terminal.payload),
          metadata: structuredClone(terminal.metadata),
          correlationId: terminal.correlationId,
          causationId: terminal.causationId,
          deduplicationId: "forged-lifecycle:engine-append",
        }),
      TypeError,
      "reserved for the registered Action lifecycle",
    );
    await assertRejects(
      () =>
        application.send({
          type: "unrelated.public-event",
          payload: { poisoned: true },
          deduplicationId: `${terminal.subject!.id}:action:terminal`,
        }),
      TypeError,
      "reserved for the Action lifecycle",
    );
    assertEquals(
      (await application.events.list({
        namespace: NAMESPACE,
        correlationId: trigger.correlationId,
        limit: 100,
      })).filter((event) => event.type === terminal.type).length,
      1,
    );
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("application observes streams opened from events with no thread semantics", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_runtime_neutral_stream`,
    plugins: [runtimeNeutralStreamPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const sent = await application.send({
      type: "test.runtime-neutral-stream",
      payload: { value: 42 },
      correlationId: "runtime-neutral-correlation",
    });
    const observed = collect(sent.outputs);
    await sent.done;
    const outputs = await observed;
    const stream = outputs.find((output) => output.type === "stream.output");
    assertExists(stream);
    const streamOutput = stream as StreamOutput;
    assertEquals(/^[1-9][0-9]*$/.test(streamOutput.replayKey ?? ""), true);
    assertEquals("durable" in streamOutput, false);
    assertEquals("threadId" in streamOutput, false);
    assertEquals(streamOutput.namespace, NAMESPACE);
    assertEquals(
      streamOutput.streamId.startsWith(
        "incarnation:runtime-neutral-stream-a:",
      ),
      true,
    );
    assertEquals(streamOutput.mediaType, "text/plain");
    assertEquals(streamOutput.kind, "text");
    assertEquals(streamOutput.role, "output");
    assertEquals(streamOutput.correlationId, "runtime-neutral-correlation");
    assertEquals(typeof streamOutput.payload.getReader, "function");
    const payload = new Uint8Array(
      await new Response(streamOutput.payload).arrayBuffer(),
    );
    assertEquals(payload.byteLength, LARGE_STREAM_BYTES);
    assertEquals(payload[0], 0x78);
    assertEquals(payload.at(-1), 0x78);
    assertEquals(streamOutput.metadata.source, "test-plugin");
    assertEquals(
      streamOutput.metadata.contentStreamSemanticId,
      "runtime-neutral-stream-a",
    );
    assertEquals(
      typeof streamOutput.metadata.contentStreamIncarnationId,
      "string",
    );
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("application reattaches durable events and stream Bodies through a terminal lifecycle frame", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_operation_reattach`,
    plugins: [correlatedOutputPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const sent = await application.send({
      type: "test.correlated-output",
      correlationId: "reattach-correlation",
      operationMetadata: {
        threadId: "thread-reattach",
        initiatorUserId: "user-a",
      },
    });
    await sent.done;
    const attachment = await application.attach({
      operationId: sent.operationId,
    });
    const outputs = await collect(attachment.outputs);
    await attachment.done;
    assertEquals(outputs.map((output) => output.type), [
      "stream.output",
      "test.correlated-output",
      "operation.completed",
    ]);
    const stream = outputs.find((output) => output.type === "stream.output") as
      | StreamOutput
      | undefined;
    assertExists(stream);
    assertEquals(
      await new Response(stream.payload).text(),
      "output:reattach-correlation",
    );
    const status = await application.operationStatus({
      operationId: sent.operationId,
    });
    assertEquals(status?.state, "completed");
    assertEquals(status?.metadata, {
      threadId: "thread-reattach",
      initiatorUserId: "user-a",
    });
    assertEquals(
      (await application.listOperations({
        metadata: { initiatorUserId: "user-a" },
      })).map((operation) => operation.operationId),
      [sent.operationId],
    );
    const checkpoint = await application.operationCheckpoint({
      operationIds: [sent.operationId],
      cursor: sent.replayCursor,
    });
    assertEquals(
      decodeOperationReplayCursor(checkpoint).operationStreamPositions?.[
        sent.operationId
      ],
      { highWatermark: 1, offsets: {} },
    );
    const snapshotAttachment = await application.attach({
      operationId: sent.operationId,
      cursor: checkpoint,
    });
    const snapshotOutputs = await collect(snapshotAttachment.outputs);
    await snapshotAttachment.done;
    assertEquals(snapshotOutputs.map((output) => output.type), [
      "operation.completed",
    ]);
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("operation checkpoints page and compact more than one thousand sealed lanes", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const databaseSchema = `${SCHEMA}_deep_checkpoint`;
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [],
  });
  try {
    const operationId = "operation-deep-checkpoint";
    const catalog = createOperationCatalog(db, databaseSchema);
    await db.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace: NAMESPACE,
        operationId,
        eventId: operationId,
        position: "1",
        correlationId: "deep-checkpoint",
        createdAt: "2026-08-31T12:00:00.000Z",
      })
    );
    const descriptor = createStreamOutputDescriptor({
      id: "placeholder",
      semanticId: "placeholder",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: NAMESPACE });
    await db.query(
      `INSERT INTO "${databaseSchema}"."copilotz_operation_streams" (
         namespace, operation_id, stream_ordinal, stream_id,
         semantic_stream_id, body_id,
         descriptor, state, outcome, availability, capture,
         asset_retention, committed_offset, terminal_at,
         created_at, updated_at
       ) SELECT $1, $2, lane, 'lane-' || lane, 'lane-' || lane, 'body-' || lane,
                jsonb_set($3::jsonb, '{streamId}', to_jsonb('lane-' || lane)),
                'terminal', 'completed', 'retained', 'complete',
                'observation', 1, NOW(), NOW(), NOW()
           FROM generate_series(1, 1001) AS lane`,
      [NAMESPACE, operationId, JSON.stringify(descriptor)],
    );
    const checkpoint = decodeOperationReplayCursor(
      await application.operationCheckpoint({ operationIds: [operationId] }),
    );
    assertEquals(checkpoint.operationStreamPositions?.[operationId], {
      highWatermark: 1_001,
      offsets: {},
    });
  } finally {
    await application.shutdown();
    await db.close();
  }
});

Deno.test("operation attachment replays a retained failed prefix with generic terminal state", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const plugin = definePlugin({
    id: "test.application.retained-failed-prefix",
    version: "1.0.0",
    processors: {
      stream: defineProcessor<ProcessorContext>({
        id: "application.retained-failed-prefix",
        on: [{ eventType: "test.retained-failed-prefix" }],
        async handle(_event, context) {
          const writer = await context.streams.open({
            id: "retained-failed-prefix",
            mediaType: "text/plain",
            role: "assistant",
          });
          await writer.append({
            bytes: new TextEncoder().encode("rejected bytes"),
            appendId: "retained-failed-prefix:1",
          });
          await writer.abort({ outcome: "failed", capture: "complete" });
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_retained_failed_prefix`,
    plugins: [plugin],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const sent = await application.send({
      type: "test.retained-failed-prefix",
    });
    await sent.done;
    const attachment = await application.attach({
      operationId: sent.operationId,
    });
    const outputs = await collect(attachment.outputs);
    await attachment.done;
    const stream = outputs.find((output) => output.type === "stream.output") as
      | StreamOutput
      | undefined;
    assertExists(stream);
    assertEquals(await new Response(stream.payload).text(), "rejected bytes");
    assertEquals(await stream.terminal, {
      outcome: "failed",
      availability: "retained",
      capture: "complete",
      offset: "rejected bytes".length,
      terminalAt: (await createOperationCatalog(
        db,
        `${SCHEMA}_retained_failed_prefix`,
      ).findStream(NAMESPACE, stream.streamId))!.terminalAt,
    });
    assertEquals(outputs.at(-1)?.type, "operation.completed");

    const catalog = createOperationCatalog(
      db,
      `${SCHEMA}_retained_failed_prefix`,
    );
    assertEquals(
      await catalog.markStreamPurgePending({
        namespace: NAMESPACE,
        operationId: sent.operationId,
        streamId: stream.streamId,
      }),
      true,
    );
    const tombstonedAttachment = await application.attach({
      operationId: sent.operationId,
    });
    const tombstonedOutputs = await collect(tombstonedAttachment.outputs);
    await tombstonedAttachment.done;
    const tombstoned = tombstonedOutputs.find((output) =>
      output.type === "stream.output"
    ) as StreamOutput | undefined;
    assertExists(tombstoned);
    // purge_pending is a logical tombstone before physical CAS deletion, so a
    // new replay cannot race garbage collection and acquire the old prefix.
    assertEquals(await new Response(tombstoned.payload).text(), "");
    assertEquals((await tombstoned.terminal)?.availability, "purge_pending");
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("detaching request observation does not cancel durable operation work", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const probe = { completed: 0 };
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_operation_detach`,
    plugins: [detachableOperationPlugin(probe)],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const sent = await application.send({ type: "test.detachable-operation" });
    await sent.detach("test_client_disconnected");
    await waitFor(() => probe.completed === 1);
    const status = await application.operationStatus({
      operationId: sent.operationId,
    });
    assertEquals(status?.state, "completed");
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("quiet reconnect stream waits on catalog changes without polling its BodyStore", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const backing = createMemoryBodyStore();
  const calls = { head: 0, read: 0, follow: 0 };
  const store: BodyStore = Object.freeze({
    ...backing,
    head(input) {
      calls.head += 1;
      return backing.head(input);
    },
    read(input) {
      calls.read += 1;
      return backing.read(input);
    },
    follow(input) {
      calls.follow += 1;
      return backing.follow(input);
    },
    readRange(input) {
      return backing.readRange(input);
    },
  });
  let appended!: () => void;
  const didAppend = new Promise<void>((resolve) => appended = resolve);
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const plugin = definePlugin({
    id: "test.application.quiet-reconnect-stream",
    version: "1.0.0",
    processors: {
      stream: defineProcessor<ProcessorContext>({
        id: "application.quiet-reconnect-stream",
        on: [{ eventType: "test.quiet-reconnect-stream" }],
        async handle(_event, context) {
          const writer = await context.streams.open({
            id: "quiet-reconnect-stream",
            mediaType: "text/plain",
            role: "assistant",
          });
          await writer.append({
            bytes: new TextEncoder().encode("a"),
            appendId: "quiet-reconnect-stream:1",
          });
          appended();
          await released;
          await writer.close({ assetId: "quiet-reconnect-stream:asset" });
          await writer.retain({
            retention: "observation",
          });
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_quiet_reconnect_stream`,
    plugins: [plugin],
    assets: {
      storage: {
        type: "custom",
        config: {
          store,
          deployment: {
            durability: "durable",
            reach: "cluster",
            minimumProtectionMs: 0,
            readyGarbageCollection: true,
          },
        },
      },
    },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const sent = await application.send({
      type: "test.quiet-reconnect-stream",
    });
    await didAppend;
    const attachment = await application.attach({
      operationId: sent.operationId,
      cursor: sent.replayCursor,
    });
    const output = await attachment.outputs.getReader().read();
    assertEquals(output.done, false);
    assertEquals(output.value?.type, "stream.output");
    const stream = output.value as StreamOutput;
    const reader = stream.payload.getReader();
    const replayed = await reader.read();
    assertEquals(new TextDecoder().decode(replayed.value), "a");
    let resolved = false;
    const pending = reader.read().then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(resolved, false);
    assertEquals(calls, { head: 0, read: 0, follow: 0 });
    release();
    await pending;
    assertEquals(calls.follow, 0);
    assertEquals(calls.read, 0);
    await reader.cancel("test_complete");
    await attachment.detach("test_complete");
    await sent.done;
  } finally {
    release();
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("sealed stream defaults to expiring observation retention when its processor fails before retain", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const databaseSchema = `${SCHEMA}_failed_stream_retention`;
  const plugin = definePlugin({
    id: "test.application.failed-stream-retention",
    version: "1.0.0",
    processors: {
      stream: defineProcessor<ProcessorContext>({
        id: "application.failed-stream-retention",
        on: [{ eventType: "test.failed-stream-retention" }],
        async handle(_event, context) {
          const writer = await context.streams.open({
            id: "unretained-stream",
            mediaType: "text/plain",
            role: "assistant",
          });
          await writer.append({
            bytes: new TextEncoder().encode("temporary"),
            appendId: "unretained-stream:1",
          });
          await writer.close({ assetId: "never-materialized" });
          throw new Error("final materialization failed");
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [plugin],
    assets: {
      storage: {
        type: "custom",
        config: {
          store,
          deployment: {
            durability: "durable",
            reach: "cluster",
            minimumProtectionMs: 0,
            readyGarbageCollection: true,
          },
        },
      },
    },
    engine: {
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      maxAttempts: 1,
      retryBaseMs: 0,
      random: () => 0,
    },
  });
  try {
    const sent = await application.send({
      type: "test.failed-stream-retention",
    });
    await assertRejects(() => sent.done, Error, "dead-lettered");
    const catalog = createOperationCatalog(db, databaseSchema);
    const [cataloged] = await catalog.listStreams({
      namespace: NAMESPACE,
      operationId: sent.operationId,
    });
    assertExists(cataloged);
    const bodyId = cataloged.bodyId;
    assertExists(await store.head({ bodyId }));
    const retentionDisabled = await application.maintenance({
      now: new Date("2030-08-31T12:16:00.000Z"),
      operationRetentionMs: null,
      assetOrphanAfterMs: 0,
    });
    assertEquals(retentionDisabled.assets.orphanedBodiesDeleted, 0);
    assertEquals(retentionDisabled.operations.expiredObservationStreams, 0);
    assertExists(await store.head({ bodyId }));
    const maintained = await application.maintenance({
      now: new Date("2030-08-31T12:16:00.000Z"),
      operationRetentionMs: 0,
    });
    assertEquals(maintained.operations.expiredObservationStreams, 1);
    assertEquals(maintained.operations.prunedCatalogEntries, 1);
    assertEquals(
      await store.head({ bodyId }),
      null,
    );
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("observation retirement preserves a Body already adopted by a canonical Asset", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createMemoryBodyStore({ protectionMs: 100 });
  const databaseSchema = `${SCHEMA}_stream_partial_adoption`;
  const assetId = "adopted-stream-asset";
  const plugin = definePlugin({
    id: "test.application.stream-partial-adoption",
    version: "1.0.0",
    processors: {
      stream: defineProcessor<ProcessorContext>({
        id: "application.stream-partial-adoption",
        on: [{ eventType: "test.stream-partial-adoption" }],
        async handle(_event, context) {
          const writer = await context.streams.open({
            id: "adopted-stream",
            mediaType: "text/plain",
            role: "assistant",
          });
          await writer.append({
            bytes: new TextEncoder().encode("canonical"),
            appendId: "adopted-stream:1",
          });
          const prepared = await writer.close({ assetId });
          await context.content.materialize(prepared);
          // Simulate a crash between Asset adoption and catalog canonical bind.
          throw new Error("catalog retain was not reached");
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [plugin],
    assets: {
      storage: {
        type: "custom",
        config: {
          store,
          deployment: {
            durability: "durable",
            reach: "cluster",
            minimumProtectionMs: 0,
            readyGarbageCollection: true,
          },
        },
      },
    },
    engine: {
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      maxAttempts: 1,
      retryBaseMs: 0,
      random: () => 0,
    },
  });
  try {
    const sent = await application.send({
      type: "test.stream-partial-adoption",
    });
    await assertRejects(() => sent.done, Error, "dead-lettered");
    const catalog = createOperationCatalog(db, databaseSchema);
    const [cataloged] = await catalog.listStreams({
      namespace: NAMESPACE,
      operationId: sent.operationId,
    });
    assertExists(cataloged);
    const bodyId = cataloged.bodyId;
    assertExists(await application.content.assets.get(NAMESPACE, assetId));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const maintained = await application.maintenance({
      now: new Date("2030-08-31T12:16:00.000Z"),
      operationRetentionMs: 0,
      assetOrphanAfterMs: 0,
    });
    assertEquals(maintained.operations.expiredObservationStreams, 1);
    assertEquals(maintained.operations.observationRetirementBlocked, 0);
    assertEquals(maintained.operations.prunedCatalogEntries, 1);
    assertExists(await store.head({ bodyId }));
    await application.content.assets.markDeleted(NAMESPACE, assetId);
    assertExists(await store.head({ bodyId }));
    const collected = await application.maintenance({
      now: new Date("2030-08-31T12:17:00.000Z"),
      operationRetentionMs: 0,
      assetOrphanAfterMs: 0,
    });
    assertEquals(collected.assets.orphanedBodiesDeleted, 1);
    assertEquals(await store.head({ bodyId }), null);
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("concurrent observation retirement cannot resurrect a deleted Body", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const baseStore = createMemoryBodyStore({ protectionMs: 0 });
  let deleteCalls = 0;
  const store = Object.freeze({
    ...baseStore,
    maintenance: Object.freeze({
      ...baseStore.maintenance,
      async delete(input: Parameters<BodyStore["maintenance"]["delete"]>[0]) {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          // Simulate worker A winning the exact Body CAS immediately before
          // this worker B attempts the same snapshot. B must observe false and
          // leave the catalog monotonic purge_pending, never restore retained.
          assertEquals(await baseStore.maintenance.delete(input), true);
          return false;
        }
        return await baseStore.maintenance.delete(input);
      },
    }),
  }) satisfies BodyStore;
  const databaseSchema = `${SCHEMA}_concurrent_stream_retirement`;
  const plugin = definePlugin({
    id: "test.application.concurrent-stream-retirement",
    version: "1.0.0",
    processors: {
      stream: defineProcessor<ProcessorContext>({
        id: "application.concurrent-stream-retirement",
        on: [{ eventType: "test.concurrent-stream-retirement" }],
        async handle(_event, context) {
          const writer = await context.streams.open({
            id: "concurrent-retirement-stream",
            mediaType: "text/plain",
            role: "assistant",
          });
          await writer.append({
            bytes: new TextEncoder().encode("terminal prefix"),
            appendId: "concurrent-retirement-stream:1",
          });
          await writer.abort({ outcome: "failed" });
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [plugin],
    assets: {
      storage: {
        type: "custom" as const,
        config: {
          store,
          deployment: {
            durability: "durable" as const,
            reach: "cluster" as const,
            minimumProtectionMs: 0,
            readyGarbageCollection: true,
          },
        },
      },
    },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const sent = await application.send({
      type: "test.concurrent-stream-retirement",
    });
    await sent.done;
    const [stream] = await createOperationCatalog(db, databaseSchema)
      .listStreams({ namespace: NAMESPACE, operationId: sent.operationId });
    assertExists(stream);

    const catalog = createOperationCatalog(db, databaseSchema);
    await application.maintenance({
      now: new Date("2030-09-01T12:00:00.000Z"),
      operationRetentionMs: 0,
    });

    assertEquals(deleteCalls, 1);
    assertEquals(await store.head({ bodyId: stream.bodyId }), null);
    assertEquals(
      (await catalog.getStream(
        NAMESPACE,
        sent.operationId,
        stream.streamId,
      ))?.availability,
      "purge_pending",
    );

    // The next pass observes the missing physical Body and monotonically
    // completes the logical tombstone without another destructive call.
    await application.maintenance({
      now: new Date("2030-09-01T12:00:01.000Z"),
      operationRetentionMs: 0,
    });
    assertEquals(deleteCalls, 1);
    const retired = await catalog.getStream(
      NAMESPACE,
      sent.operationId,
      stream.streamId,
    );
    // With a zero replay window, terminal metadata may be pruned in the same
    // pass after it reaches purged. It must never reappear as retained.
    assert(retired === null || retired.availability === "purged");
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("maintenance reconciles physical stream crash windows before terminalizing operations", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const databaseSchema = `${SCHEMA}_stream_reconcile`;
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [],
    assets: {
      storage: {
        type: "custom",
        config: {
          store,
          deployment: {
            durability: "durable",
            reach: "cluster",
            minimumProtectionMs: 0,
            readyGarbageCollection: true,
          },
        },
      },
    },
  });
  try {
    const catalog = createOperationCatalog(db, databaseSchema);
    const operationId = "stream-reconcile-operation";
    await db.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace: NAMESPACE,
        operationId,
        eventId: operationId,
        position: "1",
        correlationId: "stream-reconcile-correlation",
        createdAt: "2026-08-31T12:00:00.000Z",
      })
    );
    const readyBodyId =
      `schemas/${databaseSchema}/content-streams/${NAMESPACE}/ready-crash`;
    const missingBodyId =
      `schemas/${databaseSchema}/content-streams/${NAMESPACE}/missing-crash`;
    const incompleteBodyId =
      `schemas/${databaseSchema}/content-streams/${NAMESPACE}/incomplete-crash`;
    const descriptor = (streamId: string) =>
      createStreamOutputDescriptor({
        id: streamId,
        semanticId: streamId,
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: Object.freeze({}),
      }, { namespace: NAMESPACE });
    await catalog.openStream({
      namespace: NAMESPACE,
      operationId,
      semanticStreamId: "ready-crash",
      bodyId: readyBodyId,
      descriptor: descriptor("ready-crash"),
    });
    await catalog.openStream({
      namespace: NAMESPACE,
      operationId,
      semanticStreamId: "missing-crash",
      bodyId: missingBodyId,
      descriptor: descriptor("missing-crash"),
    });
    await catalog.openStream({
      namespace: NAMESPACE,
      operationId,
      semanticStreamId: "incomplete-crash",
      bodyId: incompleteBodyId,
      descriptor: descriptor("incomplete-crash"),
    });
    const crashedWriter = await store.reserve({
      bodyId: incompleteBodyId,
      mediaType: "text/plain",
    });
    const incompleteBytes = new TextEncoder().encode("retained crash prefix");
    await store.append({
      writer: crashedWriter,
      expectedOffset: 0,
      appendId: "incomplete-crash:1",
      bytes: incompleteBytes,
    });
    assertEquals(await catalog.mark(NAMESPACE, operationId, "failed"), false);
    const activeOperationId = "stream-reconcile-active-operation";
    await db.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace: NAMESPACE,
        operationId: activeOperationId,
        eventId: activeOperationId,
        position: "2",
        correlationId: "stream-reconcile-active-correlation",
        createdAt: "2026-08-31T12:01:00.000Z",
      })
    );
    await catalog.openStream({
      namespace: NAMESPACE,
      operationId: activeOperationId,
      semanticStreamId: "active-reserve-race",
      bodyId:
        `schemas/${databaseSchema}/content-streams/${NAMESPACE}/active-reserve-race`,
      descriptor: descriptor("active-reserve-race"),
    });
    const bytes = new TextEncoder().encode("sealed before catalog callback");
    await store.put({
      bodyId: readyBodyId,
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
    });

    const maintained = await application.maintenance({
      operationRetentionMs: null,
    });
    assertEquals(maintained.operations.reconciledStreams, 4);
    const streams = await catalog.listStreams({
      namespace: NAMESPACE,
      operationId,
    });
    assertEquals(
      streams.map((stream) => ({
        id: stream.streamId,
        state: stream.state,
        retention: stream.retention,
        offset: stream.committedOffset,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      [{
        id: "incomplete-crash",
        state: "terminal",
        retention: "observation",
        offset: incompleteBytes.byteLength,
      }, {
        id: "missing-crash",
        state: "terminal",
        retention: "observation",
        offset: 0,
      }, {
        id: "ready-crash",
        state: "terminal",
        retention: "observation",
        offset: bytes.byteLength,
      }],
    );
    assertEquals(
      (await store.head({ bodyId: incompleteBodyId }))?.state,
      "incomplete",
    );
    assertEquals(
      new TextDecoder().decode(
        await readBodyBytes(store, { bodyId: incompleteBodyId }),
      ),
      "retained crash prefix",
    );
    assertEquals(
      (await catalog.listStreams({
        namespace: NAMESPACE,
        operationId: activeOperationId,
      }))[0].state,
      "terminal",
    );
    assertEquals(
      (await catalog.get(NAMESPACE, operationId))?.state,
      "completed",
    );
    assertEquals(
      (await catalog.get(NAMESPACE, activeOperationId))?.state,
      "completed",
    );
    const retired = await application.maintenance({
      now: new Date("2030-09-01T00:00:00.000Z"),
      operationRetentionMs: 0,
      assetOrphanAfterMs: 0,
    });
    assertEquals(retired.operations.expiredObservationStreams, 2);
    assertEquals(retired.operations.observationRetirementBlocked, 0);
    assertEquals(await store.head({ bodyId: incompleteBodyId }), null);
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("application isolates simultaneous causal outputs and preserves the final queued frame", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const databaseSchema = `${SCHEMA}_correlated_outputs`;
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema,
    plugins: [correlatedOutputPlugin()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const globalFirst = application.observe().getReader();
    const globalSecond = application.observe().getReader();
    const [first, second] = await Promise.all([
      application.send({
        type: "test.correlated-output",
        correlationId: "correlation-first",
      }),
      application.send({
        type: "test.correlated-output",
        correlationId: "correlation-second",
      }),
    ]);

    // Deliberately do not consume either request stream until its causal scope
    // settles. Closing the direct sink must preserve every already-queued event,
    // including the final remote stream frame.
    await Promise.all([first.done, second.done]);
    const [firstOutputs, secondOutputs] = await Promise.all([
      collect(first.outputs),
      collect(second.outputs),
    ]);
    assertEquals(firstOutputs.map((event) => event.type), [
      "test.correlated-output",
      "stream.output",
    ]);
    assertEquals(
      firstOutputs.every((event) =>
        event.correlationId === "correlation-first"
      ),
      true,
    );
    assertEquals(secondOutputs.map((event) => event.type), [
      "test.correlated-output",
      "stream.output",
    ]);
    assertEquals(
      secondOutputs.every((event) =>
        event.correlationId === "correlation-second"
      ),
      true,
    );
    const firstStream = firstOutputs.find((output) =>
      output.type === "stream.output"
    ) as StreamOutput;
    const secondStream = secondOutputs.find((output) =>
      output.type === "stream.output"
    ) as StreamOutput;
    assertEquals(
      await new Response(firstStream.payload).text(),
      "output:correlation-first",
    );
    assertEquals(
      await new Response(secondStream.payload).text(),
      "output:correlation-second",
    );

    const collectGlobal = async (
      reader: ReadableStreamDefaultReader<ApplicationOutput>,
    ) => {
      const globallyObserved = [];
      while (globallyObserved.length < 4) {
        const next = await reader.read();
        assertEquals(next.done, false);
        globallyObserved.push(next.value!);
      }
      return globallyObserved;
    };
    const [globallyObserved, independentlyObserved] = await Promise.all([
      collectGlobal(globalFirst),
      collectGlobal(globalSecond),
    ]);
    assertEquals(
      new Set(globallyObserved.map((event) => event.correlationId)),
      new Set(["correlation-first", "correlation-second"]),
    );
    const globalFirstStream = globallyObserved.find((output) =>
      output.type === "stream.output"
    ) as StreamOutput;
    const globalSecondStream = independentlyObserved.find((output) =>
      output.type === "stream.output"
    ) as StreamOutput;
    assertEquals(
      await new Response(globalFirstStream.payload).text(),
      await new Response(globalSecondStream.payload).text(),
    );
    await Promise.all([globalFirst.cancel(), globalSecond.cancel()]);

    const direct = application.observe().getReader();
    await application.events.emit({
      type: "test.outside-send",
      namespace: NAMESPACE,
      payload: null,
      correlationId: "outside-send",
    });
    const observedDirect = await direct.read();
    assertEquals(observedDirect.done, false);
    assertEquals(observedDirect.value?.type, "test.outside-send");
    await direct.cancel();
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("internal application owns a configured Ominipg database", async () => {
  const application = await createCopilotzApplication({
    namespace: NAMESPACE,
    databaseSchema: "public",
    plugins: [coreCollectionsPlugin],
    database: { url: ":memory:" },
  });
  try {
    assertEquals(application.config.databaseOwnership, "application");
    const created = await createTestDomainContext(
      application,
      NAMESPACE,
    ).actions.createThread({
      id: "owned-database-thread",
      participants: [],
    });
    assertEquals((created as { id: string }).id, "owned-database-thread");
  } finally {
    await application.shutdown();
    await application.shutdown();
  }
});

Deno.test("internal application owns its default private database", async () => {
  const application = await createCopilotzApplication({
    namespace: NAMESPACE,
    plugins: [coreCollectionsPlugin],
  });
  assertEquals(application.config.databaseOwnership, "application");
  await application.shutdown();
  await application.shutdown();
});

Deno.test("application Adapters overlay plugin Adapters", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const replacement: LlmAdapter = Object.freeze({
    call: () => {
      throw new Error("application LLM Adapter is not invoked");
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_core`,
    plugins: [corePlugin],
    adapters: { llm: { openai: replacement } },
  });
  try {
    assertEquals(application.config.pluginIds, [
      "@copilotz/llm",
      "@copilotz/core",
    ]);
    assertEquals(
      application.plugins.adapters.llm.openai,
      replacement,
    );
    assertEquals(application.plugins.resources.agents?.missing, undefined);
  } finally {
    await application.shutdown();
    await closeDb(db);
  }
});

Deno.test("application never closes an injected database", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let closes = 0;
  const injected = Object.freeze({
    query: db.query,
    transaction: db.transaction,
    async close() {
      closes += 1;
      await db.close();
    },
  });
  const application = await createCopilotzApplication({
    database: injected,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_owned`,
    plugins: [coreCollectionsPlugin],
  });
  await Promise.all([application.shutdown(), application.shutdown()]);
  assertEquals(closes, 0);
  assertEquals(application.config.databaseOwnership, "injected");
  await injected.query("SELECT 1");
  await injected.close();
  assertEquals(closes, 1);
});

Deno.test("recovery owner startup reclaims an expired delivery lease left by a crashed runtime", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const schema = `${SCHEMA}_startup_recovery`;
  const calls = { count: 0 };
  const plugin = startupRecoveryPlugin(calls);
  const starter = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: schema,
    plugins: [plugin],
  });
  let recovered:
    | Awaited<ReturnType<typeof createCopilotzApplication>>
    | undefined;
  try {
    await starter.shutdown();
    const store = createEventStore({
      session: createSqlSession(database),
      schema,
    });
    const committed = await store.append({
      type: "test.application.startup-recovery",
      namespace: NAMESPACE,
      payload: {},
    }, ["processor:test.application.startup-recovery-complete"]);
    const delivery = committed.deliveries[0];
    assertExists(delivery);
    assertExists(
      await store.claimDelivery({ id: delivery.id, owner: "crashed" }),
    );
    const tables = createCoreTableNames(schema);
    await database.query(
      `UPDATE ${tables.event_deliveries}
       SET lease_expires_at = NOW() - INTERVAL '1 millisecond'
       WHERE id = $1`,
      [delivery.id],
    );

    recovered = await createCopilotzApplication({
      database,
      namespace: NAMESPACE,
      databaseSchema: schema,
      plugins: [plugin],
    });
    await recovered.startRecovery();
    const settled = await waitForTestDelivery(
      recovered,
      NAMESPACE,
      committed.event.id,
      "succeeded",
    );
    assertEquals(settled.attempts, 2);
    assertEquals(calls.count, 1);
  } finally {
    await starter.shutdown();
    await recovered?.shutdown();
    await database.close();
  }
});

Deno.test("opening a tenant scope recovers its expired delivery lease", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const schema = `${SCHEMA}_tenant_startup_recovery`;
  const tenantSchema = `${schema}_tenant`;
  const calls = { count: 0 };
  const plugin = startupRecoveryPlugin(calls);
  const session = createSqlSession(database);
  await provisionCopilotzSchema(session, tenantSchema);
  await provisionOperationCatalog(session, tenantSchema);
  const store = createEventStore({ session, schema: tenantSchema });
  const committed = await store.append({
    type: "test.application.startup-recovery",
    namespace: NAMESPACE,
    payload: {},
  }, ["processor:test.application.startup-recovery-complete"]);
  const delivery = committed.deliveries[0];
  assertExists(delivery);
  assertExists(
    await store.claimDelivery({ id: delivery.id, owner: "crashed" }),
  );
  const tables = createCoreTableNames(tenantSchema);
  await database.query(
    `UPDATE ${tables.event_deliveries}
     SET lease_expires_at = NOW() - INTERVAL '1 millisecond'
     WHERE id = $1`,
    [delivery.id],
  );
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: schema,
    plugins: [plugin],
  });
  try {
    await application.startRecovery();
    assertEquals(calls.count, 0);
    const tenant = await application.databaseScope(tenantSchema);
    const settled = await waitForTestDelivery(
      tenant,
      NAMESPACE,
      committed.event.id,
      "succeeded",
    );
    assertEquals(settled.attempts, 2);
    assertEquals(calls.count, 1);
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("persistence outage interrupts active send observers without cancelling durable work", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let generation = 0;
  let failNextQuery = false;
  let processorCalls = 0;
  let releaseActiveSend = () => {};
  let activeSendStarted = () => {};
  const activeSendStartedPromise = new Promise<void>((resolve) => {
    activeSendStarted = resolve;
  });
  const activeSendReleasePromise = new Promise<void>((resolve) => {
    releaseActiveSend = resolve;
  });
  const closedGenerations: number[] = [];
  const lifecycle: string[] = [];
  const processor = defineProcessor<ProcessorContext>({
    id: "application.recovery",
    on: [{ eventType: "message.created" }],
    handle() {
      processorCalls += 1;
      if (processorCalls === 1) throw new Error("retry this delivery");
    },
  });
  const plugin = definePlugin({
    id: "test.application.recovery",
    version: "1.0.0",
    processors: {
      recovery: processor,
      activeSend: defineProcessor<ProcessorContext>({
        id: "application.active-send",
        on: [{ eventType: "application.persistence-active-send" }],
        async handle() {
          activeSendStarted();
          await activeSendReleasePromise;
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: {
      connect() {
        generation += 1;
        const selected = generation;
        const query: CopilotzDatabase["query"] = async <
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(sql: string, params?: unknown[]) => {
          if (selected === 1 && failNextQuery) {
            failNextQuery = false;
            throw Object.assign(new Error("connection reset by peer"), {
              code: "ECONNRESET",
            });
          }
          return await db.query<TRow>(sql, params);
        };
        return Object.freeze({
          query,
          transaction: db.transaction,
          close() {
            closedGenerations.push(selected);
            return Promise.resolve();
          },
        });
      },
    },
    databaseRecovery: { waitMs: 100 },
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_recovery`,
    plugins: [coreCollectionsPlugin, plugin],
    engine: {
      retryBaseMs: 0,
      random: () => 0,
      execution: {
        // Hold timer-driven retries so the test can observe retry_wait. The
        // persistence reconnect below must recover the due delivery itself.
        scheduler: {
          schedule(callback) {
            return callback;
          },
          cancel() {},
        },
      },
    },
  }, {
    onUnavailable: ({ generation }) => {
      lifecycle.push(`unavailable:${generation}`);
    },
    onReconnecting: ({ generation }) => {
      lifecycle.push(`reconnecting:${generation}`);
    },
    onReady: ({ generation }) => {
      lifecycle.push(`ready:${generation}`);
    },
  });
  try {
    await createTestDomainContext(application, NAMESPACE).actions.createThread(
      {
        id: "recovery-thread",
        participants: [{
          id: "recovery-user",
          externalId: "recovery-user",
          participantType: "human",
        }],
      },
    );
    await createTestDomainContext(application, NAMESPACE).actions
      .createThreadMessage({
        id: "recovery-message",
        threadId: "recovery-thread",
        sender: {
          id: "recovery-user",
          externalId: "recovery-user",
          participantType: "human",
        },
        content: "recover",
      }, { identity: { deduplicationId: "recovery-message:create" } });
    const messageEvent = (await application.events.list({
      namespace: NAMESPACE,
      threadId: "recovery-thread",
      limit: 100,
    })).find((event) => event.subject?.id === "recovery-message");
    assertExists(messageEvent);
    const messageDelivery = await waitForTestDelivery(
      application,
      NAMESPACE,
      messageEvent.id,
      "retry_wait",
      5_000,
    );
    assertEquals(messageDelivery.status, "retry_wait");
    assertEquals(processorCalls, 1);

    const activeSend = await application.send({
      type: "application.persistence-active-send",
      namespace: NAMESPACE,
    });
    const reader = activeSend.outputs.getReader();
    await activeSendStartedPromise;
    failNextQuery = true;
    const error = await assertRejects(() =>
      projectMessages(application, NAMESPACE, "recovery-thread")
    );
    assert(isCopilotzPersistenceError(error));
    assertEquals(error.code, "persistence_indeterminate");
    const outputError = await assertRejects(() => reader.read());
    assert(isCopilotzPersistenceError(outputError));
    assertEquals(outputError.code, "persistence_indeterminate");
    const doneError = await assertRejects(() => activeSend.done);
    assert(isCopilotzPersistenceError(doneError));
    assertEquals(doneError.code, "persistence_indeterminate");

    await waitFor(() => lifecycle.includes("ready:2"));
    const activeSettlement = await application.events.settlement(
      NAMESPACE,
      activeSend.eventId,
    );
    assertEquals(activeSettlement.cancelled, 0);
    releaseActiveSend();
    const delivery = await waitForTestDelivery(
      application,
      NAMESPACE,
      messageEvent.id,
      "succeeded",
      5_000,
    );
    assertEquals(delivery.status, "succeeded");
    assertEquals(delivery.id, messageDelivery.id);
    assertEquals(processorCalls, 2);
    assertEquals(
      (await projectMessages(application, NAMESPACE, "recovery-thread")).length,
      1,
    );
    assertEquals(lifecycle, [
      "ready:1",
      "unavailable:1",
      "reconnecting:1",
      "ready:2",
    ]);
    await waitFor(() => closedGenerations.includes(1));
  } finally {
    await application.shutdown();
    await db.close();
  }
  assertEquals(closedGenerations, [1, 2]);
});

Deno.test("application shutdown interrupts local sends without cancelling their durable scope", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let waitForAbort = true;
  let processorStarted = () => {};
  const started = new Promise<void>((resolve) => processorStarted = resolve);
  const processor = defineProcessor<ProcessorContext>({
    id: "test.application.shutdown-interrupt",
    on: [{ eventType: "test.application.shutdown-interrupt" }],
    async handle(_event, context) {
      processorStarted();
      if (!waitForAbort) return;
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_shutdown_scope`,
    plugins: [definePlugin({
      id: "test.application.shutdown-interrupt",
      version: "1.0.0",
      processors: { shutdownInterrupt: processor },
    })],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  let recovered:
    | Awaited<ReturnType<typeof createCopilotzApplication>>
    | undefined;
  try {
    const send = await application.send({
      type: "test.application.shutdown-interrupt",
      namespace: NAMESPACE,
    });
    const reader = send.outputs.getReader();
    await started;

    await application.shutdown("test_application_shutdown");

    await assertRejects(
      () => reader.read(),
      Error,
      "test_application_shutdown",
    );
    await assertRejects(() => send.done, Error, "test_application_shutdown");
    const settlement = await application.events.settlement(
      NAMESPACE,
      send.eventId,
    );
    assertEquals(settlement.cancelled, 0);
    assertEquals(settlement.unsettled > 0, true);

    waitForAbort = false;
    recovered = await createCopilotzApplication({
      database: db,
      namespace: NAMESPACE,
      databaseSchema: `${SCHEMA}_shutdown_scope`,
      plugins: [definePlugin({
        id: "test.application.shutdown-interrupt",
        version: "1.0.0",
        processors: { shutdownInterrupt: processor },
      })],
      engine: { retryBaseMs: 0, random: () => 0 },
    });
    await recovered.recoverAll({ limit: 100 });
    await waitForTestDelivery(
      recovered,
      NAMESPACE,
      send.eventId,
      "succeeded",
    );
    assertEquals(
      (await recovered.events.settlement(NAMESPACE, send.eventId)).cancelled,
      0,
    );

    let explicitCancelStarted = () => {};
    const explicitCancelStartedPromise = new Promise<void>((resolve) =>
      explicitCancelStarted = resolve
    );
    processorStarted = explicitCancelStarted;
    waitForAbort = true;
    const explicitlyCancelled = await recovered.send({
      type: "test.application.shutdown-interrupt",
      namespace: NAMESPACE,
    });
    await explicitCancelStartedPromise;
    await explicitlyCancelled.cancel("test_explicit_send_cancel");
    const explicitSettlement = await recovered.events.settlement(
      NAMESPACE,
      explicitlyCancelled.eventId,
    );
    assertEquals(explicitSettlement.cancelled > 0, true);
    await assertRejects(
      () => explicitlyCancelled.done,
      Error,
      "test_explicit_send_cancel",
    );
  } finally {
    await application.shutdown();
    await recovered?.shutdown();
    await db.close();
  }
});

Deno.test("application composition remains factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "application.ts",
      "index.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
    assert(!/attachments/.test(source), module);
    assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source), module);
  }
});
