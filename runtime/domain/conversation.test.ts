import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  type ContentPreparer,
  createContentPreparer,
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
} from "./index.ts";

const TEST_SCHEMA = "copilotz_conversation_native";

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  assets: DatabaseAssetRepository;
  conversation: ConversationRepository;
  prepare: ContentPreparer;
  handled: ConversationMessage[];
}>;

async function createFixture(): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema: TEST_SCHEMA });
  const handled: ConversationMessage[] = [];
  let conversation!: ConversationRepository;
  const processor = defineProcessor({
    id: "conversation.message.observe",
    on: ["message.created", "message.revised"],
    delivery: "durable",
    async handle(event, context) {
      assert(event.durable);
      assertEquals(
        context.idempotencyKey,
        (context.delivery as { id: string }).id,
      );
      const message = await conversation.getMessage(
        event.namespace,
        event.subject!.id,
      );
      assertExists(message);
      handled.push(message);
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.conversation",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "conversation-test",
    createContext: (base) => ({ ...base }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextAssetId = 0;
  let nextAssetEdgeId = 0;
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    createId: () => `asset-edge-${++nextAssetEdgeId}`,
  });
  let nextDomainId = 0;
  conversation = createConversationRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `domain-${++nextDomainId}`,
  });
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    assets,
    conversation,
    prepare: createContentPreparer({
      createId: () => `asset-${++nextAssetId}`,
    }),
    handled,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

