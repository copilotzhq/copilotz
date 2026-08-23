import { message as coreMessage } from "@copilotz/copilotz/plugins/core";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type AnyCopilotzPlugin,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import { waitForTestDelivery } from "../../runtime/testing/deliveries.ts";
import { projectMessages } from "../../runtime/testing/projections.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
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
  const processor = defineProcessor<CopilotzProcessorContext>({
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
      const persisted = await context.content.materialize(content);
      await context.collections.message.create({
        id: `reply:${incoming.id}`,
        threadId: incoming.threadId,
        senderId: "agent-a",
        recipientIds: [incoming.sender.id],
        content: persisted,
      }, { operationKey: "reply-message" });
      await context.content.linkOwner(`reply:${incoming.id}`, persisted);
    },
  });
  return definePlugin({
    id: "test.application.reply",
    version: "1.0.0",
    processors: { reply: processor },
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
  const processor = defineProcessor<CopilotzProcessorContext>({
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
    assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source), module);
  }
});
