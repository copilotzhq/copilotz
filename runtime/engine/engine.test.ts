import { coreCollectionsPlugin } from "@copilotz/copilotz/core";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  createSqlSession,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import { createTestDomainContext } from "../../plugins/core/internal/testing/context.ts";
import { waitForTestDelivery } from "../../runtime/testing/deliveries.ts";
import { projectActionEvents } from "../../plugins/core/internal/testing/projections.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { type CopilotzEngine, createCopilotzEngine } from "./index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import { defineCollection } from "../collections/index.ts";
import { type ActionCaller, defineAction } from "../actions/index.ts";
import type { ContentRef } from "../content/index.ts";
import {
  isStreamOutputDescriptor,
  provisionOperationCatalog,
  type StreamOutput,
} from "../streams/index.ts";

const TEST_SCHEMA = "copilotz_factory_engine";

const auditCollection = defineCollection({
  name: "engine_audit",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      sourceEventId: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "sourceEventId"],
  } as const,
});

const engineEchoAction = defineAction({
  id: "test.engine.echo.run",
  execute: (input: unknown) => structuredClone(input),
});

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  engine: CopilotzEngine;
  processorCalls: () => number;
  leakedStorage: () => boolean;
  streamOutputs: () => readonly Readonly<{
    streamId: string;
    semanticId: unknown;
  }>[];
}>;