Deno.test("graph-native conversation commits domain graph, semantic event, and delivery atomically", async () => {
  const fixture = await createFixture();
  try {
    const agent = await fixture.conversation.createParticipant({
      namespace: "tenant-a",
      participant: {
        id: "agent-support",
        externalId: "support",
        participantType: "agent",
        name: "Support",
      },
      identity: { deduplicationId: "participant:support" },
    });
    assertEquals(agent.value?.id, "agent-support");

    const thread = await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a",
      externalId: "customer-thread-42",
      name: "Customer support",
      description: "Visible thread metadata",
      participants: [{
        id: "human-alice",
        externalId: "alice",
        participantType: "human",
        name: "Alice",
      }, {
        id: "agent-support",
        externalId: "support",
        participantType: "agent",
      }],
      identity: { deduplicationId: "thread:42" },
    });
    assertEquals(thread.value?.participants.length, 2);
    assertEquals(thread.value?.name, "Customer support");
    assertEquals(thread.value?.description, "Visible thread metadata");

    const content = await fixture.prepare.prepare([
      "Hello from an asset",
      {
        type: "json",
        role: "tool.output",
        value: { ticket: 42 },
      },
    ], {
      namespace: "tenant-a",
      idempotencyKey: "message-a",
    });
    const created = await fixture.conversation.createMessage({
      namespace: "tenant-a",
      id: "message-a",
      threadId: "thread-a",
      sender: {
        id: "human-alice",
        externalId: "alice",
        participantType: "human",
      },
      recipientIds: ["agent-support", "agent-support"],
      content,
      identity: {
        correlationId: "run-a",
        deduplicationId: "message:inbound:a",
      },
    });
    assertEquals(created.event.type, "message.created");
    assertEquals(created.event.payload, { messageId: "message-a" });
    assertEquals(created.event.routing, {
      senderId: "human-alice",
      recipientIds: ["agent-support"],
    });
    assertEquals(created.deliveries.length, 1);
    assertEquals(created.dispatch.handles.length, 1);
    assertEquals(
      (await created.dispatch.handles[0].done).delivery.status,
      "succeeded",
    );
    assertEquals(fixture.handled.map((message) => message.id), ["message-a"]);

    const message = await fixture.conversation.getMessage(
      "tenant-a",
      "message-a",
    );
    assertExists(message);
    assertEquals(message.content, content.content);
    assertEquals(message.recipientIds, ["agent-support"]);
    assert(Object.isFrozen(message));
    assert(Object.isFrozen(message.content));

    const graph = await fixture.session.query<{
      type: string;
      count: number | string;
    }>(
      `SELECT type, COUNT(*) AS count FROM ${fixture.store.tables.nodes}
       GROUP BY type ORDER BY type`,
    );
    assertEquals(graph.rows, [
      { type: "asset", count: 2 },
      { type: "message", count: 1 },
      { type: "participant", count: 2 },
      { type: "thread", count: 1 },
    ]);
    const edges = await fixture.session.query<{
      source_node_id: string;
      target_node_id: string;
      type: string;
    }>(
      `SELECT source_node_id, target_node_id, type
       FROM ${fixture.store.tables.edges}
       ORDER BY type, source_node_id, target_node_id`,
    );
    assertEquals(edges.rows, [
      {
        source_node_id: "message-a",
        target_node_id: "asset-1",
        type: "has_asset",
      },
      {
        source_node_id: "message-a",
        target_node_id: "asset-2",
        type: "has_asset",
      },
      {
        source_node_id: "thread-a",
        target_node_id: "message-a",
        type: "has_message",
      },
      {
        source_node_id: "agent-support",
        target_node_id: "thread-a",
        type: "participates_in",
      },
      {
        source_node_id: "human-alice",
        target_node_id: "thread-a",
        type: "participates_in",
      },
      {
        source_node_id: "human-alice",
        target_node_id: "message-a",
        type: "sent_by",
      },
    ]);

    const persisted = await fixture.session.query<{
      content: string | null;
      data: unknown;
    }>(
      `SELECT content, data FROM ${fixture.store.tables.nodes}
       WHERE id = 'message-a'`,
    );
    assertEquals(persisted.rows[0].content, null);
    assert(
      !JSON.stringify(persisted.rows[0].data).includes("Hello from an asset"),
    );
    assert(!JSON.stringify(created.event).includes("Hello from an asset"));
    assert(JSON.stringify(persisted.rows[0].data).includes("asset-1"));
    assertEquals(
      new TextDecoder().decode(
        (await fixture.assets.read("tenant-a", "asset-1")).bytes,
      ),
      "Hello from an asset",
    );

    const loadedThread = await fixture.conversation.getThreadByExternalId(
      "tenant-a",
      "customer-thread-42",
    );
    assertExists(loadedThread);
    assertEquals(loadedThread.id, "thread-a");
    assertEquals(loadedThread.lastEventId, created.event.id);
    assertEquals(loadedThread.lastEventPosition, created.event.position);
    assertEquals(
      loadedThread.participants.map((participant) => participant.id).sort(),
      ["agent-support", "human-alice"],
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("participant and activity-ordered thread queries remain tenant scoped and cursor based", async () => {
  const fixture = await createFixture();
  try {
    const human = {
      id: "human-a",
      externalId: "human-a",
      participantType: "human" as const,
    };
    const agent = {
      id: "agent-a",
      externalId: "agent-a",
      participantType: "agent" as const,
      agentId: "agent-a",
    };
    for (const id of ["thread-a", "thread-b"]) {
      await fixture.conversation.createThread({
        namespace: "tenant-a",
        id,
        participants: [human, agent],
      });
    }
    await fixture.conversation.createThread({
      namespace: "tenant-b",
      id: "other-thread",
      participants: [{ ...human, id: "other-human" }],
    });
    await fixture.conversation.createMessage({
      namespace: "tenant-a",
      id: "message-a",
      threadId: "thread-a",
      sender: human,
      recipientIds: [agent.id],
      content: [],
    });
    await fixture.conversation.createMessage({
      namespace: "tenant-a",
      id: "message-b",
      threadId: "thread-b",
      sender: human,
      recipientIds: [agent.id],
      content: [],
    });

    assertEquals(
      (await fixture.conversation.listThreads("tenant-a", {
        participantId: human.id,
      })).map((thread) => thread.id),
      ["thread-b", "thread-a"],
    );
    assertEquals(
      (await fixture.conversation.listThreads("tenant-a", {
        participantId: human.id,
        after: "thread-b",
        limit: 1,
      })).map((thread) => thread.id),
      ["thread-a"],
    );
    await fixture.conversation.updateThread({
      namespace: "tenant-a",
      id: "thread-a",
      patch: { status: "archived" },
    });
    assertEquals(
      (await fixture.conversation.listThreads("tenant-a", {
        status: "archived",
      })).map((thread) => thread.id),
      ["thread-a"],
    );
    assertEquals(
      (await fixture.conversation.listThreads("tenant-a", {
        status: "active",
      })).map((thread) => thread.id),
      ["thread-b"],
    );
    assertEquals(
      (await fixture.conversation.listParticipants("tenant-a", {
        participantType: "human",
      })).map((participant) => participant.id),
      ["human-a"],
    );
    assertEquals(
      (await fixture.conversation.listThreads("tenant-b")).map((thread) =>
        thread.id
      ),
      ["other-thread"],
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("thread participation is an atomic typed mutation and retry-safe", async () => {
  const fixture = await createFixture();
  try {
    await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-participation",
      participants: [{
        id: "user-participation",
        externalId: "user-participation",
        participantType: "human",
      }],
    });
    const input = {
      namespace: "tenant-a",
      threadId: "thread-participation",
      participant: {
        id: "agent-participation",
        externalId: "agent-participation",
        participantType: "agent" as const,
        agentId: "support",
      },
      identity: { deduplicationId: "thread-participation:add-agent" },
    };
    const added = await fixture.conversation.addThreadParticipant(input);
    assertEquals(added.event.type, "thread.participant_added");
    assertEquals(added.value?.participants.map((value) => value.id).sort(), [
      "agent-participation",
      "user-participation",
    ]);
    const repeated = await fixture.conversation.addThreadParticipant(input);
    assertEquals(repeated.deduplicated, true);
    assertEquals(repeated.event.id, added.event.id);

    const edges = await fixture.session.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.edges}
       WHERE namespace = $1 AND source_node_id = $2
         AND target_node_id = $3 AND type = 'participates_in'`,
      ["tenant-a", "agent-participation", "thread-participation"],
    );
    assertEquals(Number(edges.rows[0].count), 1);

    await assertRejects(
      () =>
        fixture.conversation.addThreadParticipant({
          namespace: "tenant-b",
          threadId: "thread-participation",
          participant: {
            externalId: "tenant-b-agent",
            participantType: "agent",
          },
        }),
      Error,
      "was not found",
    );
    assertEquals(
      await fixture.conversation.getParticipantByExternalId(
        "tenant-b",
        "tenant-b-agent",
      ),
      null,
    );
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-b" })).length,
      0,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("human message revisions preserve immutable branches and project active history", async () => {
  const fixture = await createFixture();
  try {
    const human = {
      id: "revision-human",
      externalId: "revision-human",
      participantType: "human" as const,
    };
    const agent = {
      id: "revision-agent",
      externalId: "revision-agent",
      participantType: "agent" as const,
      agentId: "revision-agent",
    };
    await fixture.conversation.createThread({
      namespace: "tenant-revision",
      id: "revision-thread",
      participants: [human, agent],
    });
    const originalContent = await fixture.prepare.prepare("Original question", {
      namespace: "tenant-revision",
      idempotencyKey: "revision-original-content",
    });
    await fixture.conversation.createMessage({
      namespace: "tenant-revision",
      id: "revision-original",
      threadId: "revision-thread",
      sender: human,
      recipientIds: [agent.id],
      content: originalContent,
      metadata: { source: "original" },
    });
    await fixture.conversation.createMessage({
      namespace: "tenant-revision",
      id: "revision-old-answer",
      threadId: "revision-thread",
      sender: agent,
      recipientIds: [human.id],
      content: await fixture.prepare.prepare("Old answer", {
        namespace: "tenant-revision",
        idempotencyKey: "revision-old-answer-content",
      }),
    });
    const revisedContent = await fixture.prepare.prepare([
      "Revised question",
      { type: "json", value: { version: 2 } },
    ], {
      namespace: "tenant-revision",
      idempotencyKey: "revision-new-content",
    });
    const input = {
      namespace: "tenant-revision",
      id: "revision-head",
      threadId: "revision-thread",
      messageId: "revision-original",
      content: revisedContent,
      metadata: { source: "edit" },
      identity: {
        correlationId: "revision-correlation",
        deduplicationId: "revision-operation",
      },
    } as const;
    const revised = await fixture.conversation.reviseMessage(input);
    assertEquals(revised.event.type, "message.revised");
    assertEquals(revised.value?.rootMessageId, "revision-original");
    assertEquals(revised.value?.previousRevisionMessageId, "revision-original");
    assertEquals(revised.value?.revisionIndex, 1);
    assertEquals(revised.value?.message.revision, {
      rootMessageId: "revision-original",
      previousRevisionMessageId: "revision-original",
      revisionIndex: 1,
      revisedAt: revised.value?.message.createdAt,
    });
    await Promise.all(revised.dispatch.handles.map((handle) => handle.done));

    await fixture.conversation.createMessage({
      namespace: "tenant-revision",
      id: "revision-new-answer",
      threadId: "revision-thread",
      sender: agent,
      recipientIds: [human.id],
      content: await fixture.prepare.prepare("New answer", {
        namespace: "tenant-revision",
        idempotencyKey: "revision-new-answer-content",
      }),
    });
    assertEquals(
      (await fixture.conversation.listMessages(
        "tenant-revision",
        "revision-thread",
      )).map((message) => message.id),
      ["revision-head", "revision-new-answer"],
    );
    assertEquals(
      (await fixture.conversation.listMessages(
        "tenant-revision",
        "revision-thread",
        { view: "all" },
      )).map((message) => message.id),
      [
        "revision-original",
        "revision-old-answer",
        "revision-head",
        "revision-new-answer",
      ],
    );
    assertEquals(
      (await fixture.conversation.listMessages(
        "tenant-revision",
        "revision-thread",
        { after: "revision-head", limit: 1 },
      )).map((message) => message.id),
      ["revision-new-answer"],
    );
    assertEquals(
      (await fixture.conversation.listMessageRevisions(
        "tenant-revision",
        "revision-head",
      )).map((message) => message.id),
      ["revision-original", "revision-head"],
    );
    assertEquals(
      (await fixture.conversation.getMessage(
        "tenant-revision",
        "revision-original",
      ))?.content,
      originalContent.content,
    );
    assertEquals(
      (await fixture.conversation.getThread(
        "tenant-revision",
        "revision-thread",
      ))?.activeMessageBranch,
      {
        rootMessageId: "revision-original",
        headMessageId: "revision-head",
        previousRevisionMessageId: "revision-original",
        revisionIndex: 1,
      },
    );
    const repeated = await fixture.conversation.reviseMessage(input);
    assertEquals(repeated.deduplicated, true);
    assertEquals(repeated.event.id, revised.event.id);
    assertEquals(
      (await fixture.conversation.listMessages(
        "tenant-revision",
        "revision-thread",
        { view: "all" },
      )).filter((message) => message.id === "revision-head").length,
      1,
    );
    const revisionEdge = await fixture.session.query<
      { count: number | string }
    >(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.edges}
       WHERE namespace = $1 AND source_node_id = $2
         AND target_node_id = $3 AND type = 'revises'`,
      ["tenant-revision", "revision-head", "revision-original"],
    );
    assertEquals(Number(revisionEdge.rows[0].count), 1);
    await assertRejects(
      () =>
        fixture.conversation.reviseMessage({
          namespace: "tenant-revision",
          threadId: "revision-thread",
          messageId: "revision-new-answer",
          content: revisedContent,
        }),
      Error,
      "Only human messages",
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("message and thread deletion remove graph state but retain immutable events", async () => {
  const fixture = await createFixture();
  try {
    const human = {
      id: "delete-human",
      externalId: "delete-human",
      participantType: "human" as const,
    };
    await fixture.conversation.createThread({
      namespace: "tenant-delete",
      id: "delete-parent",
      participants: [human],
    });
    await fixture.conversation.createThread({
      namespace: "tenant-delete",
      id: "delete-child",
      parentThreadId: "delete-parent",
      participants: [human],
    });
    const createMessage = (id: string) =>
      fixture.conversation.createMessage({
        namespace: "tenant-delete",
        id,
        threadId: "delete-parent",
        sender: human,
        content: [],
      });
    await createMessage("delete-message-a");
    const deleteMessagesInput = {
      namespace: "tenant-delete",
      threadId: "delete-parent",
      identity: { deduplicationId: "delete-parent-messages" },
    } as const;
    const deletedMessages = await fixture.conversation.deleteThreadMessages(
      deleteMessagesInput,
    );
    assertEquals(deletedMessages.event.type, "thread.messages_deleted");
    assertEquals(deletedMessages.value, {
      threadId: "delete-parent",
      deleted: true,
    });
    assertEquals(
      await fixture.conversation.listMessages(
        "tenant-delete",
        "delete-parent",
      ),
      [],
    );
    assertEquals(
      (await fixture.conversation.deleteThreadMessages(deleteMessagesInput))
        .deduplicated,
      true,
    );

    await createMessage("delete-message-b");
    const deletedThread = await fixture.conversation.deleteThread({
      namespace: "tenant-delete",
      id: "delete-parent",
      identity: { deduplicationId: "delete-parent" },
    });
    assertEquals(deletedThread.event.type, "thread.deleted");
    assertEquals(deletedThread.value, { id: "delete-parent", deleted: true });
    assertEquals(
      await fixture.conversation.getThread("tenant-delete", "delete-parent"),
      null,
    );
    assertEquals(
      await fixture.conversation.getMessage(
        "tenant-delete",
        "delete-message-b",
      ),
      null,
    );
    const child = await fixture.conversation.getThread(
      "tenant-delete",
      "delete-child",
    );
    assertExists(child);
    assertEquals(child.parentThreadId, undefined);
    assertEquals(
      (await fixture.conversation.deleteThread({
        namespace: "tenant-delete",
        id: "delete-parent",
        identity: { deduplicationId: "delete-parent" },
      })).deduplicated,
      true,
    );
    const events = await fixture.store.listEvents({
      namespace: "tenant-delete",
    });
    assert(events.some((event) =>
      event.type === "message.created" &&
      event.subject?.id === "delete-message-a"
    ));
    assert(events.some((event) => event.type === "thread.messages_deleted"));
    assert(events.some((event) => event.type === "thread.deleted"));
    await assertRejects(
      () =>
        fixture.conversation.deleteThread({
          namespace: "another-tenant",
          id: "delete-child",
        }),
      Error,
      "was not found",
    );
    assertExists(
      await fixture.conversation.getThread("tenant-delete", "delete-child"),
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("invalid graph mutations roll back nodes, events, and deliveries together", async () => {
  const fixture = await createFixture();
  try {
    await assertRejects(() =>
      fixture.conversation.createThread({
        namespace: "tenant-a",
        id: "child",
        parentThreadId: "missing-parent",
      })
    );
    const orphanContent = await fixture.prepare.prepare("must roll back", {
      namespace: "tenant-a",
      idempotencyKey: "orphan-message",
    });
    await assertRejects(() =>
      fixture.conversation.createMessage({
        namespace: "tenant-a",
        id: "orphan-message",
        threadId: "missing-thread",
        sender: {
          externalId: "alice",
          participantType: "human",
        },
        content: orphanContent,
      })
    );

    const counts = await fixture.session.query<{
      nodes: number | string;
      events: number | string;
      deliveries: number | string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM ${fixture.store.tables.nodes}) AS nodes,
         (SELECT COUNT(*) FROM ${fixture.store.tables.events}) AS events,
         (SELECT COUNT(*) FROM ${fixture.store.tables.event_deliveries}) AS deliveries`,
    );
    assertEquals(Number(counts.rows[0].nodes), 0);
    assertEquals(Number(counts.rows[0].events), 0);
    assertEquals(Number(counts.rows[0].deliveries), 0);

    await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a",
    });
    await assertRejects(() =>
      fixture.conversation.createMessage({
        namespace: "tenant-a",
        id: "invalid-recipient-message",
        threadId: "thread-a",
        sender: {
          externalId: "alice",
          participantType: "human",
        },
        recipientIds: ["missing-agent"],
        content: [],
      })
    );
    assertEquals(
      await fixture.conversation.getParticipantByExternalId(
        "tenant-a",
        "alice",
      ),
      null,
    );
    assertEquals(
      await fixture.conversation.getMessage(
        "tenant-a",
        "invalid-recipient-message",
      ),
      null,
    );
    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).map((event) =>
        event.type
      ),
      ["thread.created"],
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("participant identity and graph reads remain tenant scoped", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a-1",
      externalId: "external-a-1",
      participants: [{
        externalId: "shared-user",
        participantType: "human",
      }],
    });
    const participantA = first.value!.participants[0];
    const second = await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a-2",
      participants: [{
        externalId: "shared-user",
        participantType: "human",
      }],
    });
    assertEquals(second.value!.participants[0].id, participantA.id);

    const otherTenant = await fixture.conversation.createThread({
      namespace: "tenant-b",
      id: "thread-b-1",
      externalId: "external-a-1",
      participants: [{
        externalId: "shared-user",
        participantType: "human",
      }],
    });
    assert(otherTenant.value!.participants[0].id !== participantA.id);
    assertEquals(
      await fixture.conversation.getParticipant("tenant-b", participantA.id),
      null,
    );
    assertEquals(
      (await fixture.conversation.getParticipantByExternalId(
        "tenant-a",
        "shared-user",
      ))?.id,
      participantA.id,
    );
    assertEquals(
      (await fixture.conversation.listThreads("tenant-a", {
        participantId: "shared-user",
      })).map((thread) => thread.id),
      ["thread-a-2", "thread-a-1"],
    );

    const participantCounts = await fixture.session.query<{
      namespace: string;
      count: number | string;
    }>(
      `SELECT namespace, COUNT(*) AS count
       FROM ${fixture.store.tables.nodes}
       WHERE type = 'participant'
       GROUP BY namespace ORDER BY namespace`,
    );
    assertEquals(participantCounts.rows, [
      { namespace: "tenant-a", count: 1 },
      { namespace: "tenant-b", count: 1 },
    ]);

    await assertRejects(() =>
      fixture.conversation.createThread({
        namespace: "tenant-a",
        id: "thread-a-spoofed-participant",
        participants: [{
          externalId: "shared-user",
          participantType: "agent",
        }],
      })
    );
    assertEquals(
      await fixture.conversation.getThread(
        "tenant-a",
        "thread-a-spoofed-participant",
      ),
      null,
    );

    await assertRejects(() =>
      fixture.conversation.createThread({
        namespace: "tenant-a",
        id: "thread-a-conflict",
        externalId: "external-a-1",
      })
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("participant and thread updates are typed, durable, and retry-safe", async () => {
  const fixture = await createFixture();
  try {
    await fixture.conversation.createParticipant({
      namespace: "tenant-a",
      participant: {
        id: "agent-a",
        externalId: "agent-a",
        participantType: "agent",
        name: "Original",
        metadata: { retained: true },
      },
    });
    await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a",
      name: "Original thread",
      description: "Original description",
      participants: [{
        id: "agent-a",
        externalId: "agent-a",
        participantType: "agent",
      }],
      metadata: { version: 1 },
    });

    const participantInput = {
      namespace: "tenant-a",
      id: "agent-a",
      patch: {
        name: "Updated",
        metadata: { retained: true, memory: "event-native" },
      },
      identity: { deduplicationId: "participant:update:agent-a" },
    } as const;
    const updatedParticipant = await fixture.conversation.updateParticipant(
      participantInput,
    );
    assertEquals(updatedParticipant.event.type, "participant.updated");
    assertEquals(updatedParticipant.event.delta, {
      fields: ["metadata", "name"],
    });
    assertEquals(updatedParticipant.value?.name, "Updated");
    assertEquals(updatedParticipant.value?.metadata, {
      retained: true,
      memory: "event-native",
    });

    const replay = await fixture.conversation.updateParticipant(
      participantInput,
    );
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.event.id, updatedParticipant.event.id);

    const updatedThread = await fixture.conversation.updateThread({
      namespace: "tenant-a",
      id: "thread-a",
      patch: {
        name: "Renamed thread",
        description: "Updated description",
        status: "closed",
        metadata: { version: 2 },
      },
      identity: { deduplicationId: "thread:update:thread-a" },
    });
    assertEquals(updatedThread.event.type, "thread.updated");
    assertEquals(updatedThread.value?.status, "closed");
    assertEquals(updatedThread.value?.name, "Renamed thread");
    assertEquals(updatedThread.value?.description, "Updated description");
    assertEquals(updatedThread.value?.metadata, { version: 2 });
    assertEquals(updatedThread.value?.participants.map((value) => value.id), [
      "agent-a",
    ]);

    await assertRejects(
      async () =>
        await fixture.conversation.updateParticipant({
          namespace: "tenant-a",
          id: "agent-a",
          patch: {},
        }),
      TypeError,
      "must change a field",
    );
    await assertRejects(() =>
      fixture.conversation.updateThread({
        namespace: "tenant-b",
        id: "thread-a",
        patch: { status: "closed" },
      })
    );

    assertEquals(
      (await fixture.store.listEvents({ namespace: "tenant-a" })).map(
        (event) => event.type,
      ),
      [
        "participant.created",
        "thread.created",
        "participant.updated",
        "thread.updated",
      ],
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("message deduplication and event positions preserve exactly-once projection order", async () => {
  const fixture = await createFixture();
  try {
    await fixture.conversation.createParticipant({
      namespace: "tenant-a",
      participant: {
        id: "agent-a",
        externalId: "agent-a",
        participantType: "agent",
      },
    });
    await fixture.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a",
    });
    const content = await fixture.prepare.prepare("first", {
      namespace: "tenant-a",
      idempotencyKey: "first",
    });
    const input = {
      namespace: "tenant-a",
      threadId: "thread-a",
      sender: {
        externalId: "alice",
        participantType: "human" as const,
      },
      recipientIds: ["agent-a"],
      content,
      identity: { deduplicationId: "inbound:first" },
    };
    const first = await fixture.conversation.createMessage(input);
    await first.dispatch.handles[0].done;
    const replayContent = await fixture.prepare.prepare("first", {
      namespace: "tenant-a",
      idempotencyKey: "first",
    });
    const replay = await fixture.conversation.createMessage({
      ...input,
      content: replayContent,
    });
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.event.id, first.event.id);
    assertEquals(replay.value?.id, first.value?.id);
    assertEquals(replay.value?.content, first.value?.content);
    assertEquals(replay.dispatch.handles, []);

    const conflictingContent = await fixture.prepare.prepare("changed", {
      namespace: "tenant-a",
      idempotencyKey: "first",
    });
    await assertRejects(() =>
      fixture.conversation.createMessage({
        ...input,
        content: conflictingContent,
      })
    );

    const second = await fixture.conversation.createMessage({
      ...input,
      content: await fixture.prepare.prepare("second", {
        namespace: "tenant-a",
        idempotencyKey: "second",
      }),
      identity: { deduplicationId: "inbound:second" },
    });
    await second.dispatch.handles[0].done;
    const third = await fixture.conversation.createMessage({
      ...input,
      content: await fixture.prepare.prepare("third", {
        namespace: "tenant-a",
        idempotencyKey: "third",
      }),
      identity: { deduplicationId: "inbound:third" },
    });
    await third.dispatch.handles[0].done;

    assertEquals(fixture.handled.length, 3);
    assertEquals(
      (await fixture.conversation.listMessages("tenant-a", "thread-a")).map(
        (message) => message.id,
      ),
      [first.value!.id, second.value!.id, third.value!.id],
    );
    assertEquals(
      (await fixture.conversation.listMessages("tenant-a", "thread-a", {
        after: first.value!.id,
        limit: 1,
      })).map((message) => message.id),
      [second.value!.id],
    );
    assertEquals(
      (await fixture.conversation.listMessages("tenant-a", "thread-a", {
        order: "desc",
        limit: 2,
      })).map((message) => message.id),
      [third.value!.id, second.value!.id],
    );
    assertEquals(
      (await fixture.conversation.listMessages("tenant-a", "thread-a", {
        before: third.value!.id,
        order: "desc",
        limit: 1,
      })).map((message) => message.id),
      [second.value!.id],
    );
    await assertRejects(
      () =>
        fixture.conversation.listMessages("tenant-a", "thread-a", {
          after: first.value!.id,
          before: third.value!.id,
        }),
      TypeError,
      "either after or before",
    );

    const persisted = await fixture.session.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.nodes}
       WHERE namespace = 'tenant-a' AND type = 'message'`,
    );
    assertEquals(Number(persisted.rows[0].count), 3);
    assertEquals(
      (await fixture.store.listEvents({
        namespace: "tenant-a",
        threadId: "thread-a",
      })).filter((event) => event.type === "message.created").length,
      3,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 graph-native conversation core is factory-first and runtime-neutral", async () => {
  for (const module of ["conversation.ts", "index.ts", "types.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
    assert(!/from\s+["']node:/.test(source));
    assert(!/\bclass\s+\w+/.test(source));
    assert(!/runtime\/cli|server\//.test(source));
    assert(!/unsafeGraph|__read|__tables/.test(source));
  }
});
