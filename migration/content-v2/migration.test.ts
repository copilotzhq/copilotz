import { assertEquals, assertRejects } from "@std/assert";
import {
  createCoreSchemaStatements,
  createSqlSession,
} from "../../runtime/events/index.ts";
import type { SqlSession } from "../../runtime/events/index.ts";
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

    let dryRunQueries = 0;
    let dryRunTransactions = 0;
    const readOnlySession: SqlSession = {
      query(sql, params) {
        dryRunQueries++;
        return session.query(sql, params);
      },
      transaction() {
        dryRunTransactions++;
        throw new Error("dry-run must not open a write transaction");
      },
    };
    const dryRun = await migrateContentV2Schema(readOnlySession, SCHEMA);
    assertEquals(dryRun.candidateMessages, 1);
    assertEquals(dryRun.mergedExecutions, 1);
    assertEquals(dryRun.extractedAssets, 1);
    assertEquals(dryRun.deletedMessages, 1);
    assertEquals(dryRun.databaseAssets, 3);
    assertEquals(dryRunTransactions, 0);
    assertEquals(dryRunQueries <= 20, true);

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

Deno.test("content-v2 bounds asset batches by body bytes and upload concurrency", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    for (let index = 1; index <= 4; index++) {
      const body = `asset-${index}`;
      const bytes = new TextEncoder().encode(body);
      await session.query(
        `INSERT INTO ${q("nodes")} (
           id, namespace, type, name, data
         ) VALUES ($1, 'tenant-a', 'asset', 'text/plain', $2::jsonb)`,
        [
          `asset-${index}`,
          JSON.stringify({
            mediaType: "text/plain",
            byteLength: bytes.byteLength,
            digest: await digestContent(bytes),
            state: "ready",
            location: { kind: "database", encoding: "utf8" },
            body,
            readyAt: "2026-08-01T00:00:00.000Z",
            metadata: {},
          }),
        ],
      );
    }
    const memory = createMemoryAssetBodyStore({ backendId: "gcs:bounded" });
    let active = 0;
    let maximumActive = 0;
    const store = Object.freeze({
      ...memory,
      kind: "object" as const,
      async put(input: Parameters<typeof memory.put>[0]) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await memory.put(input);
        } finally {
          active--;
        }
      },
    });
    let metadataPageQueries = 0;
    let bodyBatchQueries = 0;
    const observedSession: SqlSession = {
      query(sql, params) {
        if (
          sql.includes("SELECT id, namespace, data - 'body' AS data")
        ) {
          metadataPageQueries++;
        }
        if (
          sql.includes("asset.data ->> 'body' AS body") &&
          sql.includes("UNNEST($1::text[], $2::text[])")
        ) {
          bodyBatchQueries++;
        }
        return session.query(sql, params);
      },
      transaction: (operation) => session.transaction(operation),
    };
    const report = await migrateContentV2Schema(observedSession, SCHEMA, {
      mode: "apply",
      batchSize: 4,
      uploadConcurrency: 4,
      bodyBatchMaxBytes: 14,
      assets: {
        storage: { type: "custom", config: { store, prefix: "copilotz" } },
      },
    });
    assertEquals(report.uploadedObjects, 4);
    assertEquals(maximumActive, 2);
    assertEquals(metadataPageQueries, 2);
    assertEquals(bodyBatchQueries, 2);
    const remaining = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${q("nodes")}
       WHERE type = 'asset'
         AND data -> 'location' ->> 'kind' = 'database'`,
    );
    assertEquals(Number(remaining.rows[0].count), 0);
  } finally {
    await db.close();
  }
});

Deno.test("content-v2 apply commits semantic repair in resumable batches", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    await session.query(
      `INSERT INTO ${q("nodes")} (id, namespace, type, name, data) VALUES
       ('thread-batches', 'tenant-a', 'thread', 'Thread', '{}'),
       ('agent-batches', 'tenant-a', 'participant', 'Agent', '{}'),
       ('message-batch-1', 'tenant-a', 'message', 'Tool', $1::jsonb),
       ('message-batch-2', 'tenant-a', 'message', 'Tool', $2::jsonb)`,
      [1, 2].map((index) =>
        JSON.stringify({
          threadId: "thread-batches",
          senderId: "agent-batches",
          metadata: {
            migratedFromV1: {
              senderType: "tool",
              senderId: "agent-batches",
            },
            toolCalls: [{
              id: `call-batch-${index}`,
              tool: { id: "lookup" },
              args: { index },
              output: { ok: true, index },
              status: "completed",
            }],
          },
        })
      ),
    );
    const memory = createMemoryAssetBodyStore({ backendId: "gcs:batches" });
    const semanticProgress: number[] = [];
    const report = await migrateContentV2Schema(session, SCHEMA, {
      mode: "apply",
      semanticBatchSize: 1,
      assets: {
        storage: {
          type: "custom",
          config: {
            store: Object.freeze({ ...memory, kind: "object" as const }),
          },
        },
      },
      onProgress(progress) {
        if (progress.stage === "semantic") {
          semanticProgress.push(progress.processed);
        }
      },
    });
    assertEquals(report.candidateMessages, 2);
    assertEquals(report.synthesizedExecutions, 2);
    assertEquals(report.deletedMessages, 2);
    assertEquals(semanticProgress, [1, 2]);
    assertEquals(
      Number(
        (await session.query<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM ${q("nodes")}
         WHERE type = 'message'`,
        )).rows[0].count,
      ),
      0,
    );
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
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, source_type, source_id
       )
       SELECT 'decoy-' || LPAD(value::text, 4, '0'),
         'tenant-a', 'tool_execution', 'decoy',
         jsonb_build_object(
           'threadId', 'thread-existing',
           'toolCallId', 'decoy-' || value::text,
           'tool', jsonb_build_object('id', 'decoy'),
           'status', 'completed',
           'content', '[]'::jsonb,
           'startedAt', '2026-08-01T00:00:00.000Z',
           'finishedAt', '2026-08-01T00:00:01.000Z',
           'metadata', '{}'::jsonb
         ),
         'tool_call', 'decoy-' || value::text
       FROM generate_series(1, 501) AS value`,
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

Deno.test("content-v2 dry-run keeps SQL and memory pages bounded at scale", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    await session.query(
      `INSERT INTO ${q("nodes")} (id, namespace, type, name, data) VALUES
       ('thread-scale', 'tenant-a', 'thread', 'Thread', '{}'),
       ('agent-scale', 'tenant-a', 'participant', 'Agent', '{}')`,
    );
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, created_at, updated_at
       )
       SELECT 'message-scale-' || LPAD(value::text, 4, '0'),
         'tenant-a', 'message', 'Tool',
         jsonb_build_object(
           'threadId', 'thread-scale',
           'senderId', 'agent-scale',
           'metadata', jsonb_build_object(
             'migratedFromV1', jsonb_build_object(
               'senderType', 'tool', 'senderId', 'agent-scale'
             ),
             'toolCalls', jsonb_build_array(jsonb_build_object(
               'id', 'call-scale-' || value::text,
               'tool', jsonb_build_object('id', 'lookup'),
               'args', jsonb_build_object('index', value),
               'output', jsonb_build_object('ok', true, 'index', value),
               'status', 'completed'
             ))
           )
         ), NOW(), NOW()
       FROM generate_series(1, 1000) AS value`,
    );
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, source_type, source_id
       )
       SELECT 'execution-scale-' || LPAD(value::text, 4, '0'),
         'tenant-a', 'tool_execution', 'lookup',
         jsonb_build_object(
           'threadId', 'thread-scale',
           'participantId', 'agent-scale',
           'toolCallId', 'call-scale-' || value::text,
           'tool', jsonb_build_object('id', 'lookup'),
           'status', 'completed', 'content', '[]'::jsonb,
           'metadata', '{}'::jsonb
         ), 'tool_call', 'call-scale-' || value::text
       FROM generate_series(1, 1000) AS value`,
    );

    let queryCount = 0;
    const countedSession: SqlSession = {
      query(sql, params) {
        queryCount++;
        return session.query(sql, params);
      },
      transaction() {
        throw new Error("scaled dry-run must remain read-only");
      },
    };
    const report = await migrateContentV2Schema(countedSession, SCHEMA, {
      semanticBatchSize: 100,
    });
    assertEquals(report.candidateMessages, 1000);
    assertEquals(report.mergedExecutions, 1000);
    assertEquals(report.deletedMessages, 1000);
    assertEquals(queryCount <= 100, true);
  } finally {
    await db.close();
  }
});

Deno.test("content-v2 applies independent messages with bounded semantic concurrency", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  try {
    for (const statement of createCoreSchemaStatements(SCHEMA)) {
      await session.query(statement);
    }
    await session.query(
      `INSERT INTO ${q("nodes")} (id, namespace, type, name, data)
       VALUES ('agent-concurrent', 'tenant-a', 'participant', 'Agent', '{}')`,
    );
    await session.query(
      `INSERT INTO ${q("nodes")} (id, namespace, type, name, data)
       SELECT 'thread-concurrent-' || value::text,
         'tenant-a', 'thread', 'Thread', '{}'
       FROM generate_series(1, 8) AS value`,
    );
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, created_at, updated_at
       )
       SELECT 'message-concurrent-' || value::text,
         'tenant-a', 'message', 'Tool',
         jsonb_build_object(
           'threadId', 'thread-concurrent-' || value::text,
           'senderId', 'agent-concurrent',
           'metadata', jsonb_build_object(
             'migratedFromV1', jsonb_build_object(
               'senderType', 'tool', 'senderId', 'agent-concurrent'
             ),
             'toolCalls', jsonb_build_array(jsonb_build_object(
               'id', 'call-concurrent-' || value::text,
               'tool', jsonb_build_object('id', 'lookup'),
               'args', jsonb_build_object('index', value),
               'output', jsonb_build_object('ok', true, 'index', value),
               'status', 'completed'
             ))
           )
         ), NOW(), NOW()
       FROM generate_series(1, 8) AS value`,
    );
    await session.query(
      `INSERT INTO ${q("nodes")} (
         id, namespace, type, name, data, source_type, source_id
       )
       SELECT 'execution-concurrent-' || value::text,
         'tenant-a', 'tool_execution', 'lookup',
         jsonb_build_object(
           'threadId', 'thread-concurrent-' || value::text,
           'participantId', 'agent-concurrent',
           'toolCallId', 'call-concurrent-' || value::text,
           'tool', jsonb_build_object('id', 'lookup'),
           'status', 'completed', 'content', '[]'::jsonb,
           'metadata', '{}'::jsonb
         ), 'tool_call', 'call-concurrent-' || value::text
       FROM generate_series(1, 8) AS value`,
    );

    const memory = createMemoryAssetBodyStore({ backendId: "gcs:concurrent" });
    const progress: number[] = [];
    let transactionCount = 0;
    const countedSession: SqlSession = {
      query: (sql, params) => session.query(sql, params),
      transaction(operation) {
        transactionCount++;
        return session.transaction(operation);
      },
    };
    const report = await migrateContentV2Schema(countedSession, SCHEMA, {
      mode: "apply",
      semanticBatchSize: 2,
      semanticConcurrency: 2,
      assets: {
        storage: {
          type: "custom",
          config: {
            store: Object.freeze({ ...memory, kind: "object" as const }),
            prefix: "copilotz",
          },
        },
      },
      onProgress(event) {
        if (event.stage === "semantic") progress.push(event.processed);
      },
    });
    assertEquals(report.candidateMessages, 8);
    assertEquals(report.mergedExecutions, 8);
    assertEquals(report.failures, []);
    assertEquals(progress.at(-1), 8);
    // Two-message claims need fewer semantic commits than the old one-message
    // worker loop; the count also includes finalization and asset relocation.
    assertEquals(transactionCount < 10, true);
    assertEquals(
      (await session.query(
        `SELECT id FROM ${q("nodes")} WHERE type = 'message'`,
      )).rows.length,
      0,
    );
    assertEquals(
      (await session.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = $1
           AND indexname LIKE '_copilotz_content_v2_%'`,
        [SCHEMA],
      )).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
