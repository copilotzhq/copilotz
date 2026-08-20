import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  createSqlSession,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import { waitForTestDelivery } from "../../runtime/testing/deliveries.ts";
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
} from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import {
  type CopilotzEngine,
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import {
  composeRoleContent,
  defineCollection,
  LLM_CONTENT_ROLE,
  llmAttemptContent,
} from "../domain/index.ts";

const TEST_SCHEMA = "copilotz_factory_engine";

const auditCollection = defineCollection({
  name: "engine_audit",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      sourceEventId: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "sourceEventId"],
  } as const,
});

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  engine: CopilotzEngine;
  processorCalls: () => number;
  leakedStorage: () => boolean;
}>;

async function createFixture(): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  let calls = 0;
  let leakedStorage = false;
  const echoTool = Object.freeze({
    key: "echo",
    name: "Echo",
    execute: (value: unknown) => value,
  });
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "engine.message.to-attempt",
    on: [{ eventType: "message.created", routing: { senderId: "user-a" } }],
    async handle(event, context) {
      if (!event.durable) throw new Error("Durable delivery received a frame.");
      calls += 1;
      leakedStorage = leakedStorage || "eventStore" in context ||
        "session" in context || "coordinator" in context ||
        "coordinator" in context.collections ||
        "collectionRuntime" in context;
      assertEquals(context.namespace, "tenant-a");
      assertEquals(context.event.id, event.id);
      assertEquals(
        context.resources.require<{ key: string }>("tools", "echo").key,
        "echo",
      );

      const message = await context.collections.message.get({
        id: event.subject!.id,
      });
      assertExists(message);
      const resolved = await context.content.resolveMany(
        Array.isArray(message.content) ? message.content : [],
      );
      assertEquals(resolved[0].text, "Hello engine");
      const prepared = await context.content.prepare(
        { type: "text", text: `input:${resolved[0].text}` },
        { operationKey: "logical-input" },
      );
      const attemptId = `attempt:${message.id}`;
      if (
        !await context.collections.llm_attempt.get({ id: attemptId })
      ) {
        await context.features.llmAttempt.create({
          id: attemptId,
          threadId: message.threadId,
          messageId: message.id,
          participantId: "agent-a",
          agentId: "support",
          content: composeRoleContent([{
            role: LLM_CONTENT_ROLE.input,
            input: prepared,
            cardinality: "one",
          }]),
        }, { operationKey: "logical-attempt" });
      }
      await context.collections.engine_audit.create({
        id: `audit:${event.id}`,
        sourceEventId: event.id,
      });
      await context.events.emit({
        type: "text.delta",
        payload: { text: `attempt-${calls}` },
        streamId: `stream:${event.id}`,
        sequence: calls,
      });
      if (calls === 1) {
        throw new Error("synthetic crash after typed projections");
      }
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        manifest: {
          id: "test.engine",
          version: "1.0.0",
          provides: {
            processors: [processor.id],
            collections: [auditCollection.name],
            tools: [echoTool.key],
          },
        },
        resources: {
          processors: [processor],
          collections: [auditCollection],
          tools: [echoTool],
        },
      }),
    ],
  });
  let nextId = 0;
  const engine = await createCopilotzEngine({
    session,
    registry,
    defaultDatabaseSchema: TEST_SCHEMA,
    createId: () => `engine-${++nextId}`,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    random: () => 0,
    retryBaseMs: 0,
  });
  return Object.freeze({
    db,
    session,
    engine,
    processorCalls: () => calls,
    leakedStorage: () => leakedStorage,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

Deno.test("factory engine scopes typed processor capabilities and deduplicates retry projections", async () => {
  const fixture = await createFixture();
  try {
    assertEquals(fixture.engine.execution.ownership, "private_hypervisor");
    assert(!("eventStore" in fixture.engine));
    assert(!("session" in fixture.engine));
    assert(!("coordinator" in fixture.engine));

    const tables = await fixture.session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [TEST_SCHEMA],
    );
    assertEquals(
      tables.rows.map((row) => row.table_name),
      ["edges", "event_deliveries", "events", "nodes"],
    );

    const namespace = "tenant-a";
    const participants = fixture.engine.collectionRuntime.get("participant");
    const threads = fixture.engine.collectionRuntime.get("thread");
    const messages = fixture.engine.collectionRuntime.get("message");
    assertExists(participants);
    assertExists(threads);
    assertExists(messages);
    await participants.create({
      id: "user-a",
      externalId: "user-a",
      participantType: "human",
    }, { namespace });
    await participants.create({
      id: "agent-a",
      externalId: "support",
      participantType: "agent",
      agentId: "support",
    }, { namespace });
    await threads.create({
      id: "thread-a",
      participantIds: ["user-a", "agent-a"],
    }, {
      namespace,
      identity: { deduplicationId: "thread-a:create" },
    });
    const content = await fixture.engine.content.preparer.prepare(
      "Hello engine",
      {
        namespace,
        idempotencyKey: "message-a:body",
      },
    );
    const frames = fixture.engine.events.subscribe({
      namespace,
      threadId: "thread-a",
      types: ["text.delta"],
    }).getReader();
    await createTestDomainContext(fixture.engine, namespace).features
      .threadMessage.create({
        id: "message-a",
        threadId: "thread-a",
        sender: {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        recipientIds: ["agent-a"],
        content,
      }, {
        identity: {
          correlationId: "run-a",
          deduplicationId: "message-a:create",
        },
      });
    const messageEvent = (await fixture.engine.events.list({
      namespace,
      threadId: "thread-a",
      limit: 100,
    })).find((event) => event.subject?.id === "message-a");
    assertExists(messageEvent);
    const first = await waitForTestDelivery(
      fixture.engine,
      namespace,
      messageEvent.id,
      "retry_wait",
    );
    assertEquals(first.status, "retry_wait");
    const frame = (await frames.read()).value!;
    assertEquals(frame.durable, false);
    assertEquals(frame.correlationId, "run-a");
    assertEquals(frame.causationId, messageEvent.id);
    await frames.cancel();

    const recovery = await fixture.engine.recover({ namespace: "tenant-a" });
    assertEquals(recovery.failures, []);
    assertEquals(recovery.handles.length, 1);
    const second = await recovery.handles[0].done;
    assertEquals(second.delivery.status, "succeeded");
    assertEquals(fixture.processorCalls(), 2);
    assertEquals(fixture.leakedStorage(), false);

    const attempts = await projectLlmAttempts(
      fixture.engine,
      "tenant-a",
      "thread-a",
    );
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0].id, "attempt:message-a");
    const attemptInput = llmAttemptContent(attempts[0]).input;
    assertEquals(attemptInput.length, 1);
    assertEquals(
      (await fixture.engine.content.resolver.get(attemptInput[0], {
        namespace: "tenant-a",
      })).text,
      "input:Hello engine",
    );

    const audits = await fixture.engine.collections.get("engine_audit").list(
      "tenant-a",
    );
    assertEquals(audits.length, 1);
    assertEquals(audits[0].id, `audit:${messageEvent.id}`);
    const events = await fixture.engine.events.list({ namespace: "tenant-a" });
    assertEquals(events.some((event) => event.type === "text.delta"), false);
    const attemptEvent = events.find((event) =>
      event.type === "llm_attempt.created"
    );
    const auditEvent = events.find((event) =>
      event.type === "engine_audit.created"
    );
    assertEquals(attemptEvent?.causationId, messageEvent.id);
    assertEquals(attemptEvent?.correlationId, "run-a");
    assertEquals(auditEvent?.causationId, messageEvent.id);
    assertEquals(
      await fixture.engine.events.settlement(
        "tenant-a",
        second.delivery.settlementScopeId,
      ),
      { unsettled: 0, deadLetters: 0, cancelled: 0, succeeded: 1 },
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("engine shutdown releases only its worker and leaves injected infrastructure usable", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const registry = await createPluginRegistry();
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.engine.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transport],
  });
  const engine = await createCopilotzEngine({
    session,
    registry,
    defaultDatabaseSchema: "copilotz_shared_engine",
    execution: { hypervisor, transport, workerId: "shared-engine" },
  });
  let applicationWorker: ReturnType<typeof createWorker> | undefined;
  try {
    assertEquals(engine.execution.ownership, "shared_hypervisor");
    await engine.shutdown();
    assertEquals(hypervisor.snapshot().inProcessWorkers, 0);
    await session.query("SELECT 1");

    applicationWorker = createWorker({
      id: "application-probe",
      transport,
      workloads: {
        "application.probe.v1": () => ({ metadata: { alive: true } }),
      },
    });
    await applicationWorker.ready;
    const probe = await hypervisor.dispatch({
      workload: "application.probe.v1",
    });
    assertEquals(await probe.metadata, { alive: true });
    assertEquals((await probe.completed).status, "completed");
  } finally {
    await engine.shutdown();
    await applicationWorker?.stop();
    await applicationWorker?.closed;
    await hypervisor.shutdown();
    await db.close();
  }
});

