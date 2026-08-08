import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  type ContentPreparer,
  createContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
  type DatabaseAssetRepository,
} from "../content/index.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  type SqlSession,
} from "../events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import {
  type ConversationRepository,
  createConversationRepository,
  createToolExecutionRepository,
  TOOL_CONTENT_ROLE,
  toolExecutionContent,
  type ToolExecutionRepository,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_tool_executions";

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  assets: DatabaseAssetRepository;
  prepare: ContentPreparer;
  conversation: ConversationRepository;
  tools: ToolExecutionRepository;
  observed: string[];
}>;

async function createFixture(): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema: TEST_SCHEMA });
  const observed: string[] = [];
  const processor = defineProcessor({
    id: "tool.lifecycle.observe",
    on: [
      "tool_execution.created",
      "tool_execution.updated",
      "tool_execution.completed",
      "tool_execution.failed",
      "tool_execution.cancelled",
    ],
    delivery: "durable",
    handle(event) {
      observed.push(event.type);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.tool-executions",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "tool-execution-test",
    createContext: (base) => ({ ...base }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let storageId = 0;
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    createId: () => `storage-${++storageId}`,
  });
  let domainId = 0;
  const conversation = createConversationRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `domain-${++domainId}`,
  });
  let workflowId = 0;
  const tools = createToolExecutionRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `workflow-${++workflowId}`,
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });
  let contentId = 0;
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    assets,
    prepare: createContentPreparer({
      createId: () => `content-${++contentId}`,
    }),
    conversation,
    tools,
    observed,
  });
}

