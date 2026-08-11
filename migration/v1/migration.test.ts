import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createEventCoordinator,
  createEventStore,
  quoteEventIdentifier,
  type SqlSession,
} from "../../runtime/events/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import {
  createContentPreparer,
  createContentResolver,
  createDatabaseAssetRepository,
} from "../../runtime/content/index.ts";
import {
  createConversationRepository,
  createEventCollectionRepository,
  createLlmAttemptRepository,
  createToolExecutionRepository,
  llmAttemptContent,
  toolExecutionContent,
} from "../../runtime/domain/index.ts";
import { createDeliveryExecutor } from "../../runtime/execution/index.ts";
import { createKnowledgeRepository } from "../../runtime/knowledge/index.ts";
import { longTermMemoryCollection } from "../../runtime/memory/index.ts";
import { createPluginRegistry } from "../../runtime/plugins/index.ts";
import {
  discoverV1Schemas,
  upgradeV1Schema,
  upgradeV1Schemas,
} from "./index.ts";
import { provisionV1FixtureSchema } from "./fixture.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

function q(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

function uniqueSchema(label: string): string {
  return `v1_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function createFixture(): Promise<{
  db: TestDatabase;
  session: SqlSession;
}> {
  const db = await createTestDatabase({ url: ":memory:" });
  await provisionV1FixtureSchema(db.session, "public");
  return { db, session: db.session };
}

async function createV3Readers(session: SqlSession, schema: string) {
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: `migration-reader-${schema}`,
    createContext: (base) => ({ ...base }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let id = 0;
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    createId: () => `migration-reader-edge-${++id}`,
  });
  const conversation = createConversationRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `migration-reader-domain-${++id}`,
  });
  const tools = createToolExecutionRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `migration-reader-tool-${++id}`,
  });
  const attempts = createLlmAttemptRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `migration-reader-attempt-${++id}`,
  });
  const preparer = createContentPreparer({
    createId: () => `migration-reader-content-${++id}`,
  });
  const knowledge = createKnowledgeRepository({
    coordinator,
    session,
    eventStore: store,
    assets,
    preparer,
    createId: () => `migration-reader-knowledge-${++id}`,
  });
  const memories = createEventCollectionRepository({
    definition: longTermMemoryCollection,
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `migration-reader-memory-${++id}`,
  });
  return {
    assets,
    attempts,
    conversation,
    executor,
    knowledge,
    memories,
    resolver: createContentResolver({ assets }),
    tools,
  };
}

function legacyAssetResolver(suffix: string) {
  return ({ id }: { id: string }) => {
    assertEquals(id, `asset-${suffix}`);
    return Promise.resolve({
      body: new TextEncoder().encode(`legacy-image-${suffix}`),
      mediaType: "image/png",
    });
  };
}

async function seedLegacyTenant(
  session: SqlSession,
  schema: string,
  suffix: string,
): Promise<void> {
  const namespace = `tenant-${suffix}`;
  const rootThread = `thread-root-${suffix}`;
  const childThread = `thread-child-${suffix}`;
  const userExternalId = `user-${suffix}`;
  const agentExternalId = `agent-${suffix}`;
  const participantId = `participant-user-${suffix}`;
  const timestamp = "2026-01-01T00:00:00.000Z";

  await session.query(
    `INSERT INTO ${q(schema, "threads")} (
       "id", "namespace", "name", "externalId", "description",
       "participants", "initialMessage", "mode", "status", "summary",
       "rootThreadId", "lastEventId", "lastEventAt", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, 'Root', $3, 'root-description', $4::jsonb,
       'initial', 'immediate', 'active', 'root-summary', $1,
       $5, $6::timestamptz, $6::timestamptz, $6::timestamptz
     )`,
    [
      rootThread,
      namespace,
      `external-root-${suffix}`,
      JSON.stringify([userExternalId, agentExternalId]),
      `event-token-${suffix}`,
      timestamp,
    ],
  );
  await session.query(
    `INSERT INTO ${q(schema, "threads")} (
       "id", "namespace", "name", "participants", "mode", "status",
       "parentThreadId", "rootThreadId", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, 'Child', $3::jsonb, 'immediate', 'active',
       $4, $4, $5::timestamptz, $5::timestamptz
     )`,
    [
      childThread,
      namespace,
      JSON.stringify([userExternalId]),
      rootThread,
      timestamp,
    ],
  );

  const nodes = [
    {
      id: rootThread,
      type: "thread",
      name: "Existing Root",
      content: null,
      data: { metadata: { private: true }, existingOnly: "preserved" },
      sourceType: "thread",
      sourceId: rootThread,
    },
    {
      id: participantId,
      type: "participant",
      name: "Existing User",
      content: null,
      data: {
        externalId: userExternalId,
        participantType: "human",
        profile: { locale: "pt-BR" },
      },
      sourceType: "user",
      sourceId: userExternalId,
    },
    {
      id: `message-${suffix}`,
      type: "message",
      name: "Message",
      content: "hello",
      data: {
        threadId: rootThread,
        senderId: userExternalId,
        senderType: "user",
        reasoning: "legacy reasoning",
        toolCalls: [{ id: `call-${suffix}`, name: "lookup" }],
        metadata: {
          channel: "legacy-web",
          attachments: [{
            kind: "image",
            mimeType: "image/png",
            fileName: "legacy.png",
            assetRef: `asset://asset-${suffix}`,
          }],
        },
      },
      sourceType: "message",
      sourceId: `message-${suffix}`,
    },
    {
      id: `tool-${suffix}`,
      type: "tool_execution",
      name: "Tool",
      content: null,
      data: {
        threadId: rootThread,
        messageId: `message-${suffix}`,
        agentId: agentExternalId,
        toolCallId: `call-${suffix}`,
        tool: { id: "lookup", name: "Lookup" },
        args: { q: "x" },
        status: "completed",
        output: { ok: true },
        historyVisibility: "requester_only",
        startedAt: timestamp,
        finishedAt: "2026-01-01T00:00:02.000Z",
      },
      sourceType: "tool_execution",
      sourceId: `tool-${suffix}`,
    },
    {
      id: `llm-${suffix}`,
      type: "llm_attempt",
      name: "LLM",
      content: null,
      data: {
        threadId: rootThread,
        messageId: `message-${suffix}`,
        agentId: agentExternalId,
        provider: "openai",
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ id: "lookup" }],
        status: "completed",
        answer: "legacy answer",
        reasoning: "legacy thought",
        toolCalls: [{ id: `call-${suffix}`, name: "lookup" }],
        usage: { inputTokens: 10, outputTokens: 4 },
        attemptIndex: 0,
        startedAt: timestamp,
        finishedAt: "2026-01-01T00:00:02.000Z",
      },
      sourceType: "llm_attempt",
      sourceId: `llm-${suffix}`,
    },
    {
      id: `asset-${suffix}`,
      type: "asset",
      name: "Asset",
      content: null,
      data: { ref: `asset://${suffix}`, mime: "image/png" },
      sourceType: "asset",
      sourceId: `asset-${suffix}`,
    },
    {
      id: `document-${suffix}`,
      type: "document",
      name: "Legacy image",
      content: null,
      data: {
        sourceType: "asset",
        sourceUri: null,
        title: "Legacy image",
        mimeType: "image/png",
        contentHash: `sha256:legacy-${suffix}`,
        assetId: `asset-${suffix}`,
        status: "indexed",
        chunkCount: 0,
        metadata: { scope: { threadId: rootThread } },
      },
      sourceType: "document",
      sourceId: null,
    },
    {
      id: `memory-${suffix}`,
      type: "long_term_memory",
      name: "Memory",
      content: "remember this",
      data: {
        threadId: rootThread,
        schemaVersion: "2",
        strategy: "rolling",
        status: "ready",
        memorySpaceId: null,
        readMemorySpaceIds: [],
        writeMemorySpaceIds: [],
        defaultWriteMemorySpaceId: null,
        sequence: 1,
        agentId: agentExternalId,
        sourceStartMessageId: `message-${suffix}`,
        sourceEndMessageId: `message-${suffix}`,
        content: null,
        metadata: { legacy: true },
      },
      sourceType: "thread",
      sourceId: rootThread,
    },
    {
      id: `usage-${suffix}`,
      type: "usage",
      name: "Usage",
      content: null,
      data: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.001 },
      sourceType: "usage",
      sourceId: `usage-${suffix}`,
    },
    {
      id: `custom-${suffix}`,
      type: "booking",
      name: "Booking",
      content: null,
      data: { status: "confirmed", custom: { untouched: true } },
      sourceType: "collection",
      sourceId: `custom-${suffix}`,
    },
  ];
  for (const node of nodes) {
    await session.query(
      `INSERT INTO ${q(schema, "nodes")} (
         "id", "namespace", "type", "name", "content", "data",
         "source_type", "source_id", "created_at", "updated_at"
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         $7, $8, $9::timestamptz, $9::timestamptz
       )`,
      [
        node.id,
        namespace,
        node.type,
        node.name,
        node.content,
        JSON.stringify(node.data),
        node.sourceType,
        node.sourceId,
        timestamp,
      ],
    );
  }

  await session.query(
    `INSERT INTO ${q(schema, "edges")} (
       "id", "source_node_id", "target_node_id", "type", "data", "weight"
     ) VALUES
       ($1, $2, $3, 'participates_in', '{}', 1),
       ($4, $5, $6, 'has_asset', '{"legacy":true}', 1)`,
    [
      `edge-participation-${suffix}`,
      participantId,
      rootThread,
      `edge-asset-${suffix}`,
      `message-${suffix}`,
      `asset-${suffix}`,
    ],
  );

  const events = [
    {
      id: `event-message-${suffix}`,
      type: "NEW_MESSAGE",
      status: "completed",
      payload: {
        content: "hello",
        sender: { id: userExternalId, type: "user" },
      },
      subjectType: "message",
      subjectId: `message-${suffix}`,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      id: `event-token-${suffix}`,
      type: "TOKEN",
      status: "completed",
      payload: { token: "ephemeral", isComplete: false },
      subjectType: null,
      subjectId: null,
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    {
      id: `event-tool-${suffix}`,
      type: "TOOL_RESULT",
      status: "failed",
      payload: {
        status: "failed",
        agent: { id: "support", name: "Support" },
        historyVisibility: "requester_only",
        error: { code: "lookup_failed" },
      },
      subjectType: "tool_execution",
      subjectId: `tool-${suffix}`,
      createdAt: "2026-01-01T00:00:03.000Z",
    },
    {
      id: `event-custom-${suffix}`,
      type: "booking.updated",
      status: "completed",
      payload: { id: `custom-${suffix}`, status: "confirmed" },
      subjectType: "booking",
      subjectId: `custom-${suffix}`,
      createdAt: "2026-01-01T00:00:04.000Z",
    },
  ];
  for (const [index, event] of events.entries()) {
    await session.query(
      `INSERT INTO ${q(schema, "events")} (
         "id", "threadId", "eventType", "payload", "parentEventId",
         "traceId", "namespace", "status", "metadata",
         "subjectType", "subjectId", "operation", "causationId",
         "correlationId", "dedupeKey", "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb,
         $10, $11, $12, $13, $14, $15, $16::timestamptz, $16::timestamptz
       )`,
      [
        event.id,
        rootThread,
        event.type,
        JSON.stringify(event.payload),
        index === 0 ? null : events[index - 1].id,
        `trace-${suffix}`,
        namespace,
        event.status,
        JSON.stringify({ seeded: true }),
        event.subjectType,
        event.subjectId,
        event.type === "booking.updated" ? "updated" : null,
        index === 0 ? null : events[index - 1].id,
        `correlation-${suffix}`,
        `dedupe-${suffix}-${index}`,
        event.createdAt,
      ],
    );
  }
}

