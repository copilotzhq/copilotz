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
import type { ApplicationOutput, StreamOutput } from "../streams/index.ts";

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
    assertEquals("durable" in streamOutput, false);
    assertEquals("threadId" in streamOutput, false);
    assertEquals(streamOutput.namespace, NAMESPACE);
    assertEquals(streamOutput.streamId, "runtime-neutral-stream-a");
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
    engine: { retryBaseMs: 0, random: () => 0 },
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
    await waitFor(() => processorCalls === 2);
    const delivery = await application.deliveries.get(
      NAMESPACE,
      messageDelivery.id,
    );
    assertEquals(delivery?.status, "succeeded");
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