async function closeFixture(fixture: Fixture) {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

async function createConversation(fixture: Fixture) {
  await fixture.conversation.createThread({
    namespace: "tenant-a",
    id: "thread-a",
    participants: [{
      id: "agent-a",
      externalId: "agent-a",
      participantType: "agent",
    }, {
      id: "human-a",
      externalId: "human-a",
      participantType: "human",
    }],
  });
  return await fixture.conversation.createMessage({
    namespace: "tenant-a",
    id: "message-a",
    threadId: "thread-a",
    sender: {
      id: "human-a",
      externalId: "human-a",
      participantType: "human",
    },
    recipientIds: ["agent-a"],
    content: await fixture.prepare.prepare("Run lookup", {
      namespace: "tenant-a",
      idempotencyKey: "message-a",
    }),
  });
}

Deno.test("tool lifecycle stores role-labelled assets and compact independently delivered events", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    const created = await fixture.tools.create({
      namespace: "tenant-a",
      id: "execution-a",
      threadId: "thread-a",
      messageId: "message-a",
      participantId: "agent-a",
      agentId: "support-agent",
      toolCallId: "call-a",
      tool: { id: "lookup", name: "Lookup" },
      arguments: await fixture.prepare.prepare({
        type: "json",
        value: { query: "private query body" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "execution-a:arguments",
      }),
      identity: { correlationId: "run-a" },
    });
    assertEquals(created.value?.status, "running");
    assertEquals(created.event.payload, {
      toolExecutionId: "execution-a",
      toolCallId: "call-a",
      toolId: "lookup",
    });
    assert(!JSON.stringify(created.event).includes("private query body"));

    const completed = await fixture.tools.complete({
      namespace: "tenant-a",
      id: "execution-a",
      output: await fixture.prepare.prepare({
        type: "json",
        value: { ok: true, result: "private result body" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "execution-a:output",
      }),
      projectedOutput: await fixture.prepare.prepare({
        type: "json",
        value: { ok: true, summary: "available" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "execution-a:projected",
      }),
      attachments: await fixture.prepare.prepare({
        type: "file",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "application/octet-stream",
        name: "result.bin",
      }, {
        namespace: "tenant-a",
        idempotencyKey: "execution-a:attachment",
      }),
      historyVisibility: "requester_only",
      durationMs: 42,
      identity: { correlationId: "run-a" },
    });
    assertEquals(completed.value?.status, "completed");
    assertEquals(completed.event.threadId, "thread-a");
    assertEquals(completed.event.delta, {
      fields: [
        "content",
        "durationMs",
        "finishedAt",
        "historyVisibility",
        "status",
      ],
      status: "completed",
    });
    assert(!JSON.stringify(completed.event).includes("private result body"));

    const execution = await fixture.tools.get("tenant-a", "execution-a");
    assertExists(execution);
    const content = toolExecutionContent(execution);
    assertEquals(content.arguments.role, TOOL_CONTENT_ROLE.arguments);
    assertEquals(content.output?.role, TOOL_CONTENT_ROLE.output);
    assertEquals(
      content.projectedOutput?.role,
      TOOL_CONTENT_ROLE.projectedOutput,
    );
    assertEquals(content.attachments.length, 1);
    assertEquals(execution.historyVisibility, "requester_only");
    assertEquals(execution.durationMs, 42);

    const resolver = createContentResolver({ assets: fixture.assets });
    assertEquals(
      (await resolver.get(content.arguments, { namespace: "tenant-a" })).value,
      { query: "private query body" },
    );
    assertEquals(
      (await resolver.get(content.output!, { namespace: "tenant-a" })).value,
      { ok: true, result: "private result body" },
    );

    const persisted = await fixture.session.query<{ data: unknown }>(
      `SELECT data FROM ${fixture.store.tables.nodes} WHERE id = 'execution-a'`,
    );
    assert(
      !JSON.stringify(persisted.rows[0].data).includes("private query body"),
    );
    assert(
      !JSON.stringify(persisted.rows[0].data).includes("private result body"),
    );
    assertEquals(
      execution.content.map((ref) => ref.assetId),
      ["content-2", "content-3", "content-4", "content-5"],
    );

    await Promise.all([
      ...created.dispatch.handles.map((handle) => handle.done),
      ...completed.dispatch.handles.map((handle) => handle.done),
    ]);
    assertEquals(fixture.observed, [
      "tool_execution.created",
      "tool_execution.completed",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("tool output can become a public tool message without copying its body", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    await fixture.tools.create({
      namespace: "tenant-a",
      id: "execution-a",
      threadId: "thread-a",
      messageId: "message-a",
      participantId: "agent-a",
      toolCallId: "call-a",
      tool: { id: "lookup", name: "Lookup" },
      arguments: await fixture.prepare.prepare({
        type: "json",
        value: { query: "x" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "reuse:args",
      }),
    });
    const completed = await fixture.tools.complete({
      namespace: "tenant-a",
      id: "execution-a",
      output: await fixture.prepare.prepare("shared result", {
        namespace: "tenant-a",
        idempotencyKey: "reuse:output",
      }),
    });
    const output = toolExecutionContent(completed.value!).output!;
    await fixture.conversation.createParticipant({
      namespace: "tenant-a",
      participant: {
        id: "tool-lookup",
        externalId: "tool:lookup",
        participantType: "tool",
        name: "Lookup",
      },
    });
    const message = await fixture.conversation.createMessage({
      namespace: "tenant-a",
      id: "tool-message-a",
      threadId: "thread-a",
      sender: {
        id: "tool-lookup",
        externalId: "tool:lookup",
        participantType: "tool",
      },
      recipientIds: ["agent-a"],
      content: [{ ...output, role: "body" }],
      identity: { causationId: completed.event.id },
    });
    assertEquals(message.value?.content[0].assetId, output.assetId);

    const assetCount = await fixture.session.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.nodes}
       WHERE namespace = 'tenant-a' AND type = 'asset'`,
    );
    assertEquals(Number(assetCount.rows[0].count), 3);
    const owners = await fixture.session.query<{
      source_node_id: string;
    }>(
      `SELECT source_node_id FROM ${fixture.store.tables.edges}
       WHERE namespace = 'tenant-a' AND type = 'has_asset'
         AND target_node_id = $1 ORDER BY source_node_id`,
      [output.assetId],
    );
    assertEquals(owners.rows.map((row) => row.source_node_id), [
      "execution-a",
      "tool-message-a",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("tool failures keep safe control data inline and diagnostic detail restricted", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    await fixture.tools.create({
      namespace: "tenant-a",
      id: "execution-failed",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-failed",
      tool: { id: "lookup", name: "Lookup" },
      arguments: await fixture.prepare.prepare({
        type: "json",
        value: { query: "failure" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "failed:args",
      }),
    });
    const failure = await fixture.tools.fail({
      namespace: "tenant-a",
      id: "execution-failed",
      safeError: {
        name: "LookupError",
        message: "Lookup failed safely",
        code: "LOOKUP_FAILED",
        retryable: true,
      },
      errorDetail: await fixture.prepare.prepare("private stack and response", {
        namespace: "tenant-a",
        idempotencyKey: "failed:detail",
      }),
      projectedOutput: await fixture.prepare.prepare({
        type: "json",
        value: { ok: false, message: "Lookup failed safely" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "failed:projection",
      }),
      historyVisibility: "public_status",
      visibility: {
        kind: "tool",
        policy: "public_status",
        requesterId: "agent-a",
      },
    });
    assertEquals(failure.value?.status, "failed");
    assertEquals(failure.value?.safeError, {
      name: "LookupError",
      message: "Lookup failed safely",
      code: "LOOKUP_FAILED",
      retryable: true,
    });
    assertEquals(failure.event.visibility, {
      kind: "tool",
      policy: "public_status",
      requesterId: "agent-a",
    });
    assert(!JSON.stringify(failure.event).includes("private stack"));
    assertEquals(
      toolExecutionContent(failure.value!).errorDetail?.role,
      TOOL_CONTENT_ROLE.errorDetail,
    );

    await assertRejects(() =>
      fixture.tools.complete({
        namespace: "tenant-a",
        id: "execution-failed",
      })
    );
    assertEquals(
      (await fixture.tools.get("tenant-a", "execution-failed"))?.status,
      "failed",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("tool retries resolve freshly prepared bodies and reject changed idempotent content", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    const createInput = async (query: string) => ({
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      toolCallId: "call-replay",
      tool: { id: "lookup", name: "Lookup" },
      arguments: await fixture.prepare.prepare({
        type: "json" as const,
        value: { query },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "replay:args",
      }),
    });
    const first = await fixture.tools.create(await createInput("same"));
    await Promise.all(first.dispatch.handles.map((handle) => handle.done));
    const replay = await fixture.tools.create(await createInput("same"));
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.value?.id, first.value?.id);
    assertEquals(replay.value?.content, first.value?.content);
    assertEquals(replay.dispatch.handles, []);

    const changedCreate = await createInput("changed");
    await assertRejects(() => fixture.tools.create(changedCreate));

    const completeInput = async (result: string) => ({
      namespace: "tenant-a",
      id: first.value!.id,
      output: await fixture.prepare.prepare(result, {
        namespace: "tenant-a",
        idempotencyKey: "replay:output",
      }),
    });
    const completed = await fixture.tools.complete(
      await completeInput("same output"),
    );
    await Promise.all(completed.dispatch.handles.map((handle) => handle.done));
    const completedReplay = await fixture.tools.complete(
      await completeInput("same output"),
    );
    assertEquals(completedReplay.deduplicated, true);
    const changedCompletion = await completeInput("changed output");
    await assertRejects(() => fixture.tools.complete(changedCompletion));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("tool aggregate rollback, tenant scope, and event-position cursors remain deterministic", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const prepared = await fixture.prepare.prepare({
      type: "json",
      value: { query: "rollback" },
    }, {
      namespace: "tenant-a",
      idempotencyKey: "rollback:args",
    });
    const preparedAssetId = prepared.assets[0].id;
    await assertRejects(() =>
      fixture.tools.create({
        namespace: "tenant-a",
        id: "execution-rollback",
        threadId: "thread-a",
        toolCallId: "call-rollback",
        tool: { id: "lookup" },
        arguments: prepared,
        metadata: circular,
      })
    );
    assertEquals(await fixture.assets.get("tenant-a", preparedAssetId), null);
    assertEquals(
      await fixture.tools.get("tenant-a", "execution-rollback"),
      null,
    );

    const create = async (id: string, call: string, key: string) =>
      await fixture.tools.create({
        namespace: "tenant-a",
        id,
        threadId: "thread-a",
        toolCallId: call,
        tool: { id: "lookup" },
        arguments: await fixture.prepare.prepare({
          type: "json",
          value: { call },
        }, { namespace: "tenant-a", idempotencyKey: key }),
      });
    await create("execution-1", "call-1", "list:1");
    await create("execution-2", "call-2", "list:2");
    await create("execution-3", "call-3", "list:3");
    assertEquals(
      (await fixture.tools.list("tenant-a", "thread-a")).map((item) => item.id),
      ["execution-1", "execution-2", "execution-3"],
    );
    assertEquals(
      (await fixture.tools.list("tenant-a", "thread-a", {
        after: "execution-1",
        limit: 1,
      })).map((item) => item.id),
      ["execution-2"],
    );
    assertEquals(
      (await fixture.tools.getByToolCallId(
        "tenant-a",
        "thread-a",
        "call-2",
      ))?.id,
      "execution-2",
    );
    assertEquals(await fixture.tools.get("tenant-b", "execution-2"), null);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 tool execution core is factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "tool-executions.ts",
      "workflow-content.ts",
      "workflow-support.ts",
      "workflow-types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
    assert(
      !/producedEvents|unsafeGraph|queueId|runGeneration/.test(source),
      module,
    );
  }
});