async function createFixture(): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  let calls = 0;
  let leakedStorage = false;
  const streamOutputs: Array<
    Readonly<{
      streamId: string;
      semanticId: unknown;
    }>
  > = [];
  const echoTool = Object.freeze({
    action: "echo",
    name: "Echo",
    description: "Echo the supplied Action input.",
  });
  type FixtureProcessorContext =
    & Omit<ProcessorContext, "actions">
    & Readonly<{
      actions: Readonly<{
        echo: ActionCaller<typeof engineEchoAction>;
      }>;
    }>;
  const processor = defineProcessor<FixtureProcessorContext>({
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
      assertEquals(
        (context.resources.tools?.echo as typeof echoTool | undefined)?.action,
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
      const content = await context.content.materialize(prepared);
      await context.actions.echo({
        id: attemptId,
        threadId: message.threadId,
        messageId: message.id,
        participantId: "agent-a",
        agentId: "support",
        content,
      }, { operationKey: "logical-attempt" });
      await context.collections.engineAudit.create({
        id: `audit:${event.id}`,
        sourceEventId: event.id,
      });
      const retryStream = await context.streams.open({
        id: "retry-provider-lane",
        mediaType: "text/plain",
        role: "assistant",
      });
      await retryStream.append({
        bytes: new TextEncoder().encode(
          calls === 1 ? "stale-partial" : "recovered-complete",
        ),
        appendId: `delivery-attempt-${calls}`,
      });
      if (calls === 1) {
        throw new Error("synthetic crash after typed projections");
      }
      await retryStream.close({ assetId: `stream:${retryStream.id}` });
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        id: "test.engine",
        version: "1.0.0",
        processors: { messageToAttempt: processor },
        collections: { engineAudit: auditCollection },
        actions: { echo: engineEchoAction },
        resources: { tools: { echo: echoTool } },
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
    execution: {
      scheduler: {
        schedule(callback) {
          return callback;
        },
        cancel() {},
      },
    },
    publish(output) {
      if (isStreamOutputDescriptor(output)) {
        streamOutputs.push(Object.freeze({
          streamId: output.streamId,
          semanticId: output.metadata.contentStreamSemanticId,
        }));
      }
    },
    publishLocalStream(output: StreamOutput) {
      streamOutputs.push(Object.freeze({
        streamId: output.streamId,
        semanticId: output.metadata.contentStreamSemanticId,
      }));
    },
  });
  return Object.freeze({
    db,
    session,
    engine,
    processorCalls: () => calls,
    leakedStorage: () => leakedStorage,
    streamOutputs: () => Object.freeze([...streamOutputs]),
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
      [
        "copilotz_operation_catalog_metadata",
        "copilotz_operation_events",
        "copilotz_operation_streams",
        "copilotz_operations",
        "copilotz_schema_metadata",
        "edges",
        "event_bodies",
        "event_deliveries",
        "events",
        "nodes",
      ],
    );

    const namespace = "tenant-a";
    const participants = fixture.engine.collections.get("participant");
    const threads = fixture.engine.collections.get("thread");
    const messages = fixture.engine.collections.get("message");
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
    await createTestDomainContext(fixture.engine, namespace).actions
      .createThreadMessage({
        id: "message-a",
        threadId: "thread-a",
        sender: {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        recipientIds: ["agent-a"],
        content: "Hello engine",
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
    await fixture.engine.execution.settleOutputs({
      databaseSchema: TEST_SCHEMA,
      namespace,
      settlementScopeId: first.settlementScopeId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovery = await fixture.engine.recover({ namespace: "tenant-a" });
    assertEquals(recovery.failures, []);
    assertEquals(recovery.handles.length, 1);
    const second = await recovery.handles[0].done;
    assertEquals(second.delivery.status, "succeeded");
    assertEquals(fixture.processorCalls(), 2);
    assertEquals(fixture.leakedStorage(), false);

    const retryStreams = fixture.streamOutputs();
    assertEquals(retryStreams.length, 2);
    assertEquals(retryStreams.map((stream) => stream.semanticId), [
      "retry-provider-lane",
      "retry-provider-lane",
    ]);
    assertEquals(retryStreams[0].streamId === retryStreams[1].streamId, false);

    const attempts = await projectActionEvents(
      fixture.engine,
      "tenant-a",
      "test.engine.echo.run",
    );
    assertEquals(attempts.map((event) => event.status), [
      "invoked",
      "completed",
    ]);
    const attemptInput = (attempts[1].input as {
      content: readonly ContentRef[];
    }).content;
    assertEquals(attemptInput.length, 1);
    assertEquals(
      (await fixture.engine.content.resolver.get(attemptInput[0], {
        namespace: "tenant-a",
      })).text,
      "input:Hello engine",
    );

    const audits = await fixture.engine.collections.withScope({
      namespace: "tenant-a",
    }).engine_audit.list();
    assertEquals(audits.length, 1);
    assertEquals(audits[0].id, `audit:${messageEvent.id}`);
    const events = await fixture.engine.events.list({ namespace: "tenant-a" });
    assertEquals(events.some((event) => event.type === "text.delta"), false);
    const attemptEvent = events.find((event) =>
      event.type === "test.engine.echo.run.invoked"
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
  const processor = defineProcessor<ProcessorContext>({
    id: "engine.scope.audit",
    on: [{ eventType: "thread.created" }],
    async handle(event, context) {
      if (!event.durable) throw new Error("Expected a durable event.");
      await context.collections.engineAudit.create({
        id: `audit:${event.subject?.id}`,
        sourceEventId: event.id,
      });
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      coreCollectionsPlugin,
      definePlugin({
        id: "test.engine.scopes",
        version: "1.0.0",
        collections: { engineAudit: auditCollection },
        processors: { audit: processor },
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
    await provisionOperationCatalog(session, "copilotz_scope_b");
    const first = await engine.databaseScope("copilotz_scope_a");
    const second = await engine.databaseScope("copilotz_scope_b");
    await first.collections.withScope({ namespace: "tenant" }).thread
      .create({
        id: "same-thread",
        status: "first",
      });
    await second.collections.withScope({ namespace: "tenant" }).thread
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
      (await first.collections.withScope({ namespace: "tenant" }).thread
        .get({ id: "same-thread" }))?.status,
      "first",
    );
    assertEquals(
      (await second.collections.withScope({ namespace: "tenant" }).thread
        .get({ id: "same-thread" }))?.status,
      "second",
    );
    assertEquals(
      (await first.collections.withScope({ namespace: "tenant" }).engine_audit
        .list()).map(
          (row) => row.id,
        ),
      ["audit:same-thread"],
    );
    assertEquals(
      (await second.collections.withScope({ namespace: "tenant" }).engine_audit
        .list()).map(
          (row) => row.id,
        ),
      ["audit:same-thread"],
    );
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
  await provisionOperationCatalog(db, tenantSchema);
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
    assertEquals(observed.length, 9);
    assertEquals(/information_schema\.columns/i.test(observed[0]), true);
    assertEquals(/copilotz_schema_metadata/i.test(observed[1]), true);
    assertEquals(/information_schema\.tables/i.test(observed[2]), true);
    assertEquals(
      observed.slice(3, 7).every((sql) => /to_regclass/i.test(sql)),
      true,
    );
    assertEquals(/information_schema\.columns/i.test(observed[7]), true);
    assertEquals(
      /copilotz_operation_catalog_metadata/i.test(observed[8]),
      true,
    );
    assert(
      observed.every((sql) => !/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql)),
    );

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

Deno.test("validation-only startup requires the additive operation catalog", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry();
  const schema = "copilotz_validation_only_operation_catalog";
  await provisionCopilotzSchema(db, schema);
  try {
    const missing = await assertRejects(() =>
      createCopilotzEngine({
        session: db,
        registry,
        defaultDatabaseSchema: schema,
        provisionDefaultDatabaseSchema: false,
      })
    );
    assertEquals(
      (missing as { code?: unknown }).code,
      "copilotz_operation_catalog_not_provisioned",
    );

    await provisionOperationCatalog(db, schema);
    const engine = await createCopilotzEngine({
      session: db,
      registry,
      defaultDatabaseSchema: schema,
      provisionDefaultDatabaseSchema: false,
    });
    await engine.shutdown();
  } finally {
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
