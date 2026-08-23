import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createEventStore,
  quoteEventIdentifier,
  type SqlExecutor,
  type SqlQueryResult,
  type SqlSession,
} from "../../runtime/events/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import type { CollectionRecord } from "../../runtime/collections/index.ts";
import { type ContentRef } from "../../runtime/content/index.ts";
import {
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
} from "../../runtime/engine/collection-graph.ts";
import { createDeliveryExecutor } from "../../runtime/execution/index.ts";
import { createTestProcessorContext } from "../../runtime/testing/processor-context.ts";
import type { KnowledgeDocument } from "../../runtime/knowledge/index.ts";
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

function emulatePostgresTimestampDecoding(session: SqlSession): SqlSession {
  let nodePageQueries = 0;
  const wrap = (executor: SqlExecutor): SqlExecutor => {
    const query = async <
      TRow extends Record<string, unknown> = Record<string, unknown>,
    >(
      sql: string,
      params?: unknown[],
    ): Promise<SqlQueryResult<TRow>> => {
      const result = await executor.query<TRow>(sql, params);
      const isNodePage = sql.includes(
        "source_type, source_id, created_at, updated_at",
      ) && sql.includes("ORDER BY created_at, id");
      if (!isNodePage) return result;
      nodePageQueries += 1;
      if (nodePageQueries > 30) {
        throw new Error("Legacy node pagination did not advance.");
      }
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          created_at: new Date(String(row.created_at)),
          updated_at: new Date(String(row.updated_at)),
        })) as TRow[],
      };
    };
    return { query };
  };
  const executor = wrap(session);
  return {
    query: executor.query,
    transaction: (operation) =>
      session.transaction((transaction) => operation(wrap(transaction))),
  };
}

function observeLlmAttemptPageSizes(
  session: SqlSession,
  pageSizes: number[],
): SqlSession {
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    query: async <
      TRow extends Record<string, unknown> = Record<string, unknown>,
    >(
      sql: string,
      params?: unknown[],
    ): Promise<SqlQueryResult<TRow>> => {
      if (
        sql.includes("type = ANY($1::text[])") &&
        Array.isArray(params?.[0]) && params[0].includes("llm_attempt")
      ) {
        pageSizes.push(Number(params[3]));
      }
      return await executor.query<TRow>(sql, params);
    },
  });
  const executor = wrap(session);
  return {
    query: executor.query,
    transaction: (operation) =>
      session.transaction((transaction) => operation(wrap(transaction))),
  };
}

