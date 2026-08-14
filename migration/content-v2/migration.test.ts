import { assertEquals, assertRejects } from "@std/assert";
import {
  createCoreSchemaStatements,
  createSqlSession,
} from "../../runtime/events/index.ts";
import {
  createMemoryAssetBodyStore,
  digestContent,
} from "../../runtime/content/index.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { migrateContentV2Schema } from "./index.ts";

const SCHEMA = "copilotz_content_v2";

function q(table: string): string {
  return `"${SCHEMA}"."${table}"`;
}

Deno.test("content-v2 repairs tool messages, extracts data URLs, relocates bodies, and reruns idempotently", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    await session.query(
      `INSERT INTO ${q("nodes")} (id, namespace, type, name, data) VALUES
       ('thread-a', 'tenant-a', 'thread', 'Thread', $1::jsonb),
       ('agent-a', 'tenant-a', 'participant', 'Agent', $2::jsonb),
       ('legacy-body', 'tenant-a', 'asset', 'text/plain', $3::jsonb),
       ('message-tool', 'tenant-a', 'message', 'Tool', $4::jsonb),
       ('execution-a', 'tenant-a', 'tool_execution', 'browser', $5::jsonb)`,
      [
        JSON.stringify({ threadId: "thread-a", metadata: {} }),
        JSON.stringify({
          externalId: "north",
          participantType: "agent",
          metadata: {},
        }),
        JSON.stringify({
          mediaType: "text/plain",
          byteLength: 6,
          digest:
            "sha256:c49fea7425fa7f8699897a97c159c6690267d9003bb78c53fafa8fc15c325d84",
          state: "ready",
          location: { kind: "database", encoding: "utf8" },
          body: "legacy",
          readyAt: "2026-08-01T00:00:00.000Z",
          metadata: { migratedFromV1: { ownerId: "message-tool" } },
        }),
        JSON.stringify({
          threadId: "thread-a",
          senderId: "agent-a",
          recipientIds: [],
          content: [{
            assetId: "legacy-body",
            kind: "text",
            role: "body",
            mediaType: "text/plain",
          }],
          metadata: {
            migratedFromV1: { senderType: "tool", senderId: "agent-a" },
            toolCalls: [{
              id: "call-a",
              tool: { id: "browser", name: "Browser" },
              args: { action: "screenshot" },
              output: {
                ok: true,
                imageUrl: "data:image/png;base64,iVBORw0KGgo=",
              },
              status: "completed",
              visibility: "public_status",
            }],
          },
        }),
        JSON.stringify({
          threadId: "thread-a",
          messageId: null,
          participantId: "agent-a",
          agentId: "north",
          toolCallId: "call-a",
          tool: { id: "browser", name: "Browser" },
          status: "running",
          content: [],
          historyVisibility: "public_status",
          startedAt: "2026-08-01T00:00:00.000Z",
          metadata: { migratedFromV1: {} },
        }),
      ],
    );
    await session.query(
      `INSERT INTO ${q("edges")} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES
       ('edge-message', 'tenant-a', 'thread-a', 'message-tool', 'has_message', '{}', 1),
       ('edge-body', 'tenant-a', 'message-tool', 'legacy-body', 'has_asset', '{}', 1),
       ('edge-tool', 'tenant-a', 'thread-a', 'execution-a', 'has_tool_execution', '{}', 1)`,
    );
    await session.query(
      `INSERT INTO ${q("events")} (
         id, schema_version, type, namespace, thread_id,
         subject_type, subject_id, payload, metadata, correlation_id
       ) VALUES (
         'event-message', 3, 'message.created', 'tenant-a', 'thread-a',
         'message', 'message-tool', '{"messageId":"message-tool"}',
         '{"migratedFromV1":true}', 'event-message'
       )`,
    );

    const dryRun = await migrateContentV2Schema(session, SCHEMA);
    assertEquals(dryRun.candidateMessages, 1);
    assertEquals(dryRun.mergedExecutions, 1);
    assertEquals(dryRun.extractedAssets, 1);
    assertEquals(dryRun.deletedMessages, 1);
    assertEquals(dryRun.databaseAssets, 3);

    const memory = createMemoryAssetBodyStore({ backendId: "gcs:test" });
    const store = Object.freeze({ ...memory, kind: "object" as const });
    const first = await migrateContentV2Schema(session, SCHEMA, {
      mode: "apply",
      assets: {
        storage: { type: "custom", config: { store, prefix: "copilotz" } },
      },
    });
    assertEquals(first.mergedExecutions, 1);
    assertEquals(first.synthesizedExecutions, 0);
    assertEquals(first.extractedAssets, 1);
    assertEquals(first.deletedMessages, 1);
    assertEquals(first.deletedDuplicateEvents, 1);
    assertEquals(first.failures, []);

    const message = await session.query(
      `SELECT id FROM ${q("nodes")} WHERE id = 'message-tool'`,
    );
    assertEquals(message.rows.length, 0);
    const execution = await session.query<{ data: unknown }>(
      `SELECT data FROM ${q("nodes")} WHERE id = 'execution-a'`,
    );
    const executionData = execution.rows[0].data as Record<string, unknown>;
    assertEquals(executionData.status, "completed");
    const stored = await session.query<{ data: unknown }>(
      `SELECT data FROM ${q("nodes")} WHERE type = 'asset' ORDER BY id`,
    );
    assertEquals(
      stored.rows.every((row) =>
        (row.data as { location: { kind: string } }).location.kind === "object"
      ),
      true,
    );
    assertEquals(JSON.stringify(executionData).includes("data:image"), false);

    const second = await migrateContentV2Schema(session, SCHEMA, {
      mode: "apply",
      assets: {
        storage: { type: "custom", config: { store, prefix: "copilotz" } },
      },
    });
    assertEquals(second.candidateMessages, 0);
    assertEquals(second.uploadedObjects, 0);
  } finally {
    await db.close();
  }
});