Deno.test("A28 upgrade refuses active queue work and live thread leases", async () => {
  const { db, session } = await createFixture();
  try {
    await session.query(
      `INSERT INTO "threads" (
         "id", "name", "mode", "status", "createdAt", "updatedAt"
       ) VALUES ('active-thread', 'Active', 'immediate', 'active', NOW(), NOW())`,
    );
    await session.query(
      `INSERT INTO "events" (
         "id", "threadId", "eventType", "payload", "status",
         "createdAt", "updatedAt"
       ) VALUES (
         'pending-event', 'active-thread', 'NEW_MESSAGE', '{}', 'pending',
         NOW(), NOW()
       )`,
    );
    const activeWork = await assertRejects(() =>
      upgradeV1Schema(session, "public")
    );
    assert(activeWork instanceof Error);
    assertStringIncludes(activeWork.message, "pending or processing");

    await session.query(`DELETE FROM "events" WHERE "id" = 'pending-event'`);
    await session.query(
      `UPDATE "threads"
       SET "workerLockedBy" = 'worker-a',
           "workerLeaseExpiresAt" = NOW() + INTERVAL '1 hour'
       WHERE "id" = 'active-thread'`,
    );
    const activeLease = await assertRejects(() =>
      upgradeV1Schema(session, "public")
    );
    assert(activeLease instanceof Error);
    assertStringIncludes(activeLease.message, "leases are active");

    const staging = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE '%_v1_upgrade'`,
    );
    assertEquals(Number(staging.rows[0]?.count), 0);
    const columns = await session.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'events'`,
    );
    assert(columns.rows.some((row) => row.column_name === "status"));
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade rolls back when legacy assets have no resolver", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("asset_rollback");
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, "asset-rollback");
    const error = await assertRejects(() => upgradeV1Schema(session, schema));
    assert(error instanceof Error);
    assertStringIncludes(error.message, "resolveLegacyAsset");
    assertStringIncludes(error.message, `asset-asset-rollback`);

    const tables = await session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema],
    );
    assertEquals(
      tables.rows.map((row) => row.table_name),
      ["edges", "events", "nodes", "threads"],
    );
    const legacyColumns = await session.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'events'`,
      [schema],
    );
    assert(
      legacyColumns.rows.some((row) => row.column_name === "eventType"),
    );
    assert(
      !legacyColumns.rows.some((row) => row.column_name === "position"),
    );
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade preserves unavailable assets and their message references", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("asset_unavailable");
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, "unavailable");
    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: () => ({
        state: "failed",
        reason: "legacy filesystem body is unavailable",
      }),
    });

    const asset = await session.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${q(schema, "nodes")} WHERE id = $1`,
      ["asset-unavailable"],
    );
    assertEquals(asset.rows[0]?.data.state, "failed");
    assertEquals(
      (asset.rows[0]?.data.metadata as Record<string, unknown>)
        .migrationUnavailable,
      {
        code: "legacy_asset_unavailable",
        reason: "legacy filesystem body is unavailable",
      },
    );

    const readers = await createV3Readers(session, schema);
    try {
      const message = await readers.conversation.getMessage(
        "tenant-unavailable",
        "message-unavailable",
      );
      assertEquals(
        message?.content.map((ref) => [ref.role, ref.assetId]),
        [
          ["body", message?.content[0]?.assetId],
          ["attachment", "asset-unavailable"],
          ["reasoning", message?.content[2]?.assetId],
          ["llm.tool_calls", message?.content[3]?.assetId],
        ],
      );
      assertEquals(
        (await readers.assets.get(
          "tenant-unavailable",
          "asset-unavailable",
        ))?.state,
        "failed",
      );
      await assertRejects(
        () =>
          readers.assets.read(
            "tenant-unavailable",
            "asset-unavailable",
          ),
        Error,
        "not ready",
      );
    } finally {
      await readers.executor.shutdown();
    }
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade processes legacy nodes in bounded batches", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("node_batches");
  try {
    await provisionV1FixtureSchema(session, schema);
    await session.query(
      `INSERT INTO ${q(schema, "nodes")} (
         id, namespace, type, name, content, data,
         source_type, source_id, created_at, updated_at
       )
       SELECT
         'batch-asset-' || value,
         'tenant-batches',
         'asset',
         'Batch asset',
         NULL,
         jsonb_build_object(
           'ref', 'asset://batch-' || value,
           'mime', 'application/octet-stream'
         ),
         'asset',
         'batch-asset-' || value,
         '2026-01-01T00:00:00.000Z'::timestamptz,
         '2026-01-01T00:00:00.000Z'::timestamptz
       FROM generate_series(1, 205) AS value`,
    );

    let resolved = 0;
    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: () => {
        resolved += 1;
        return { body: new Uint8Array([resolved % 255]) };
      },
    });

    const assets = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count
         FROM ${q(schema, "nodes")}
        WHERE type = 'asset' AND data ->> 'state' = 'ready'`,
    );
    assertEquals(resolved, 205);
    assertEquals(Number(assets.rows[0]?.count), 205);
  } finally {
    await db.close();
  }
});

Deno.test("A28 multi-tenant upgrade preserves graph domains and translates settled events", async () => {
  const { db, session } = await createFixture();
  const schemaA = uniqueSchema("tenant_a");
  const schemaB = uniqueSchema("tenant_b");
  try {
    await provisionV1FixtureSchema(session, schemaA);
    await provisionV1FixtureSchema(session, schemaB);
    await seedLegacyTenant(session, schemaA, "a");
    await seedLegacyTenant(session, schemaB, "b");

    const discovered = await discoverV1Schemas(session);
    assert(discovered.includes("public"));
    assert(discovered.includes(schemaA));
    assert(discovered.includes(schemaB));

    const results = await upgradeV1Schemas(session, {
      schemas: [schemaA, schemaB],
      resolveLegacyAsset: async (input) =>
        await legacyAssetResolver(input.schema === schemaA ? "a" : "b")(
          input,
        ),
    });
    assertEquals(results.length, 2);
    assert(results.every((result) => !result.alreadyUpgraded));
    assertEquals(results.map((result) => result.threads), [2, 2]);
    assertEquals(results.map((result) => result.participantsCreated), [1, 1]);
    assertEquals(results.map((result) => result.events), [3, 3]);

    for (const [schema, suffix] of [[schemaA, "a"], [schemaB, "b"]] as const) {
      const tables = await session.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schema],
      );
      assertEquals(
        tables.rows.map((row) => row.table_name),
        ["edges", "event_deliveries", "events", "nodes"],
      );

      const nodeIds = await session.query<{ id: string }>(
        `SELECT id FROM ${q(schema, "nodes")} ORDER BY id`,
      );
      for (
        const preserved of [
          `asset-${suffix}`,
          `custom-${suffix}`,
          `document-${suffix}`,
          `memory-${suffix}`,
          `message-${suffix}`,
          `llm-${suffix}`,
          `tool-${suffix}`,
          `usage-${suffix}`,
          `edge-does-not-belong-here`,
        ]
      ) {
        if (preserved.startsWith("edge-")) continue;
        assert(
          nodeIds.rows.some((row) => row.id === preserved),
          `${schema} lost ${preserved}`,
        );
      }

      const custom = await session.query<{
        data: Record<string, unknown>;
      }>(
        `SELECT data FROM ${q(schema, "nodes")} WHERE id = $1`,
        [`custom-${suffix}`],
      );
      assertEquals(custom.rows[0]?.data, {
        status: "confirmed",
        custom: { untouched: true },
      });

      const root = await session.query<{
        data: Record<string, unknown>;
      }>(
        `SELECT data FROM ${q(schema, "nodes")} WHERE id = $1`,
        [`thread-root-${suffix}`],
      );
      assertEquals(root.rows[0]?.data?.metadata, { private: true });
      assertEquals(root.rows[0]?.data?.existingOnly, "preserved");
      assertEquals(
        root.rows[0]?.data?.lastEventId,
        `event-custom-${suffix}`,
      );
      assertEquals(typeof root.rows[0]?.data?.lastEventPosition, "string");

      const participation = await session.query<{
        source_node_id: string;
        target_node_id: string;
      }>(
        `SELECT source_node_id, target_node_id
         FROM ${q(schema, "edges")}
         WHERE type = 'participates_in'
         ORDER BY source_node_id, target_node_id`,
      );
      assertEquals(participation.rows.length, 3);
      assert(
        participation.rows.every((edge) =>
          edge.target_node_id.startsWith("thread-")
        ),
      );
      assert(
        participation.rows.some((edge) =>
          edge.source_node_id === `participant-user-${suffix}` &&
          edge.target_node_id === `thread-root-${suffix}`
        ),
      );

      const preservedEdges = await session.query<{ id: string }>(
        `SELECT id FROM ${q(schema, "edges")}
         WHERE id IN ($1, $2) ORDER BY id`,
        [`edge-asset-${suffix}`, `edge-participation-${suffix}`],
      );
      assertEquals(preservedEdges.rows.length, 2);

      const events = await session.query<{
        id: string;
        position: string | number;
        type: string;
        visibility: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, position, type, visibility, metadata
         FROM ${q(schema, "events")} ORDER BY position`,
      );
      assertEquals(
        events.rows.map((event) => event.type),
        [
          "message.created",
          "tool_execution.failed",
          "booking.updated",
        ],
      );
      assertEquals(
        events.rows.some((event) => event.id === `event-token-${suffix}`),
        false,
      );
      assert(
        events.rows.every((event, index) =>
          index === 0 ||
          Number(event.position) > Number(events.rows[index - 1].position)
        ),
      );
      assertEquals(events.rows[1].visibility, {
        kind: "tool",
        policy: "requester_only",
        requesterId: "support",
      });
      assertEquals(events.rows[0].metadata.migratedFromV1, true);

      const deliveries = await session.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM ${q(schema, "event_deliveries")}`,
      );
      assertEquals(Number(deliveries.rows[0]?.count), 0);

      const readers = await createV3Readers(session, schema);
      try {
        const namespace = `tenant-${suffix}`;
        const participant = await readers.conversation
          .getParticipantByExternalId(namespace, `user-${suffix}`);
        assertEquals(participant?.id, `participant-user-${suffix}`);
        assertEquals(participant?.participantType, "human");

        const agent = await readers.conversation.getParticipantByExternalId(
          namespace,
          `agent-${suffix}`,
        );
        assertEquals(agent?.participantType, "agent");

        const thread = await readers.conversation.getThreadByExternalId(
          namespace,
          `external-root-${suffix}`,
        );
        assertEquals(thread?.id, `thread-root-${suffix}`);
        assertEquals(thread?.participants.length, 2);

        const message = await readers.conversation.getMessage(
          namespace,
          `message-${suffix}`,
        );
        assertEquals(message?.sender.id, `participant-user-${suffix}`);
        assertEquals(message?.metadata.channel, "legacy-web");
        assertEquals(
          message?.content.map((ref) => ref.role),
          ["body", "attachment", "reasoning", "llm.tool_calls"],
        );
        const messageBodies = await readers.resolver.getMany(
          message!.content,
          { namespace },
        );
        assertEquals(messageBodies[0].text, "hello");
        assertEquals(
          new TextDecoder().decode(messageBodies[1].bytes),
          `legacy-image-${suffix}`,
        );
        assertEquals(messageBodies[1].ref.name, "legacy.png");
        assertEquals(messageBodies[2].text, "legacy reasoning");
        assertEquals(messageBodies[3].value, [{
          id: `call-${suffix}`,
          name: "lookup",
        }]);

        const tool = await readers.tools.get(namespace, `tool-${suffix}`);
        assertEquals(tool?.toolCallId, `call-${suffix}`);
        assertEquals(tool?.status, "completed");
        assertEquals(tool?.participantId, agent?.id);
        const toolContent = toolExecutionContent(tool!);
        assertEquals(
          (await readers.resolver.get(toolContent.arguments, { namespace }))
            .value,
          { q: "x" },
        );
        assertEquals(
          (await readers.resolver.get(toolContent.output!, { namespace }))
            .value,
          { ok: true },
        );

        const attempt = await readers.attempts.get(
          namespace,
          `llm-${suffix}`,
        );
        assertEquals(attempt?.status, "completed");
        assertEquals(attempt?.participantId, agent?.id);
        const attemptContent = llmAttemptContent(attempt!);
        assertEquals(
          (await readers.resolver.get(attemptContent.answer!, { namespace }))
            .text,
          "legacy answer",
        );
        assertEquals(
          (await readers.resolver.get(attemptContent.reasoning!, {
            namespace,
          })).text,
          "legacy thought",
        );

        const legacyAsset = await readers.assets.read(
          namespace,
          `asset-${suffix}`,
        );
        assertEquals(legacyAsset.asset.mediaType, "image/png");
        assertEquals(
          new TextDecoder().decode(legacyAsset.bytes),
          `legacy-image-${suffix}`,
        );

        const document = await readers.knowledge.get(
          namespace,
          `document-${suffix}`,
        );
        assertEquals(document?.source[0]?.assetId, `asset-${suffix}`);
        assertEquals(document?.mediaType, "image/png");
        assertEquals(document?.threadId, `thread-root-${suffix}`);
        assertEquals(
          new TextDecoder().decode(
            (await readers.resolver.get(document!.source[0], { namespace }))
              .bytes,
          ),
          `legacy-image-${suffix}`,
        );

        const memory = await readers.memories.get(
          namespace,
          `memory-${suffix}`,
        );
        const memoryContent = memory?.content as Array<{
          assetId: string;
          kind: "text";
          role: string;
          mediaType: string;
        }>;
        assertEquals(memoryContent[0]?.role, "memory.snapshot");
        assertEquals(
          (await readers.resolver.get(memoryContent[0], { namespace })).text,
          "remember this",
        );
      } finally {
        await readers.executor.shutdown();
      }

      const eventColumns = await session.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'events'`,
        [schema],
      );
      const names = new Set(eventColumns.rows.map((row) => row.column_name));
      assert(names.has("position"));
      assert(!names.has("status"));
      assert(!names.has("eventType"));

      const replay = await upgradeV1Schema(session, schema);
      assertEquals(replay.alreadyUpgraded, true);
      assertEquals(replay.events, 3);
    }

    const remaining = await discoverV1Schemas(session);
    assert(remaining.includes("public"));
    assert(!remaining.includes(schemaA));
    assert(!remaining.includes(schemaB));
  } finally {
    await db.close();
  }
});