Deno.test("one engine isolates lazy physical-schema repository scopes", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const handledSchemas: string[] = [];
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: "engine.scope.audit",
    on: [{ eventType: "thread.created" }],
    async handle(event, context) {
      if (!event.durable) throw new Error("Expected a durable event.");
      handledSchemas.push(context.databaseSchema);
      await context.collections.engine_audit.create({
        id: `audit:${event.subject?.id}`,
        sourceEventId: event.id,
      });
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        manifest: {
          id: "test.engine.scopes",
          version: "1.0.0",
          provides: {
            collections: [auditCollection.name],
            processors: [processor.id],
          },
        },
        resources: {
          collections: [auditCollection],
          processors: [processor],
        },
      }),
    ],
  });
  const engine = await createCopilotzEngine({
    session,
    registry,
    defaultDatabaseSchema: "copilotz_scope_a",
  });
  try {
    await provisionCopilotzSchema(session, "copilotz_scope_b");
    const first = await engine.databaseScope("copilotz_scope_a");
    const second = await engine.databaseScope("copilotz_scope_b");
    await first.collectionRuntime.withScope({ namespace: "tenant" }).thread
      .create({
        id: "same-thread",
        status: "first",
      });
    await second.collectionRuntime.withScope({ namespace: "tenant" }).thread
      .create({
        id: "same-thread",
        status: "second",
      });
    for (const scope of [first, second]) {
      const created = (await scope.events.list({
        namespace: "tenant",
        limit: 100,
      })).find((event) =>
        event.type === "thread.created" && event.subject?.id === "same-thread"
      );
      assertExists(created);
      await waitForTestDelivery(
        scope,
        "tenant",
        created.id,
        "succeeded",
      );
    }

    assertEquals(
      (await first.collectionRuntime.withScope({ namespace: "tenant" }).thread
        .get({ id: "same-thread" }))?.status,
      "first",
    );
    assertEquals(
      (await second.collectionRuntime.withScope({ namespace: "tenant" }).thread
        .get({ id: "same-thread" }))?.status,
      "second",
    );
    assertEquals(
      (await first.collections.get("engine_audit").list("tenant")).map(
        (row) => row.id,
      ),
      ["audit:same-thread"],
    );
    assertEquals(
      (await second.collections.get("engine_audit").list("tenant")).map(
        (row) => row.id,
      ),
      ["audit:same-thread"],
    );
    assertEquals(handledSchemas.sort(), [
      "copilotz_scope_a",
      "copilotz_scope_b",
    ]);
    assertEquals(engine.execution.ownership, "private_hypervisor");
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("lazy database scopes validate with read-only SQL and reject unprovisioned schemas", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry();
  const defaultSchema = "copilotz_scope_validation_default";
  const tenantSchema = "copilotz_scope_validation_tenant";
  await provisionCopilotzSchema(db, tenantSchema);
  const observed: string[] = [];
  const session: SqlSession = {
    query(sql, params) {
      observed.push(sql);
      return db.query(sql, params);
    },
    transaction: db.transaction,
  };
  const engine = await createCopilotzEngine({
    session,
    registry,
    defaultDatabaseSchema: defaultSchema,
  });
  try {
    observed.length = 0;
    await engine.databaseScope(tenantSchema);
    assertEquals(observed.length, 1);
    assertEquals(/information_schema\.columns/i.test(observed[0]), true);
    assertEquals(/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(observed[0]), false);

    await assertRejects(
      () => engine.databaseScope("copilotz_scope_validation_missing"),
      Error,
      "is not provisioned",
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("A55 engine assembly is factory-first and runtime-neutral", async () => {
  for (const module of ["context.ts", "engine.ts", "index.ts", "types.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
    assert(
      !/unsafeGraph|producedEvents|queueId|runGeneration/.test(
        source,
      ),
      module,
    );
  }
});