async function createV3Readers(session: SqlSession, schema: string) {
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: `migration-reader-${schema}`,
    createContext: createTestProcessorContext,
  });
  type NodeProjectionRow = Readonly<{
    id: string;
    namespace: string;
    data: unknown;
    created_at: string | Date;
    updated_at: string | Date;
  }>;
  const mapNode = (row: NodeProjectionRow): CollectionRecord => {
    const value = typeof row.data === "string"
      ? JSON.parse(row.data) as unknown
      : row.data;
    const data = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return Object.freeze({
      ...data,
      id: row.id,
      namespace: row.namespace,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  };
  const getNode = async (
    namespace: string,
    type: "participant" | "thread" | "message",
    id: string,
  ): Promise<CollectionRecord | null> => {
    const result = await session.query<NodeProjectionRow>(
      `SELECT id, namespace, data, created_at, updated_at
       FROM ${store.tables.nodes}
       WHERE namespace = $1 AND type = $2 AND id = $3
       LIMIT 1`,
      [namespace, type, id],
    );
    return result.rows[0] ? mapNode(result.rows[0]) : null;
  };
  const getNodeByExternalId = async (
    namespace: string,
    type: "participant" | "thread",
    externalId: string,
  ): Promise<CollectionRecord | null> => {
    const result = await session.query<NodeProjectionRow>(
      `SELECT id, namespace, data, created_at, updated_at
       FROM ${store.tables.nodes}
       WHERE namespace = $1 AND type = $2
         AND data ->> 'externalId' = $3
       ORDER BY created_at, id
       LIMIT 1`,
      [namespace, type, externalId],
    );
    return result.rows[0] ? mapNode(result.rows[0]) : null;
  };
  const getParticipant = async (namespace: string, id: string) => {
    const record = await getNode(namespace, "participant", id);
    return record ? mapParticipantRecord(record) : null;
  };
  const projectThread = async (record: CollectionRecord) => {
    const result = await session.query<NodeProjectionRow>(
      `SELECT participant.id, participant.namespace, participant.data,
              participant.created_at, participant.updated_at
       FROM ${store.tables.nodes} participant
       JOIN ${store.tables.edges} edge
         ON edge.namespace = participant.namespace
        AND edge.source_node_id = participant.id
       WHERE edge.namespace = $1 AND edge.target_node_id = $2
         AND edge.type = 'participates_in'
         AND participant.type = 'participant'
       ORDER BY edge.created_at, participant.id`,
      [record.namespace, record.id],
    );
    return mapThreadRecord(
      record,
      result.rows.map(mapNode).map(mapParticipantRecord),
    );
  };
  const conversation = Object.freeze({
    async getParticipantByExternalId(
      namespace: string,
      externalId: string,
    ) {
      const record = await getNodeByExternalId(
        namespace,
        "participant",
        externalId,
      );
      return record ? mapParticipantRecord(record) : null;
    },
    async getThread(namespace: string, id: string) {
      const record = await getNode(namespace, "thread", id);
      return record ? await projectThread(record) : null;
    },
    async getThreadByExternalId(namespace: string, externalId: string) {
      const record = await getNodeByExternalId(namespace, "thread", externalId);
      return record ? await projectThread(record) : null;
    },
    async getMessage(namespace: string, id: string) {
      const record = await getNode(namespace, "message", id);
      if (!record) return null;
      const sender = await getParticipant(namespace, String(record.senderId));
      if (!sender) {
        throw new Error(`Message '${id}' sender was not found.`);
      }
      return mapMessageRecord(record, sender);
    },
  });
  type LegacyWorkflowRecord = Readonly<
    Record<string, unknown> & {
      id: string;
      namespace: string;
      content: readonly ContentRef[];
      metadata: Readonly<Record<string, unknown>>;
    }
  >;
  const mapWorkflow = (row: {
    id: string;
    namespace: string;
    data: unknown;
  }): LegacyWorkflowRecord => {
    const data = typeof row.data === "string"
      ? JSON.parse(row.data) as Record<string, unknown>
      : row.data as Record<string, unknown>;
    return Object.freeze({
      ...data,
      id: row.id,
      namespace: row.namespace,
      content: Object.freeze(
        Array.isArray(data.content) ? data.content as ContentRef[] : [],
      ),
      metadata: Object.freeze(
        data.metadata && typeof data.metadata === "object" &&
          !Array.isArray(data.metadata)
          ? data.metadata as Record<string, unknown>
          : {},
      ),
    });
  };
  const workflowReader = (type: "llm_attempt" | "tool_execution") =>
    Object.freeze({
      async get(
        namespace: string,
        workflowId: string,
      ): Promise<LegacyWorkflowRecord | null> {
        const result = await session.query<{
          id: string;
          namespace: string;
          data: unknown;
        }>(
          `SELECT id, namespace, data FROM ${store.tables.nodes}
           WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
          [namespace, workflowId, type],
        );
        return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
      },
    });
  const attempts = workflowReader("llm_attempt");
  const toolReader = workflowReader("tool_execution");
  const tools = Object.freeze({
    ...toolReader,
    async getByToolCallId(
      namespace: string,
      threadId: string,
      toolCallId: string,
    ): Promise<LegacyWorkflowRecord | null> {
      const result = await session.query<{
        id: string;
        namespace: string;
        data: unknown;
      }>(
        `SELECT id, namespace, data FROM ${store.tables.nodes}
         WHERE namespace = $1 AND type = 'tool_execution'
           AND data ->> 'threadId' = $2 AND data ->> 'toolCallId' = $3
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [namespace, threadId, toolCallId],
      );
      return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
    },
  });
  const legacyAssets = Object.freeze({
    async read(namespace: string, assetId: string) {
      const result = await session.query<{
        id: string;
        namespace: string;
        data: unknown;
        created_at: string | Date;
      }>(
        `SELECT id, namespace, data, created_at FROM ${store.tables.nodes}
         WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
        [namespace, assetId],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Asset '${assetId}' was not found.`);
      const data = typeof row.data === "string"
        ? JSON.parse(row.data) as Record<string, unknown>
        : row.data as Record<string, unknown>;
      if (data.state !== "ready") {
        throw new Error(`Asset '${assetId}' is not ready.`);
      }
      const location = data.location as Record<string, unknown>;
      const body = String(data.body ?? "");
      const bytes = location.encoding === "base64"
        ? Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
        : new TextEncoder().encode(body);
      return Object.freeze({
        asset: Object.freeze({
          id: row.id,
          namespace: row.namespace,
          mediaType: String(data.mediaType),
          byteLength: Number(data.byteLength),
          digest: String(data.digest),
          state: "ready" as const,
          location: Object.freeze({ kind: "database" as const, key: row.id }),
          createdAt: new Date(row.created_at).toISOString(),
          ...(typeof data.readyAt === "string"
            ? { readyAt: data.readyAt }
            : {}),
          metadata: data.metadata as Record<string, unknown> | undefined,
        }),
        bytes,
      });
    },
  });
  type LegacyResolvedContent = Readonly<{
    ref: ContentRef;
    asset: Readonly<{ mediaType: string }>;
    bytes: Uint8Array;
    text?: string;
    value?: unknown;
  }>;
  const resolve = async (
    ref: ContentRef,
    namespace: string,
  ): Promise<LegacyResolvedContent> => {
    const body = await legacyAssets.read(namespace, ref.assetId);
    const resolved: {
      ref: ContentRef;
      asset: Readonly<{ mediaType: string }>;
      bytes: Uint8Array;
      text?: string;
      value?: unknown;
    } = {
      ref,
      asset: body.asset,
      bytes: body.bytes,
    };
    if (ref.kind === "text") {
      resolved.text = new TextDecoder().decode(body.bytes);
    } else if (ref.kind === "json") {
      const text = new TextDecoder().decode(body.bytes);
      resolved.text = text;
      resolved.value = JSON.parse(text);
    }
    return Object.freeze(resolved);
  };
  const resolver = Object.freeze({
    get: (ref: ContentRef, options: { namespace: string }) =>
      resolve(ref, options.namespace),
    getMany: (refs: readonly ContentRef[], options: { namespace: string }) =>
      Promise.all(refs.map((ref) => resolve(ref, options.namespace))),
  });
  const documents = Object.freeze({
    async get(
      namespace: string,
      documentId: string,
    ): Promise<KnowledgeDocument | null> {
      const result = await session.query<{
        id: string;
        namespace: string;
        data: unknown;
        created_at: string | Date;
        updated_at: string | Date;
      }>(
        `SELECT id, namespace, data, created_at, updated_at
         FROM ${store.tables.nodes}
         WHERE namespace = $1 AND id = $2 AND type = 'document'
         LIMIT 1`,
        [namespace, documentId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        ...(row.data as Record<string, unknown>),
        id: row.id,
        namespace: row.namespace,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }) as KnowledgeDocument;
    },
  });
  const memories = Object.freeze({
    async get(
      namespace: string,
      memoryId: string,
    ): Promise<Readonly<Record<string, unknown>> | null> {
      const result = await session.query<{
        id: string;
        namespace: string;
        data: unknown;
        created_at: string | Date;
        updated_at: string | Date;
      }>(
        `SELECT id, namespace, data, created_at, updated_at
         FROM ${store.tables.nodes}
         WHERE namespace = $1 AND id = $2 AND type = 'long_term_memory'
         LIMIT 1`,
        [namespace, memoryId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        ...(row.data as Record<string, unknown>),
        id: row.id,
        namespace: row.namespace,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    },
  });
  return {
    assets: legacyAssets,
    attempts,
    conversation,
    executor,
    documents,
    memories,
    resolver,
    tools,
  };
}

function workflowContent(
  workflow: Readonly<{ content: readonly ContentRef[] }>,
  role: string,
): ContentRef | undefined {
  return workflow.content.find((ref) => ref.role === role);
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

async function seedRepeatedLegacyToolCall(
  session: SqlSession,
  schema: string,
  suffix: string,
): Promise<string> {
  const id = `tool-repeated-${suffix}`;
  await session.query(
    `INSERT INTO ${q(schema, "nodes")} (
       "id", "namespace", "type", "name", "content", "data",
       "source_type", "source_id", "created_at", "updated_at"
     ) VALUES (
       $1, $2, 'tool_execution', 'Repeated provider call', NULL, $3::jsonb,
       'tool_execution', $1, $4::timestamptz, $4::timestamptz
     )`,
    [
      id,
      `tenant-${suffix}`,
      JSON.stringify({
        threadId: `thread-root-${suffix}`,
        messageId: `message-${suffix}`,
        agentId: `agent-${suffix}`,
        toolCallId: `call-${suffix}`,
        tool: { id: "lookup-retry", name: "Lookup retry" },
        args: { q: "retry" },
        status: "failed",
        error: { message: "legacy retry failed" },
      }),
      "2026-01-01T00:00:05.000Z",
    ],
  );
  return id;
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

Deno.test("A28 upgrade refuses schemas with unsupported legacy markers", async () => {
  const { db, session } = await createFixture();
  try {
    await session.query(
      `CREATE TABLE "asset_bodies" (
         "key" TEXT PRIMARY KEY,
         "media_type" TEXT NOT NULL,
         "body" TEXT NOT NULL
       )`,
    );
    const blocked = await assertRejects(() =>
      upgradeV1Schema(session, "public")
    );
    assert(blocked instanceof Error);
    assertStringIncludes(blocked.message, "unsupported tables");
    assertStringIncludes(blocked.message, "asset_bodies");
    const tables = await session.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'asset_bodies'`,
    );
    assertEquals(tables.rows.length, 1);
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
        mediaType: "application/json",
      }),
    });

    const asset = await session.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${q(schema, "nodes")} WHERE id = $1`,
      ["asset-unavailable"],
    );
    assertEquals(asset.rows[0]?.data.state, "failed");
    assertEquals(asset.rows[0]?.data.mediaType, "application/json");
    assertEquals(asset.rows[0]?.data.byteLength, 4);
    assertEquals(asset.rows[0]?.data.body, "null");
    assertEquals(
      (asset.rows[0]?.data.location as Record<string, unknown>).encoding,
      "json",
    );
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
    } finally {
      await readers.executor.shutdown();
    }
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade preserves non-UTF-8 legacy text assets as bytes", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("asset_non_utf8");
  const bytes = new Uint8Array([0xff, 0xfe, 0x2c, 0x61]);
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, "asset-non-utf8");
    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: () => ({
        body: bytes,
        mediaType: "text/csv",
      }),
    });

    const stored = await session.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${q(schema, "nodes")} WHERE id = $1`,
      ["asset-asset-non-utf8"],
    );
    assertEquals(
      (stored.rows[0]?.data.location as Record<string, unknown>).encoding,
      "base64",
    );

    assertEquals(stored.rows[0]?.data.mediaType, "text/csv");
    const encoded = String(stored.rows[0]?.data.body ?? "");
    assertEquals(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
      bytes,
    );
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
         '2026-01-01T00:00:00.000Z'::timestamptz +
           value * INTERVAL '1 microsecond',
         '2026-01-01T00:00:00.000Z'::timestamptz +
           value * INTERVAL '1 microsecond'
       FROM generate_series(1, 205) AS value`,
    );

    let resolved = 0;
    await upgradeV1Schema(emulatePostgresTimestampDecoding(session), schema, {
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

Deno.test("A28 upgrade isolates large LLM attempts in single-row pages", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("llm_attempt_pages");
  const pageSizes: number[] = [];
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, "llm-attempt-pages");
    await upgradeV1Schema(
      observeLlmAttemptPageSizes(session, pageSizes),
      schema,
      { resolveLegacyAsset: legacyAssetResolver("llm-attempt-pages") },
    );

    assert(pageSizes.length >= 2);
    assertEquals([...new Set(pageSizes)], [1]);
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade aligns a legacy message with its thread namespace", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("message_namespace");
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, "message-namespace");
    await session.query(
      `UPDATE ${q(schema, "nodes")}
       SET namespace = 'legacy-misrouted'
       WHERE id = 'message-message-namespace'`,
    );

    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: legacyAssetResolver("message-namespace"),
    });

    const message = await session.query<{
      namespace: string;
      data: Record<string, unknown>;
    }>(
      `SELECT namespace, data FROM ${q(schema, "nodes")}
       WHERE id = 'message-message-namespace'`,
    );
    assertEquals(message.rows[0]?.namespace, "tenant-message-namespace");
    const metadata = message.rows[0]?.data.metadata as Record<string, unknown>;
    const migrated = metadata.migratedFromV1 as Record<string, unknown>;
    assertEquals(migrated.originalNamespace, "legacy-misrouted");

    const outgoing = await session.query<{
      namespace: string;
    }>(
      `SELECT namespace FROM ${q(schema, "edges")}
       WHERE source_node_id = 'message-message-namespace'`,
    );
    assert(
      outgoing.rows.length > 0 &&
        outgoing.rows.every((edge) =>
          edge.namespace === "tenant-message-namespace"
        ),
    );
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
        [
          "edges",
          "event_bodies",
          "event_deliveries",
          "events",
          "nodes",
        ],
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
        assertEquals(
          (await readers.resolver.get(
            workflowContent(tool!, "tool.arguments")!,
            { namespace },
          ))
            .value,
          { q: "x" },
        );
        assertEquals(
          (await readers.resolver.get(
            workflowContent(tool!, "tool.output")!,
            { namespace },
          ))
            .value,
          { ok: true },
        );

        const attempt = await readers.attempts.get(
          namespace,
          `llm-${suffix}`,
        );
        assertEquals(attempt?.status, "completed");
        assertEquals(attempt?.participantId, agent?.id);
        assertEquals(
          (await readers.resolver.get(
            workflowContent(attempt!, "body")!,
            { namespace },
          ))
            .text,
          "legacy answer",
        );
        assertEquals(
          (await readers.resolver.get(workflowContent(attempt!, "reasoning")!, {
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

        const document = await readers.documents.get(
          namespace,
          `document-${suffix}`,
        );
        const documentSource = document?.source[0] as ContentRef | undefined;
        assertEquals(documentSource?.assetId, `asset-${suffix}`);
        assertEquals(document?.mediaType, "image/png");
        assertEquals(document?.threadId, `thread-root-${suffix}`);
        assertEquals(
          new TextDecoder().decode(
            (await readers.resolver.get(documentSource!, { namespace }))
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

Deno.test("A28 upgrade preserves repeated provider tool-call labels", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("repeated_tool_call");
  const suffix = "repeated-tool-call";
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, suffix);
    const repeatedId = await seedRepeatedLegacyToolCall(
      session,
      schema,
      suffix,
    );

    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: legacyAssetResolver(suffix),
    });

    const rows = await session.query<{
      id: string;
      source_type: string | null;
      source_id: string | null;
    }>(
      `SELECT id, source_type, source_id FROM ${q(schema, "nodes")}
       WHERE namespace = $1 AND type = 'tool_execution'
         AND data ->> 'toolCallId' = $2
       ORDER BY created_at, id`,
      [`tenant-${suffix}`, `call-${suffix}`],
    );
    assertEquals(rows.rows.map((row) => row.id), [
      `tool-${suffix}`,
      repeatedId,
    ]);
    assertEquals(
      rows.rows.map(({ source_type, source_id }) => ({
        source_type,
        source_id,
      })),
      [
        { source_type: null, source_id: null },
        { source_type: null, source_id: null },
      ],
    );

    const readers = await createV3Readers(session, schema);
    try {
      assertEquals(
        (await readers.tools.getByToolCallId(
          `tenant-${suffix}`,
          `thread-root-${suffix}`,
          `call-${suffix}`,
        ))?.id,
        repeatedId,
      );
      assertEquals(
        (await readers.tools.get(`tenant-${suffix}`, `tool-${suffix}`))
          ?.toolCallId,
        `call-${suffix}`,
      );
    } finally {
      await readers.executor.shutdown();
    }
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade preserves workflows whose legacy threads were deleted", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("orphan_workflows");
  const suffix = "orphan-workflows";
  const namespace = `tenant-${suffix}`;
  const missingThreadId = `thread-deleted-${suffix}`;
  const toolId = `tool-orphan-${suffix}`;
  const attemptId = `llm-orphan-${suffix}`;
  const noThreadAttemptId = `llm-no-thread-${suffix}`;
  const noThreadRecoveryId = `migration-orphan-thread:${noThreadAttemptId}`;
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, suffix);
    await session.query(
      `INSERT INTO ${q(schema, "nodes")} (
         id, namespace, type, name, content, data,
         source_type, source_id, created_at, updated_at
       ) VALUES
       (
         $1, $2, 'tool_execution', 'Orphan tool', NULL, $3::jsonb,
         'tool_execution', $1,
         '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:01.000Z'
       ),
       (
         $4, $2, 'llm_attempt', 'Orphan attempt', NULL, $5::jsonb,
         'llm_attempt', $4,
         '2026-01-01T00:01:02.000Z', '2026-01-01T00:01:03.000Z'
       ),
       (
         $6, $2, 'llm_attempt', 'Attempt without thread identity', NULL,
         $7::jsonb, 'llm_attempt', $6,
         '2026-01-01T00:01:04.000Z', '2026-01-01T00:01:05.000Z'
       )`,
      [
        toolId,
        namespace,
        JSON.stringify({
          threadId: missingThreadId,
          agentId: `agent-${suffix}`,
          toolCallId: `call-orphan-${suffix}`,
          tool: { id: "orphan-tool" },
          args: { preserved: true },
          output: { ok: true },
          status: "completed",
          metadata: { migratedFromV1: { retained: true } },
        }),
        attemptId,
        JSON.stringify({
          threadId: missingThreadId,
          agentId: `agent-${suffix}`,
          provider: "openai",
          model: "gpt-test",
          messages: [{ role: "user", content: "preserve me" }],
          answer: "preserved",
          status: "completed",
          metadata: { migratedFromV1: { retained: true } },
        }),
        noThreadAttemptId,
        JSON.stringify({
          agentId: `agent-${suffix}`,
          provider: "openai",
          model: "gpt-test",
          messages: [],
          answer: "also preserved",
          status: "completed",
        }),
      ],
    );
    await session.query(
      `INSERT INTO ${q(schema, "events")} (
         id, "threadId", "eventType", payload, namespace, status,
         metadata, "subjectType", "subjectId", "correlationId",
         "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, 'TOOL_RESULT', '{"status":"completed"}'::jsonb,
         $3, 'completed', '{}'::jsonb, 'tool_execution', $4,
         $1, '2026-01-01T00:01:06.000Z', '2026-01-01T00:01:06.000Z'
       )`,
      [
        `event-orphan-${suffix}`,
        missingThreadId,
        namespace,
        toolId,
      ],
    );

    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: legacyAssetResolver(suffix),
    });

    const readers = await createV3Readers(session, schema);
    try {
      const recovered = await readers.conversation.getThread(
        namespace,
        missingThreadId,
      );
      assertEquals(recovered?.status, "archived");
      assertEquals(recovered?.lastEventId, `event-orphan-${suffix}`);
      assertEquals(recovered?.metadata, {
        migratedFromV1: {
          orphanRecovery: true,
          originalThreadId: missingThreadId,
        },
      });

      const tool = await readers.tools.get(namespace, toolId);
      const attempt = await readers.attempts.get(namespace, attemptId);
      const noThreadAttempt = await readers.attempts.get(
        namespace,
        noThreadAttemptId,
      );
      assertEquals(tool?.threadId, missingThreadId);
      assertEquals(attempt?.threadId, missingThreadId);
      assertEquals(noThreadAttempt?.threadId, noThreadRecoveryId);
      for (const workflow of [tool, attempt]) {
        const migrated = workflow?.metadata.migratedFromV1 as
          | Record<string, unknown>
          | undefined;
        assertEquals(migrated?.retained, true);
        assertEquals(migrated?.orphanRecovery, {
          reason: "missing_thread",
          originalThreadId: missingThreadId,
          recoveredThreadId: missingThreadId,
        });
      }
      assertEquals(
        (noThreadAttempt?.metadata.migratedFromV1 as Record<string, unknown>)
          .orphanRecovery,
        {
          reason: "missing_thread_id",
          originalThreadId: null,
          recoveredThreadId: noThreadRecoveryId,
        },
      );

      const tombstones = await session.query<{
        id: string;
        status: string;
      }>(
        `SELECT id, data ->> 'status' AS status
         FROM ${q(schema, "nodes")}
         WHERE namespace = $1 AND source_type = 'migration_orphan_thread'
         ORDER BY id`,
        [namespace],
      );
      assertEquals(
        tombstones.rows,
        [
          { id: noThreadRecoveryId, status: "archived" },
          { id: missingThreadId, status: "archived" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    } finally {
      await readers.executor.shutdown();
    }
  } finally {
    await db.close();
  }
});

Deno.test("A28 upgrade preserves null and partial LLM content", async () => {
  const { db, session } = await createFixture();
  const schema = uniqueSchema("null_llm_content");
  const suffix = "null-llm-content";
  try {
    await provisionV1FixtureSchema(session, schema);
    await seedLegacyTenant(session, schema, suffix);
    const attemptId = `llm-${suffix}`;
    const legacy = await session.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${q(schema, "nodes")} WHERE id = $1`,
      [attemptId],
    );
    const data: Record<string, unknown> = {
      ...legacy.rows[0]!.data,
      answer: null,
      reasoning: null,
      partialReasoning: "legacy partial thought",
    };
    delete data.partialAnswer;
    await session.query(
      `UPDATE ${q(schema, "nodes")} SET data = $2::jsonb WHERE id = $1`,
      [attemptId, JSON.stringify(data)],
    );

    await upgradeV1Schema(session, schema, {
      resolveLegacyAsset: legacyAssetResolver(suffix),
    });

    const readers = await createV3Readers(session, schema);
    try {
      const attempt = await readers.attempts.get(
        `tenant-${suffix}`,
        attemptId,
      );
      assertEquals(attempt?.status, "completed");
      assertEquals(
        (await readers.resolver.get(workflowContent(attempt!, "body")!, {
          namespace: `tenant-${suffix}`,
        })).value,
        null,
      );
      assertEquals(
        (await readers.resolver.get(workflowContent(attempt!, "reasoning")!, {
          namespace: `tenant-${suffix}`,
        })).text,
        "legacy partial thought",
      );
    } finally {
      await readers.executor.shutdown();
    }
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
      await seedRepeatedLegacyToolCall(session, schema, "postgres");
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
      const repeatedCalls = await session.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM ${q(schema, "nodes")}
         WHERE type = 'tool_execution'
           AND data ->> 'toolCallId' = 'call-postgres'`,
      );
      assertEquals(Number(repeatedCalls.rows[0]?.count), 2);
    } finally {
      await session.query(
        `DROP SCHEMA IF EXISTS ${quoteEventIdentifier(schema)} CASCADE`,
      ).catch(() => undefined);
      await db.close();
    }
  },
});
