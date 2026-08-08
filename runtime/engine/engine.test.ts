import { assert, assertEquals, assertExists } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import { defineCollection, llmAttemptContent } from "../domain/index.ts";
import { createSqlSession, type SqlSession } from "../events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import {
  type CopilotzEngine,
  type CopilotzProcessorContext,
  createCopilotzEngine,
} from "./index.ts";

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
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => event.routing?.senderId === "user-a",
    async handle(event, context) {
      if (!event.durable) throw new Error("Durable delivery received a frame.");
      calls += 1;
      leakedStorage = leakedStorage || "eventStore" in context ||
        "session" in context || "coordinator" in context ||
        "coordinator" in context.conversation ||
        "coordinator" in context.llmAttempts ||
        "coordinator" in context.toolExecutions;
      assertEquals(context.namespace, "tenant-a");
      assertEquals(context.event.id, event.id);
      assertEquals(
        context.resources.require<{ key: string }>("tools", "echo").key,
        "echo",
      );

      const message = await context.conversation.getMessage(event.subject!.id);
      assertExists(message);
      const resolved = await context.content.resolveMany(message.content);
      assertEquals(resolved[0].text, "Hello engine");
      const prepared = await context.content.prepare(
        { type: "text", text: `input:${resolved[0].text}` },
        { operationKey: "logical-input" },
      );
      await context.llmAttempts.create({
        id: `attempt:${message.id}`,
        threadId: message.threadId,
        messageId: message.id,
        participantId: "agent-a",
        agentId: "support",
        input: prepared,
      });
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
    plugins: [definePlugin({
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
    })],
  });
  let nextId = 0;
  const engine = await createCopilotzEngine({
    session,
    registry,
    schema: TEST_SCHEMA,
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

    await fixture.engine.conversation.createThread({
      namespace: "tenant-a",
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
      identity: { deduplicationId: "thread-a:create" },
    });
    const content = await fixture.engine.content.preparer.prepare(
      "Hello engine",
      {
        namespace: "tenant-a",
        idempotencyKey: "message-a:body",
      },
    );
    const frames = fixture.engine.events.subscribe({
      namespace: "tenant-a",
      threadId: "thread-a",
      types: ["text.delta"],
    }).getReader();
    const message = await fixture.engine.conversation.createMessage({
      namespace: "tenant-a",
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      recipientIds: ["agent-a"],
      content,
      identity: {
        correlationId: "run-a",
        deduplicationId: "message-a:create",
      },
    });
    assertEquals(message.dispatch.handles.length, 1);
    const first = await message.dispatch.handles[0].done;
    assertEquals(first.delivery.status, "retry_wait");
    const frame = (await frames.read()).value!;
    assertEquals(frame.durable, false);
    assertEquals(frame.correlationId, "run-a");
    assertEquals(frame.causationId, message.event.id);
    await frames.cancel();

    const recovery = await fixture.engine.recover({ namespace: "tenant-a" });
    assertEquals(recovery.failures, []);
    assertEquals(recovery.handles.length, 1);
    const second = await recovery.handles[0].done;
    assertEquals(second.delivery.status, "succeeded");
    assertEquals(fixture.processorCalls(), 2);
    assertEquals(fixture.leakedStorage(), false);

    const attempts = await fixture.engine.llmAttempts.list(
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
    assertEquals(audits[0].id, `audit:${message.event.id}`);
    const events = await fixture.engine.events.list({ namespace: "tenant-a" });
    assertEquals(events.some((event) => event.type === "text.delta"), false);
    const attemptEvent = events.find((event) =>
      event.type === "llm_attempt.created"
    );
    const auditEvent = events.find((event) =>
      event.type === "engine_audit.created"
    );
    assertEquals(attemptEvent?.causationId, message.event.id);
    assertEquals(attemptEvent?.correlationId, "run-a");
    assertEquals(auditEvent?.causationId, message.event.id);
    assertEquals(
      await fixture.engine.events.settlement("tenant-a", message.event.id),
      { unsettled: 0, deadLetters: 0, cancelled: 0, succeeded: 1 },
    );

    const assets = await fixture.session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${TEST_SCHEMA}.nodes
       WHERE namespace = $1 AND type = 'asset'`,
      ["tenant-a"],
    );
    assertEquals(Number(assets.rows[0].count), 2);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("engine shutdown releases only its worker and leaves injected infrastructure usable", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const registry = await createPluginRegistry();
  const hypervisor = createHypervisor({
    persistAcceptance: () => Promise.resolve(),
  });
  const engine = await createCopilotzEngine({
    session,
    registry,
    schema: "copilotz_shared_engine",
    execution: { hypervisor, workerId: "shared-engine" },
  });
  let applicationRun: Promise<unknown> | undefined;
  try {
    assertEquals(engine.execution.ownership, "shared_hypervisor");
    await engine.shutdown();
    assertEquals(hypervisor.snapshot().inProcessWorkers, 0);
    await session.query("SELECT 1");

    const applicationWorker = createWorker({
      id: "application-probe",
      transport: { type: "in-process", hypervisor },
      workloads: {
        "application.probe.v1": () => ({ metadata: { alive: true } }),
      },
    });
    applicationRun = applicationWorker.run();
    void applicationRun.catch(() => {});
    await applicationWorker.whenReady();
    const probe = await hypervisor.dispatch({
      workload: "application.probe.v1",
    });
    assertEquals(await probe.metadata, { alive: true });
    assertEquals((await probe.completed).status, "completed");
  } finally {
    await engine.shutdown();
    await hypervisor.shutdown();
    if (applicationRun) await applicationRun;
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
