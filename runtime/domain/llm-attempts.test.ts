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
  type ConversationMessage,
  type ConversationRepository,
  createConversationRepository,
  createLlmAttemptRepository,
  LLM_CONTENT_ROLE,
  llmAttemptContent,
  type LlmAttemptRepository,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_llm_attempts";

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  assets: DatabaseAssetRepository;
  prepare: ContentPreparer;
  conversation: ConversationRepository;
  attempts: LlmAttemptRepository;
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
    id: "llm.lifecycle.observe",
    on: [
      { eventType: "llm_attempt.created" },
      { eventType: "llm_attempt.updated" },
      { eventType: "llm_attempt.completed" },
      { eventType: "llm_attempt.failed" },
      { eventType: "llm_attempt.cancelled" },
    ],
    handle(event) {
      observed.push(event.type);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.llm-attempts",
      version: "1.0.0",
      processors: [processor],
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "llm-attempt-test",
    createContext: (base) => ({ ...base }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let storageId = 0;
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    databaseSchema: TEST_SCHEMA,
    createId: () => "storage-" + ++storageId,
  });
  let domainId = 0;
  const conversation = createConversationRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => "domain-" + ++domainId,
  });
  let attemptId = 0;
  const attempts = createLlmAttemptRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => "attempt-edge-" + ++attemptId,
    now: () => new Date("2026-08-07T13:00:00.000Z"),
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
      createId: () => "content-" + ++contentId,
    }),
    conversation,
    attempts,
    observed,
  });
}