Deno.test("v1 upgrade module remains isolated from the normal runtime", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert(!/\bclass\s+\w+/.test(source));
  assert(!/runtime\/index|createCopilotz|event-engine/.test(source));
  assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
});

Deno.test({
  name: "A28 v1 upgrade executes against PostgreSQL",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await createTestDatabase({ url: POSTGRES_URL! });
    const session = db.session;
    const schema = uniqueSchema("postgres");
    try {
      await provisionV1FixtureSchema(session, schema);
      await seedLegacyTenant(session, schema, "postgres");
      const result = await upgradeV1Schema(session, schema, {
        resolveLegacyAsset: legacyAssetResolver("postgres"),
      });
      assertEquals(result.threads, 2);
      assertEquals(result.participantsCreated, 1);
      assertEquals(result.events, 3);

      const tables = await session.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schema],
      );
      assertEquals(
        tables.rows.map((row) => row.table_name),
        ["edges", "event_deliveries", "events", "nodes"],
      );
      const events = await session.query<{ type: string }>(
        `SELECT type FROM ${q(schema, "events")} ORDER BY position`,
      );
      assertEquals(events.rows.map((row) => row.type), [
        "message.created",
        "tool_execution.failed",
        "booking.updated",
      ]);
    } finally {
      await session.query(
        `DROP SCHEMA IF EXISTS ${quoteEventIdentifier(schema)} CASCADE`,
      ).catch(() => undefined);
      await db.close();
    }
  },
});
