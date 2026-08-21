import {
  createTestDatabase,
  type TestDatabase,
} from "../../../runtime/testing/ominipg.ts";
import {
  type ContentPreparer,
  createContentPreparer,
  createDatabaseAssetRepository,
  type DatabaseAssetRepository,
} from "../../../runtime/content/index.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  type SqlSession,
} from "../../../runtime/events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../../../runtime/execution/index.ts";
import { createPluginRegistry } from "../../../runtime/plugins/index.ts";
import {
  type ConversationRepository,
  createConversationRepository,
  createLlmAttemptRepository,
  createToolExecutionRepository,
  type LlmAttemptRepository,
  type ToolExecutionRepository,
} from "../../../runtime/domain/index.ts";

export const PHASE_0_NAMESPACE = "phase-0";
export const PHASE_0_SCHEMA = "copilotz_phase0";
export const PHASE_0_NOW = "2026-08-17T20:00:00.000Z";

export type Phase0ConversationSnapshot = Readonly<{
  eventTypes: readonly string[];
  nodeCounts: Readonly<Record<string, number>>;
  participantExternalIds: readonly string[];
  threadExternalId: string;
  activeMessageIds: readonly string[];
  allMessageIds: readonly string[];
  revisionIds: readonly string[];
  lastEventType: string;
  lastEventId: string | undefined;
}>;

export type Phase0ConversationFixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  assets: DatabaseAssetRepository;
  prepare: ContentPreparer;
  conversation: ConversationRepository;
  attempts: LlmAttemptRepository;
  tools: ToolExecutionRepository;
}>;

export type CreatePhase0ConversationFixtureOptions = Readonly<{
  url?: string;
}>;

export async function createPhase0ConversationFixture(
  options: CreatePhase0ConversationFixtureOptions = {},
): Promise<Phase0ConversationFixture> {
  const db = await createTestDatabase({ url: options.url ?? ":memory:" });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(PHASE_0_SCHEMA)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema: PHASE_0_SCHEMA });
  const registry = await createPluginRegistry({ plugins: [] });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "phase-0-fixture",
    createContext: (base) => ({ ...base }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const createId = () => `phase0-${++nextId}`;
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    databaseSchema: PHASE_0_SCHEMA,
    createId,
  });
  const conversation = createConversationRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId,
  });
  const attempts = createLlmAttemptRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId,
    now: () => new Date(PHASE_0_NOW),
  });
  const tools = createToolExecutionRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId,
    now: () => new Date(PHASE_0_NOW),
  });
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    assets,
    prepare: createContentPreparer({ createId }),
    conversation,
    attempts,
    tools,
  });
}