async function closeFixture(fixture: Fixture) {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

async function createConversation(
  fixture: Fixture,
): Promise<ConversationMessage> {
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
  const message = await fixture.conversation.createMessage({
    namespace: "tenant-a",
    id: "message-a",
    threadId: "thread-a",
    sender: {
      id: "human-a",
      externalId: "human-a",
      participantType: "human",
    },
    recipientIds: ["agent-a"],
    content: await fixture.prepare.prepare("Explain the result", {
      namespace: "tenant-a",
      idempotencyKey: "message-a",
    }),
  });
  return message.value!;
}

Deno.test("LLM attempts keep control fields inline and final bodies in synchronized asset refs", async () => {
  const fixture = await createFixture();
  try {
    const source = await createConversation(fixture);
    const created = await fixture.attempts.create({
      namespace: "tenant-a",
      id: "attempt-a",
      threadId: "thread-a",
      messageId: "message-a",
      participantId: "agent-a",
      initiatorParticipantId: "human-a",
      agentId: "support-agent",
      provider: "openai",
      model: "gpt-test",
      inputMessageIds: ["message-a", "message-a"],
      availableToolIds: ["lookup", "lookup"],
      input: source.content,
      toolDefinitions: await fixture.prepare.prepare({
        type: "json",
        value: [{ id: "lookup", schema: { type: "object" } }],
      }, {
        namespace: "tenant-a",
        idempotencyKey: "attempt-a:tools",
      }),
      trace: await fixture.prepare.prepare({
        type: "json",
        value: { requestId: "private-request" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "attempt-a:trace:initial",
      }),
      identity: { correlationId: "run-a", deduplicationId: "attempt-a:create" },
    });
    assertEquals(created.value?.inputMessageIds, ["message-a"]);
    assertEquals(created.value?.availableToolIds, ["lookup"]);
    assertEquals(created.event.payload, {
      llmAttemptId: "attempt-a",
      attemptIndex: 0,
      provider: "openai",
      model: "gpt-test",
    });
    assert(!JSON.stringify(created.event).includes("private-request"));

    const completed = await fixture.attempts.complete({
      namespace: "tenant-a",
      id: "attempt-a",
      answer: await fixture.prepare.prepare("private final answer", {
        namespace: "tenant-a",
        idempotencyKey: "attempt-a:answer",
      }),
      reasoning: await fixture.prepare.prepare("private chain summary", {
        namespace: "tenant-a",
        idempotencyKey: "attempt-a:reasoning",
      }),
      toolCalls: await fixture.prepare.prepare({
        type: "json",
        value: [{ id: "call-a", tool: "lookup", arguments: { q: "x" } }],
      }, {
        namespace: "tenant-a",
        idempotencyKey: "attempt-a:tool-calls",
      }),
      trace: await fixture.prepare.prepare({
        type: "json",
        value: { responseId: "private-response" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "attempt-a:trace:final",
      }),
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { amount: 0.001, currency: "USD" },
      metricsFinalizedAt: "2026-08-07T13:00:01.000Z",
      identity: { correlationId: "run-a" },
    });
    assertEquals(completed.value?.status, "completed");
    assertEquals(completed.event.threadId, "thread-a");
    assertEquals(completed.value?.finishReason, "tool_calls");
    assertEquals(completed.value?.usage, {
      inputTokens: 10,
      outputTokens: 5,
    });
    assertEquals(completed.value?.cost, { amount: 0.001, currency: "USD" });
    assert(!JSON.stringify(completed.event).includes("private final answer"));
    assert(!JSON.stringify(completed.event).includes("private-response"));

    const content = llmAttemptContent(completed.value!);
    assertEquals(content.input[0].assetId, source.content[0].assetId);
    assertEquals(content.answer?.role, LLM_CONTENT_ROLE.answer);
    assertEquals(content.reasoning?.role, LLM_CONTENT_ROLE.reasoning);
    assertEquals(content.toolCalls?.role, LLM_CONTENT_ROLE.toolCalls);
    assertEquals(content.trace?.role, LLM_CONTENT_ROLE.trace);
    const resolver = createContentResolver({ assets: fixture.assets });
    assertEquals(
      (await resolver.get(content.answer!, { namespace: "tenant-a" })).text,
      "private final answer",
    );
    assertEquals(
      (await resolver.get(content.toolCalls!, { namespace: "tenant-a" })).value,
      [{ id: "call-a", tool: "lookup", arguments: { q: "x" } }],
    );

    const attemptRow = await fixture.session.query<{ data: unknown }>(
      "SELECT data FROM " + fixture.store.tables.nodes +
        " WHERE id = 'attempt-a'",
    );
    assert(
      !JSON.stringify(attemptRow.rows[0].data).includes("private final answer"),
    );
    assert(
      !JSON.stringify(attemptRow.rows[0].data).includes("private-response"),
    );

    const oldTraceOwners = await fixture.session.query<
      { count: number | string }
    >(
      "SELECT COUNT(*) AS count FROM " + fixture.store.tables.edges +
        " WHERE source_node_id = 'attempt-a' AND type = 'has_asset'" +
        " AND target_node_id = 'content-3'",
    );
    assertEquals(Number(oldTraceOwners.rows[0].count), 0);

    const promoted = await fixture.conversation.createMessage({
      namespace: "tenant-a",
      id: "answer-message",
      threadId: "thread-a",
      sender: {
        id: "agent-a",
        externalId: "agent-a",
        participantType: "agent",
      },
      recipientIds: ["human-a"],
      content: [{ ...content.answer!, role: "body" }],
      identity: { causationId: completed.event.id, correlationId: "run-a" },
    });
    assertEquals(
      promoted.value?.content[0].assetId,
      content.answer?.assetId,
    );

    await Promise.all([
      ...created.dispatch.handles.map((handle) => handle.done),
      ...completed.dispatch.handles.map((handle) => handle.done),
    ]);
    assertEquals(fixture.observed, [
      "llm_attempt.created",
      "llm_attempt.completed",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("provider fallback attempts remain explicit children with independent lifecycle and metrics", async () => {
  const fixture = await createFixture();
  try {
    const source = await createConversation(fixture);
    await fixture.attempts.create({
      namespace: "tenant-a",
      id: "logical-a",
      threadId: "thread-a",
      participantId: "agent-a",
      initiatorParticipantId: "human-a",
      agentId: "support-agent",
      inputMessageIds: ["message-a"],
      input: source.content,
      identity: { deduplicationId: "logical-a:create" },
    });
    await fixture.attempts.create({
      namespace: "tenant-a",
      id: "provider-a",
      threadId: "thread-a",
      participantId: "agent-a",
      agentId: "support-agent",
      provider: "provider-a",
      model: "model-a",
      attemptIndex: 0,
      parentAttemptId: "logical-a",
      inputMessageIds: ["message-a"],
      identity: { deduplicationId: "provider-a:create" },
    });
    const failed = await fixture.attempts.fail({
      namespace: "tenant-a",
      id: "provider-a",
      safeError: {
        name: "RateLimitError",
        message: "Provider unavailable",
        code: "rate_limit",
        retryable: true,
      },
      errorDetail: await fixture.prepare.prepare({
        type: "json",
        value: { status: 429, raw: "private provider response" },
      }, {
        namespace: "tenant-a",
        idempotencyKey: "provider-a:error",
      }),
      usage: { inputTokens: 8 },
      finishReason: "error",
    });
    assertEquals(failed.value?.status, "failed");
    assertEquals(failed.value?.safeError?.code, "rate_limit");

    const metrics = await fixture.attempts.update({
      namespace: "tenant-a",
      id: "provider-a",
      usage: { inputTokens: 8, cachedTokens: 2 },
      cost: { amount: 0.0002 },
      metricsFinalizedAt: "2026-08-07T13:00:02.000Z",
      metadataPatch: { recoveryAction: "fallback" },
      identity: { deduplicationId: "provider-a:metrics" },
    });
    assertEquals(metrics.value?.status, "failed");
    assertEquals(metrics.value?.usage, { inputTokens: 8, cachedTokens: 2 });

    await fixture.attempts.create({
      namespace: "tenant-a",
      id: "provider-b",
      threadId: "thread-a",
      participantId: "agent-a",
      agentId: "support-agent",
      provider: "provider-b",
      model: "model-b",
      attemptIndex: 1,
      parentAttemptId: "logical-a",
      inputMessageIds: ["message-a"],
      identity: { deduplicationId: "provider-b:create" },
    });
    const accepted = await fixture.attempts.complete({
      namespace: "tenant-a",
      id: "provider-b",
      answer: await fixture.prepare.prepare("fallback answer", {
        namespace: "tenant-a",
        idempotencyKey: "provider-b:answer",
      }),
      finishReason: "stop",
    });
    const answer = llmAttemptContent(accepted.value!).answer!;
    await fixture.attempts.complete({
      namespace: "tenant-a",
      id: "logical-a",
      answer: [{ ...answer, role: "body" }],
      finishReason: "stop",
    });

    assertEquals(
      (await fixture.attempts.list("tenant-a", "thread-a")).map(
        (attempt) => attempt.id,
      ),
      ["logical-a", "provider-a", "provider-b"],
    );
    assertEquals(
      (await fixture.attempts.list("tenant-a", "thread-a", {
        after: "logical-a",
        limit: 1,
      })).map((attempt) => attempt.id),
      ["provider-a"],
    );
    const childEdges = await fixture.session.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      "SELECT source_node_id, target_node_id FROM " +
        fixture.store.tables.edges +
        " WHERE type = 'has_child_attempt' ORDER BY target_node_id",
    );
    assertEquals(childEdges.rows, [{
      source_node_id: "logical-a",
      target_node_id: "provider-a",
    }, {
      source_node_id: "logical-a",
      target_node_id: "provider-b",
    }]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("LLM retries map fresh prepared assets and reject changed completion content", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    const createInput = async (name: string) => ({
      namespace: "tenant-a",
      threadId: "thread-a",
      participantId: "agent-a",
      provider: "provider-a",
      model: "model-a",
      toolDefinitions: await fixture.prepare.prepare({
        type: "json" as const,
        value: [{ name }],
      }, {
        namespace: "tenant-a",
        idempotencyKey: "attempt-replay:tools",
      }),
      identity: { deduplicationId: "attempt-replay:create" },
    });
    const first = await fixture.attempts.create(await createInput("same"));
    await Promise.all(first.dispatch.handles.map((handle) => handle.done));
    const replay = await fixture.attempts.create(await createInput("same"));
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.value?.id, first.value?.id);
    assertEquals(replay.dispatch.handles, []);
    const changedCreate = await createInput("changed");
    await assertRejects(() => fixture.attempts.create(changedCreate));

    const completionInput = async (answer: string) => ({
      namespace: "tenant-a",
      id: first.value!.id,
      answer: await fixture.prepare.prepare(answer, {
        namespace: "tenant-a",
        idempotencyKey: "attempt-replay:answer",
      }),
    });
    const completed = await fixture.attempts.complete(
      await completionInput("same answer"),
    );
    await Promise.all(completed.dispatch.handles.map((handle) => handle.done));
    const completedReplay = await fixture.attempts.complete(
      await completionInput("same answer"),
    );
    assertEquals(completedReplay.deduplicated, true);
    const changedCompletion = await completionInput("changed answer");
    await assertRejects(() => fixture.attempts.complete(changedCompletion));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("LLM aggregate rollback, supersession, and tenant boundaries fail closed", async () => {
  const fixture = await createFixture();
  try {
    await createConversation(fixture);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const trace = await fixture.prepare.prepare({
      type: "json",
      value: { request: "rollback" },
    }, {
      namespace: "tenant-a",
      idempotencyKey: "attempt-rollback:trace",
    });
    const traceId = trace.assets[0].id;
    await assertRejects(() =>
      fixture.attempts.create({
        namespace: "tenant-a",
        id: "attempt-rollback",
        threadId: "thread-a",
        participantId: "agent-a",
        trace,
        metadata: circular,
      })
    );
    assertEquals(await fixture.assets.get("tenant-a", traceId), null);
    assertEquals(
      await fixture.attempts.get("tenant-a", "attempt-rollback"),
      null,
    );

    await assertRejects(() =>
      fixture.attempts.create({
        namespace: "tenant-a",
        id: "attempt-missing-parent",
        threadId: "thread-a",
        parentAttemptId: "missing",
      })
    );

    await fixture.attempts.create({
      namespace: "tenant-a",
      id: "attempt-superseded",
      threadId: "thread-a",
      participantId: "agent-a",
    });
    const superseded = await fixture.attempts.update({
      namespace: "tenant-a",
      id: "attempt-superseded",
      status: "superseded",
      metadataPatch: { reason: "newer human input" },
    });
    assertEquals(superseded.value?.status, "superseded");
    assertExists(superseded.value?.finishedAt);
    await assertRejects(() =>
      fixture.attempts.complete({
        namespace: "tenant-a",
        id: "attempt-superseded",
      })
    );
    assertEquals(
      await fixture.attempts.get("tenant-b", "attempt-superseded"),
      null,
    );

    await fixture.attempts.create({
      namespace: "tenant-a",
      id: "attempt-cancelled",
      threadId: "thread-a",
      participantId: "agent-a",
    });
    const cancelled = await fixture.attempts.cancel({
      namespace: "tenant-a",
      id: "attempt-cancelled",
      reason: "caller disconnected",
      metadataPatch: { interrupted: true },
    });
    assertEquals(cancelled.value?.status, "cancelled");
    assertEquals(cancelled.value?.safeError?.code, "cancelled");
    assertEquals(cancelled.value?.safeError?.message, "caller disconnected");
    assertExists(cancelled.value?.finishedAt);
    const replay = await fixture.attempts.cancel({
      namespace: "tenant-a",
      id: "attempt-cancelled",
      reason: "caller disconnected",
      metadataPatch: { interrupted: true },
    });
    assertEquals(replay.deduplicated, true);
    await assertRejects(() =>
      fixture.attempts.complete({
        namespace: "tenant-a",
        id: "attempt-cancelled",
      })
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 LLM attempt core is factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "llm-attempts.ts",
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