Deno.test("content-v2 sanitizes existing canonical tool outputs without duplicate messages", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    const rawOutput = JSON.stringify({
      ok: true,
      imageUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    const bytes = new TextEncoder().encode(rawOutput);
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, source_type, source_id
       ) VALUES
       ('thread-existing', 'tenant-a', 'thread', 'Thread', '{}', NULL, NULL),
       ('raw-output', 'tenant-a', 'asset', 'application/json', $1::jsonb,
         'asset_idempotency', 'execution-existing:tool.output'),
       ('execution-existing', 'tenant-a', 'tool_execution', 'browser', $2::jsonb,
         'tool_call', '["thread-existing","call-existing"]')`,
      [
        JSON.stringify({
          mediaType: "application/json",
          byteLength: bytes.byteLength,
          digest: await digestContent(bytes),
          state: "ready",
          location: { kind: "database", encoding: "json" },
          body: rawOutput,
          readyAt: "2026-08-01T00:00:00.000Z",
          metadata: {},
        }),
        JSON.stringify({
          threadId: "thread-existing",
          toolCallId: "call-existing",
          tool: { id: "browser" },
          status: "completed",
          content: [{
            assetId: "raw-output",
            kind: "json",
            role: "tool.output",
            mediaType: "application/json",
          }],
          startedAt: "2026-08-01T00:00:00.000Z",
          finishedAt: "2026-08-01T00:00:01.000Z",
          metadata: {},
        }),
      ],
    );
    await session.query(
      `INSERT INTO ${q("edges")} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES (
         'edge-existing-output', 'tenant-a', 'execution-existing',
         'raw-output', 'has_asset', '{}', 1
       )`,
    );

    const dryRun = await migrateContentV2Schema(session, SCHEMA);
    assertEquals(dryRun.candidateMessages, 0);
    assertEquals(dryRun.extractedAssets, 1);
    assertEquals(dryRun.databaseAssets, 2);

    const memory = createMemoryAssetBodyStore({ backendId: "gcs:existing" });
    const store = Object.freeze({ ...memory, kind: "object" as const });
    const applied = await migrateContentV2Schema(session, SCHEMA, {
      mode: "apply",
      assets: {
        storage: { type: "custom", config: { store, prefix: "copilotz" } },
      },
    });
    assertEquals(applied.extractedAssets, 1);
    const execution = await session.query<{ data: unknown }>(
      `SELECT data FROM ${q("nodes")} WHERE id = 'execution-existing'`,
    );
    assertEquals(
      JSON.stringify(execution.rows[0].data).includes("data:image"),
      false,
    );
    assertEquals(
      (execution.rows[0].data as { content: unknown[] }).content.length,
      2,
    );
    assertEquals(
      (await session.query(
        `SELECT id FROM ${q("nodes")} WHERE id = 'raw-output'`,
      )).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

Deno.test("content-v2 disambiguates a reused tool-call ID by canonical output digest", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    const matchingOutput = JSON.stringify({ ok: true, value: "matching" });
    const otherOutput = JSON.stringify({ ok: true, value: "other" });
    const matchingBytes = new TextEncoder().encode(matchingOutput);
    const otherBytes = new TextEncoder().encode(otherOutput);
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, created_at, updated_at
       ) VALUES
       ('thread-reused', 'tenant-a', 'thread', 'Thread', '{}',
         '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
       ('agent-reused', 'tenant-a', 'participant', 'Agent', $1::jsonb,
         '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
       ('output-matching', 'tenant-a', 'asset', 'application/json', $2::jsonb,
         '2026-08-01T00:00:01Z', '2026-08-01T00:00:01Z'),
       ('output-other', 'tenant-a', 'asset', 'application/json', $3::jsonb,
         '2026-08-01T00:08:01Z', '2026-08-01T00:08:01Z'),
       ('message-reused', 'tenant-a', 'message', 'Tool', $4::jsonb,
         '2026-08-01T00:00:10Z', '2026-08-01T00:00:11Z'),
       ('execution-matching', 'tenant-a', 'tool_execution', 'sandbox', $5::jsonb,
         '2026-08-01T00:00:01Z', '2026-08-01T00:00:09Z'),
       ('execution-other', 'tenant-a', 'tool_execution', 'sandbox', $6::jsonb,
         '2026-08-01T00:08:01Z', '2026-08-01T00:08:09Z')`,
      [
        JSON.stringify({ externalId: "east", participantType: "agent" }),
        JSON.stringify({
          mediaType: "application/json",
          byteLength: matchingBytes.byteLength,
          digest: await digestContent(matchingBytes),
          state: "ready",
          location: { kind: "database", encoding: "json" },
          body: matchingOutput,
          readyAt: "2026-08-01T00:00:01Z",
        }),
        JSON.stringify({
          mediaType: "application/json",
          byteLength: otherBytes.byteLength,
          digest: await digestContent(otherBytes),
          state: "ready",
          location: { kind: "database", encoding: "json" },
          body: otherOutput,
          readyAt: "2026-08-01T00:08:01Z",
        }),
        JSON.stringify({
          threadId: "thread-reused",
          metadata: {
            migratedFromV1: {
              senderType: "tool",
              senderId: "agent-reused",
            },
            toolCalls: [{
              id: "call-reused",
              tool: { id: "sandbox" },
              output: { ok: true, value: "matching" },
              status: "completed",
            }],
          },
        }),
        JSON.stringify({
          threadId: "thread-reused",
          participantId: "agent-reused",
          agentId: "east",
          toolCallId: "call-reused",
          tool: { id: "sandbox" },
          status: "completed",
          content: [{
            assetId: "output-matching",
            kind: "json",
            role: "tool.output",
            mediaType: "application/json",
          }],
          startedAt: "2026-08-01T00:00:01Z",
          finishedAt: "2026-08-01T00:00:09Z",
          metadata: {},
        }),
        JSON.stringify({
          threadId: "thread-reused",
          participantId: "agent-reused",
          agentId: "east",
          toolCallId: "call-reused",
          tool: { id: "sandbox" },
          status: "completed",
          content: [{
            assetId: "output-other",
            kind: "json",
            role: "tool.output",
            mediaType: "application/json",
          }],
          startedAt: "2026-08-01T00:08:01Z",
          finishedAt: "2026-08-01T00:08:09Z",
          metadata: {},
        }),
      ],
    );
    await session.query(
      `INSERT INTO ${q("edges")} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES
       ('edge-output-matching', 'tenant-a', 'execution-matching',
         'output-matching', 'has_asset', '{}', 1),
       ('edge-output-other', 'tenant-a', 'execution-other',
         'output-other', 'has_asset', '{}', 1)`,
    );

    const dryRun = await migrateContentV2Schema(session, SCHEMA);
    assertEquals(dryRun.mergedExecutions, 1);
    assertEquals(dryRun.synthesizedExecutions, 0);

    const memory = createMemoryAssetBodyStore({ backendId: "gcs:test" });
    const report = await migrateContentV2Schema(session, SCHEMA, {
      mode: "apply",
      assets: {
        storage: {
          type: "custom",
          config: {
            store: Object.freeze({ ...memory, kind: "object" as const }),
          },
        },
      },
    });
    assertEquals(report.mergedExecutions, 1);
    const executions = await session.query<{ id: string; data: unknown }>(
      `SELECT id, data FROM ${q("nodes")}
       WHERE type = 'tool_execution' ORDER BY id`,
    );
    const byId = new Map(executions.rows.map((row) => [row.id, row.data]));
    assertEquals(
      ((byId.get("execution-matching") as Record<string, unknown>).metadata as {
        migratedFromV1: { legacyToolMessageId: string };
      }).migratedFromV1.legacyToolMessageId,
      "message-reused",
    );
    assertEquals(
      JSON.stringify(byId.get("execution-other")).includes("message-reused"),
      false,
    );
  } finally {
    await db.close();
  }
});

