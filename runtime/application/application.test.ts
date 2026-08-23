import { message as coreMessage } from "@copilotz/copilotz/core";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type AnyCopilotzPlugin,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import { waitForTestDelivery } from "../../runtime/testing/deliveries.ts";
import { projectMessages } from "../../runtime/testing/projections.ts";
import { createCopilotzApplication } from "./application.ts";
import { createCopilotz } from "./copilotz.ts";
import type { CopilotzDatabase } from "./persistence.ts";
import { isCopilotzPersistenceError } from "./persistence.ts";
import { loadMessageRecord } from "../engine/collection-graph.ts";
import {
  coreCollectionsPlugin,
  corePlugin,
} from "../../plugins/core/plugin.ts";
import type { TestDatabase } from "../testing/ominipg.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

const SCHEMA = "copilotz_application";
const NAMESPACE = "tenant-a";

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
      await writer.abort();
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
      await writer.abort();
    },
  });
  return definePlugin({
    id: "test.application.correlated-output",
    version: "1.0.0",
    processors: { correlatedOutput: processor },
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
    assert("durable" in stream && !stream.durable);
    assertEquals(stream.durable, false);
    assertEquals(stream.threadId, undefined);
    assertEquals(stream.streamId, "runtime-neutral-stream-a");
    assertEquals(stream.correlationId, "runtime-neutral-correlation");
    assertEquals(stream.payload, {
      streamId: "runtime-neutral-stream-a",
      mediaType: "text/plain",
      kind: "text",
      role: "output",
    });
    assertEquals(stream.metadata.source, "test-plugin");
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
    const global = application.observe().getReader();
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

    const globallyObserved = [];
    while (globallyObserved.length < 4) {
      const next = await global.read();
      assertEquals(next.done, false);
      globallyObserved.push(next.value!);
    }
    assertEquals(
      new Set(globallyObserved.map((event) => event.correlationId)),
      new Set(["correlation-first", "correlation-second"]),
    );
    await global.cancel();

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

Deno.test("createCopilotz owns a configured Ominipg database", async () => {
  const application = await createCopilotz({
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

Deno.test("createCopilotz owns its default private database", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    plugins: [coreCollectionsPlugin],
  });
  assertEquals(application.config.databaseOwnership, "application");
  await application.shutdown();
  await application.shutdown();
});

Deno.test("application Adapters overlay plugin Adapters", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const replacement = Object.freeze({
    id: "openai",
    type: "llm",
    marker: "application",
    generate: () => {
      throw new Error("application llm is not invoked");
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

Deno.test("application terminates attachments and resumes durable deliveries after reconnect", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let generation = 0;
  let failNextQuery = false;
  let processorCalls = 0;
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
    processors: { recovery: processor },
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
    );
    assertEquals(messageDelivery.status, "retry_wait");
    assertEquals(processorCalls, 1);

    const attachment = await application.engine.connect({
      namespace: NAMESPACE,
      thread: "recovery-thread",
      participant: "recovery-user",
    });
    const reader = attachment.outputs.getReader();
    const terminal = assertRejects(() => reader.read());
    failNextQuery = true;
    const error = await assertRejects(() =>
      projectMessages(application, NAMESPACE, "recovery-thread")
    );
    assert(isCopilotzPersistenceError(error));
    assertEquals(error.code, "persistence_indeterminate");
    const attachmentError = await terminal;
    assert(isCopilotzPersistenceError(attachmentError));
    assertEquals(attachmentError.code, "persistence_indeterminate");

    await waitFor(() => lifecycle.includes("ready:2"));
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