export async function closePhase0ConversationFixture(
  fixture: Phase0ConversationFixture,
): Promise<void> {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

export async function seedPhase0Conversation(
  fixture: Phase0ConversationFixture,
): Promise<void> {
  const human = {
    id: "human-alice",
    externalId: "alice",
    participantType: "human" as const,
    name: "Alice",
  };
  const agent = {
    id: "agent-support",
    externalId: "support",
    participantType: "agent" as const,
    agentId: "support-agent",
    name: "Support",
  };
  const peer = {
    id: "agent-research",
    externalId: "research",
    participantType: "agent" as const,
    agentId: "research-agent",
    name: "Research",
  };

  await fixture.conversation.createParticipant({
    namespace: PHASE_0_NAMESPACE,
    participant: human,
    identity: { deduplicationId: "phase0:participant:alice" },
  });
  await fixture.conversation.createParticipant({
    namespace: PHASE_0_NAMESPACE,
    participant: agent,
    identity: { deduplicationId: "phase0:participant:support" },
  });
  await fixture.conversation.createParticipant({
    namespace: PHASE_0_NAMESPACE,
    participant: peer,
    identity: { deduplicationId: "phase0:participant:research" },
  });
  await fixture.conversation.createThread({
    namespace: PHASE_0_NAMESPACE,
    id: "thread-support",
    externalId: "customer-thread-42",
    name: "Support",
    participants: [human, agent, peer],
    identity: { deduplicationId: "phase0:thread:support" },
  });

  const userMessage = await fixture.conversation.createMessage({
    namespace: PHASE_0_NAMESPACE,
    id: "message-user",
    threadId: "thread-support",
    sender: human,
    recipientIds: [agent.id],
    content: await fixture.prepare.prepare("What is the status?", {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:message:user",
    }),
    identity: {
      correlationId: "phase0-run",
      deduplicationId: "phase0:message:user",
    },
  });

  await fixture.attempts.create({
    namespace: PHASE_0_NAMESPACE,
    id: "attempt-1",
    threadId: "thread-support",
    messageId: userMessage.value!.id,
    participantId: agent.id,
    initiatorParticipantId: human.id,
    agentId: "support-agent",
    provider: "test",
    model: "phase-0",
    inputMessageIds: [userMessage.value!.id],
    availableToolIds: ["lookup"],
    identity: {
      correlationId: "phase0-run",
      deduplicationId: "phase0:attempt:1",
    },
  });
  await fixture.attempts.complete({
    namespace: PHASE_0_NAMESPACE,
    id: "attempt-1",
    answer: await fixture.prepare.prepare("I will look that up.", {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:attempt:1:answer",
    }),
    finishReason: "tool_calls",
    identity: { correlationId: "phase0-run" },
  });

  const agentMessage = await fixture.conversation.createMessage({
    namespace: PHASE_0_NAMESPACE,
    id: "message-agent",
    threadId: "thread-support",
    sender: agent,
    recipientIds: [human.id],
    content: await fixture.prepare.prepare("Looking up the ticket.", {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:message:agent",
    }),
    metadata: {
      copilotzWorkflow: { kind: "agent_output", llmAttemptId: "attempt-1" },
    },
    identity: {
      correlationId: "phase0-run",
      deduplicationId: "phase0:message:agent",
    },
  });

  await fixture.tools.create({
    namespace: PHASE_0_NAMESPACE,
    id: "execution-1",
    threadId: "thread-support",
    messageId: agentMessage.value!.id,
    participantId: agent.id,
    agentId: "support-agent",
    toolCallId: "call-1",
    tool: { id: "lookup", name: "Lookup" },
    arguments: await fixture.prepare.prepare({
      type: "json",
      value: { ticket: 42 },
    }, {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:execution:1:arguments",
    }),
    identity: {
      correlationId: "phase0-run",
      deduplicationId: "phase0:execution:1",
    },
  });
  await fixture.tools.complete({
    namespace: PHASE_0_NAMESPACE,
    id: "execution-1",
    output: await fixture.prepare.prepare({
      type: "json",
      value: { status: "open" },
    }, {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:execution:1:output",
    }),
    identity: { correlationId: "phase0-run" },
  });

  await fixture.conversation.createMessage({
    namespace: PHASE_0_NAMESPACE,
    id: "message-tool",
    threadId: "thread-support",
    sender: agent,
    recipientIds: [human.id],
    content: await fixture.prepare.prepare({
      type: "json",
      role: "tool.output",
      value: { status: "open" },
    }, {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:message:tool",
    }),
    metadata: {
      copilotzWorkflow: {
        kind: "tool_result",
        toolExecutionId: "execution-1",
        llmAttemptId: "attempt-1",
      },
    },
    identity: {
      correlationId: "phase0-run",
      deduplicationId: "phase0:message:tool",
    },
  });

  await fixture.conversation.reviseMessage({
    namespace: PHASE_0_NAMESPACE,
    id: "message-user-revised",
    threadId: "thread-support",
    messageId: "message-user",
    content: await fixture.prepare.prepare("What is the status of ticket 42?", {
      namespace: PHASE_0_NAMESPACE,
      idempotencyKey: "phase0:message:user-revised",
    }),
    identity: {
      correlationId: "phase0-run",
      deduplicationId: "phase0:message:user-revised",
    },
  });
}

export async function snapshotPhase0Conversation(
  fixture: Phase0ConversationFixture,
): Promise<Phase0ConversationSnapshot> {
  const events = await fixture.store.listEvents({
    namespace: PHASE_0_NAMESPACE,
    limit: 1_000,
  });
  const nodes = await fixture.session.query<{
    type: string;
    count: number | string;
  }>(
    `SELECT type, COUNT(*) AS count FROM ${fixture.store.tables.nodes}
     WHERE namespace = $1
     GROUP BY type ORDER BY type`,
    [PHASE_0_NAMESPACE],
  );
  const nodeCounts: Record<string, number> = {};
  for (const row of nodes.rows) {
    nodeCounts[row.type] = Number(row.count);
  }
  const participants = await fixture.conversation.listParticipants(
    PHASE_0_NAMESPACE,
  );
  const thread = await fixture.conversation.getThreadByExternalId(
    PHASE_0_NAMESPACE,
    "customer-thread-42",
  );
  const active = await fixture.conversation.listMessages(
    PHASE_0_NAMESPACE,
    "thread-support",
    { view: "active", order: "asc", limit: 100 },
  );
  const all = await fixture.conversation.listMessages(
    PHASE_0_NAMESPACE,
    "thread-support",
    { view: "all", order: "asc", limit: 100 },
  );
  const revisions = await fixture.conversation.listMessageRevisions(
    PHASE_0_NAMESPACE,
    "message-user",
  );
  const last = events.at(-1);
  return Object.freeze({
    eventTypes: Object.freeze(events.map((event) => event.type)),
    nodeCounts: Object.freeze(nodeCounts),
    participantExternalIds: Object.freeze(
      participants.map((participant) => participant.externalId).sort(),
    ),
    threadExternalId: thread?.externalId ?? "",
    activeMessageIds: Object.freeze(active.map((message) => message.id)),
    allMessageIds: Object.freeze(all.map((message) => message.id)),
    revisionIds: Object.freeze(revisions.map((message) => message.id)),
    lastEventType: last?.type ?? "",
    lastEventId: thread?.lastEventId,
  });
}