Deno.test("content-v2 disambiguates a reused failed tool call by canonical error digest", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    const errorValue = { code: "sandbox_failed", message: "command failed" };
    const errorBody = JSON.stringify(errorValue);
    const errorBytes = new TextEncoder().encode(errorBody);
    const execution = (content: unknown[]) =>
      JSON.stringify({
        threadId: "thread-error-reused",
        participantId: "agent-error-reused",
        toolCallId: "call-error-reused",
        tool: { id: "sandbox" },
        status: "failed",
        content,
        startedAt: "2026-08-01T00:00:01Z",
        finishedAt: "2026-08-01T00:00:02Z",
        metadata: {},
      });
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, created_at, updated_at
       ) VALUES
       ('thread-error-reused', 'tenant-a', 'thread', 'Thread', '{}', NOW(), NOW()),
       ('agent-error-reused', 'tenant-a', 'participant', 'Agent', '{}', NOW(), NOW()),
       ('error-matching', 'tenant-a', 'asset', 'application/json', $1::jsonb, NOW(), NOW()),
       ('message-error-reused', 'tenant-a', 'message', 'Tool', $2::jsonb,
         '2026-08-01T00:00:03Z', '2026-08-01T00:00:04Z'),
       ('execution-error-matching', 'tenant-a', 'tool_execution', 'sandbox', $3::jsonb,
         '2026-08-01T00:00:01Z', '2026-08-01T00:00:02Z'),
       ('execution-error-other', 'tenant-a', 'tool_execution', 'sandbox', $4::jsonb,
         '2026-08-01T00:00:01Z', '2026-08-01T00:00:02Z')`,
      [
        JSON.stringify({
          mediaType: "application/json",
          byteLength: errorBytes.byteLength,
          digest: await digestContent(errorBytes),
          state: "ready",
          location: { kind: "database", encoding: "json" },
          body: errorBody,
          readyAt: "2026-08-01T00:00:02Z",
        }),
        JSON.stringify({
          threadId: "thread-error-reused",
          metadata: {
            migratedFromV1: {
              senderType: "tool",
              senderId: "agent-error-reused",
            },
            toolCalls: [{
              id: "call-error-reused",
              tool: { id: "sandbox" },
              error: errorValue,
              status: "failed",
            }],
          },
        }),
        execution([{
          assetId: "error-matching",
          kind: "json",
          role: "tool.error_detail",
          mediaType: "application/json",
        }]),
        execution([]),
      ],
    );
    await session.query(
      `INSERT INTO ${q("edges")} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES ('edge-error-matching', 'tenant-a',
         'execution-error-matching', 'error-matching', 'has_asset', '{}', 1)`,
    );

    const dryRun = await migrateContentV2Schema(session, SCHEMA);
    assertEquals(dryRun.mergedExecutions, 1);
    assertEquals(dryRun.synthesizedExecutions, 0);
  } finally {
    await db.close();
  }
});

Deno.test("content-v2 aborts ambiguous tool-message repair without partial writes", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    const execution = JSON.stringify({
      threadId: "thread-ambiguous",
      toolCallId: "call-ambiguous",
      tool: { id: "browser" },
      status: "completed",
      content: [],
      metadata: {},
    });
    await session.query(
      `INSERT INTO ${q("nodes")} (id, namespace, type, name, data) VALUES
       ('thread-ambiguous', 'tenant-a', 'thread', 'Thread', '{}'),
       ('message-ambiguous', 'tenant-a', 'message', 'Tool', $1::jsonb),
       ('execution-one', 'tenant-a', 'tool_execution', 'browser', $2::jsonb),
       ('execution-two', 'tenant-a', 'tool_execution', 'browser', $2::jsonb)`,
      [
        JSON.stringify({
          threadId: "thread-ambiguous",
          content: [],
          metadata: {
            migratedFromV1: { senderType: "tool" },
            toolCalls: [{
              id: "call-ambiguous",
              tool: { id: "browser" },
              output: { ok: true },
            }],
          },
        }),
        execution,
      ],
    );
    await assertRejects(
      () => migrateContentV2Schema(session, SCHEMA),
      Error,
      "migration refuses to guess",
    );
    assertEquals(
      (await session.query(
        `SELECT id FROM ${q("nodes")} WHERE id = 'message-ambiguous'`,
      )).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
