/**
 * Explicit, one-way Copilotz v1 database upgrade.
 *
 * This module is isolated from the normal runtime and is only loaded through
 * the `@copilotz/copilotz/migration/v1` export.
 */

import { Ominipg } from "omnipg";
import { resolveAutoProviders } from "omnipg/auto";
import { ulid } from "ulid";
import type { DatabaseConfig } from "@/database/database.ts";
import { DatabaseSession, type SqlTransaction } from "@/database/session.ts";
import {
  quoteIdentifier,
  v2BaselineSql,
  validateSchemaName,
} from "@/database/v2-schema.ts";

interface LegacyThreadRow extends Record<string, unknown> {
  id: string;
  namespace: string | null;
  name: string;
  external_id: string | null;
  description: string | null;
  participants: unknown;
  mode: string;
  status: string;
  summary: string | null;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  last_event_id: string | null;
  last_event_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface LegacyEventRow extends Record<string, unknown> {
  id: string;
  thread_id: string;
  event_type: string;
  payload: unknown;
  parent_event_id: string | null;
  trace_id: string | null;
  namespace: string | null;
  subject_type: string | null;
  subject_id: string | null;
  operation: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  dedupe_key: string | null;
  input: unknown;
  before: unknown;
  after: unknown;
  patch: unknown;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
}

export interface UpgradeV1Options {
  database?: DatabaseConfig;
  /** Defaults to every application schema containing a v1 event table. */
  schemas?: readonly string[];
}

export interface UpgradeV1SchemaResult {
  schema: string;
  threads: number;
  participants: number;
  events: number;
}

const EPHEMERAL_TYPES = new Set([
  "TOKEN",
  "TOOL_CALL_DELTA",
  "TEXT_DELTA",
  "REASONING_DELTA",
  "AUDIO_DELTA",
  "text.delta",
  "reasoning.delta",
  "audio.delta",
  "tool_call.delta",
]);

function q(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return [];
  try {
    return stringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function eventType(row: LegacyEventRow): string {
  if (row.event_type.includes(".")) return row.event_type.toLowerCase();
  switch (row.event_type) {
    case "NEW_MESSAGE":
      return "message.created";
    case "LLM_CALL":
      return "llm_attempt.created";
    case "LLM_RESULT":
      return objectOf(row.payload).status === "failed"
        ? "llm_attempt.failed"
        : "llm_attempt.completed";
    case "TOOL_CALL":
      return "tool_execution.created";
    case "TOOL_RESULT":
      return objectOf(row.payload).status === "failed"
        ? "tool_execution.failed"
        : "tool_execution.completed";
    default:
      return row.event_type.toLowerCase().replaceAll("_", ".");
  }
}

async function tableExists(
  query: SqlTransaction,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await query.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) AS exists`,
    [schema, table],
  );
  return result.rows[0]?.exists === true;
}

async function legacySchemas(session: DatabaseSession): Promise<string[]> {
  const result = await session.query<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.columns
     WHERE table_name = 'events'
       AND column_name IN ('eventType', 'event_type')
     ORDER BY table_schema`,
  );
  return [...new Set(result.rows.map((row) => row.table_schema))];
}

async function assertDrained(
  session: DatabaseSession,
  schema: string,
): Promise<void> {
  const active = await session.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${q(schema, "events")}
     WHERE status IN ('pending', 'processing')`,
  );
  if (Number(active.rows[0]?.count ?? 0) > 0) {
    throw new Error(
      `Refusing to upgrade '${schema}': legacy work is pending or processing.`,
    );
  }
  if (await tableExists(session, schema, "threads")) {
    const leases = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${q(schema, "threads")}
       WHERE "workerLockedBy" IS NOT NULL
         AND ("workerLeaseExpiresAt" IS NULL OR "workerLeaseExpiresAt" > NOW())`,
    );
    if (Number(leases.rows[0]?.count ?? 0) > 0) {
      throw new Error(
        `Refusing to upgrade '${schema}': thread leases are active.`,
      );
    }
  }
}

async function freeIndexNames(
  transaction: SqlTransaction,
  schema: string,
  table: string,
): Promise<void> {
  const indexes = await transaction.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = $1 AND tablename = $2
     ORDER BY indexname`,
    [schema, table],
  );
  let sequence = 0;
  for (const { indexname } of indexes.rows) {
    const replacement = `v1_${sequence++}_${indexname}`.slice(0, 63);
    await transaction.query(
      `ALTER INDEX ${q(schema, indexname)} RENAME TO ${
        quoteIdentifier(replacement)
      }`,
    );
  }
}

async function stageTable(
  transaction: SqlTransaction,
  schema: string,
  table: string,
): Promise<boolean> {
  if (!await tableExists(transaction, schema, table)) return false;
  const staged = `${table}_v1_upgrade`;
  if (await tableExists(transaction, schema, staged)) {
    throw new Error(
      `Refusing to upgrade '${schema}': staging table '${staged}' already exists.`,
    );
  }
  await transaction.query(
    `ALTER TABLE ${q(schema, table)} RENAME TO ${quoteIdentifier(staged)}`,
  );
  await freeIndexNames(transaction, schema, staged);
  return true;
}

async function copyGraph(
  transaction: SqlTransaction,
  schema: string,
  hasNodes: boolean,
  hasEdges: boolean,
): Promise<void> {
  if (hasNodes) {
    await transaction.query(
      `INSERT INTO ${q(schema, "nodes")} (
        id, namespace, type, name, content, data, embedding,
        source_type, source_id, created_at, updated_at
      )
      SELECT id, COALESCE(namespace, 'default'), type, name, content, data,
        to_jsonb(embedding), "sourceType", "sourceId",
        COALESCE("createdAt", NOW()), COALESCE("updatedAt", "createdAt", NOW())
      FROM ${q(schema, "nodes_v1_upgrade")}
      ON CONFLICT (id) DO NOTHING`,
    );
  }
  if (hasEdges) {
    await transaction.query(
      `INSERT INTO ${q(schema, "edges")} (
        id, namespace, source_node_id, target_node_id, type, data, weight, created_at
      )
      SELECT edge.id,
        COALESCE(source.namespace, target.namespace, 'default'),
        edge."sourceNodeId", edge."targetNodeId", edge.type,
        edge.data, edge.weight, COALESCE(edge."createdAt", NOW())
      FROM ${q(schema, "edges_v1_upgrade")} edge
      JOIN ${q(schema, "nodes")} source ON source.id = edge."sourceNodeId"
      JOIN ${q(schema, "nodes")} target ON target.id = edge."targetNodeId"
      ON CONFLICT DO NOTHING`,
    );
  }
}

async function loadThreads(
  transaction: SqlTransaction,
  schema: string,
): Promise<LegacyThreadRow[]> {
  if (!await tableExists(transaction, schema, "threads_v1_upgrade")) return [];
  const result = await transaction.query<LegacyThreadRow>(
    `SELECT id, namespace, name,
      "externalId" AS external_id,
      description, participants, mode, status, summary,
      "parentThreadId" AS parent_thread_id,
      "rootThreadId" AS root_thread_id,
      "lastEventId" AS last_event_id,
      "lastEventAt" AS last_event_at,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at
     FROM ${q(schema, "threads_v1_upgrade")}
     ORDER BY "createdAt", id`,
  );
  return result.rows;
}

async function upsertThreadNode(
  transaction: SqlTransaction,
  schema: string,
  row: LegacyThreadRow,
): Promise<void> {
  const namespace = row.namespace ?? "default";
  const data = {
    id: row.id,
    threadId: row.id,
    externalId: row.external_id,
    name: row.name,
    description: row.description,
    status: row.status,
    mode: row.mode,
    summary: row.summary,
    parentThreadId: row.parent_thread_id,
    rootThreadId: row.root_thread_id ?? row.id,
    lastEventId: row.last_event_id,
    lastEventAt: iso(row.last_event_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  await transaction.query(
    `INSERT INTO ${q(schema, "nodes")} (
      id, namespace, type, name, content, data, source_type, source_id,
      created_at, updated_at
    ) VALUES ($1, $2, 'thread', $3, NULL, $4::jsonb, 'thread', $1,
      $5::timestamptz, $6::timestamptz)
    ON CONFLICT (id) DO UPDATE SET
      namespace = EXCLUDED.namespace,
      type = 'thread',
      name = EXCLUDED.name,
      data = COALESCE(${q(schema, "nodes")}.data, '{}'::jsonb) || EXCLUDED.data,
      updated_at = EXCLUDED.updated_at`,
    [row.id, namespace, row.name, json(data), data.createdAt, data.updatedAt],
  );
}

async function mergeThreadRelationships(
  transaction: SqlTransaction,
  schema: string,
  row: LegacyThreadRow,
): Promise<number> {
  const namespace = row.namespace ?? "default";
  if (row.parent_thread_id) {
    await transaction.query(
      `INSERT INTO ${q(schema, "edges")} (
        id, namespace, source_node_id, target_node_id, type, created_at
      ) SELECT $1, $2, $3, $4, 'has_child_thread', NOW()
        WHERE EXISTS (SELECT 1 FROM ${q(schema, "nodes")} WHERE id = $3)
          AND EXISTS (SELECT 1 FROM ${q(schema, "nodes")} WHERE id = $4)
      ON CONFLICT (namespace, source_node_id, target_node_id, type) DO NOTHING`,
      [ulid(), namespace, row.parent_thread_id, row.id],
    );
  }

  let created = 0;
  for (const externalId of stringArray(row.participants)) {
    const found = await transaction.query<{ id: string }>(
      `SELECT id FROM ${q(schema, "nodes")}
       WHERE namespace = $1 AND type = 'participant'
         AND (id = $2 OR data ->> 'externalId' = $2)
       ORDER BY created_at LIMIT 1`,
      [namespace, externalId],
    );
    const participantId = found.rows[0]?.id ?? ulid();
    if (!found.rows[0]) {
      const now = new Date().toISOString();
      await transaction.query(
        `INSERT INTO ${q(schema, "nodes")} (
          id, namespace, type, name, data, source_type, source_id,
          created_at, updated_at
        ) VALUES ($1, $2, 'participant', $3, $4::jsonb, 'user', $3,
          $5::timestamptz, $5::timestamptz)`,
        [
          participantId,
          namespace,
          externalId,
          json({
            id: participantId,
            externalId,
            participantType: "human",
            name: externalId,
            createdAt: now,
            updatedAt: now,
          }),
          now,
        ],
      );
      created++;
    }
    await transaction.query(
      `INSERT INTO ${q(schema, "edges")} (
        id, namespace, source_node_id, target_node_id, type, created_at
      ) VALUES ($1, $2, $3, $4, 'participates_in', NOW())
      ON CONFLICT (namespace, source_node_id, target_node_id, type) DO NOTHING`,
      [ulid(), namespace, row.id, participantId],
    );
  }
  return created;
}

async function loadLegacyEvents(
  transaction: SqlTransaction,
  schema: string,
): Promise<LegacyEventRow[]> {
  const result = await transaction.query<LegacyEventRow>(
    `SELECT id,
      "threadId" AS thread_id,
      "eventType" AS event_type,
      payload,
      "parentEventId" AS parent_event_id,
      "traceId" AS trace_id,
      namespace,
      "subjectType" AS subject_type,
      "subjectId" AS subject_id,
      operation,
      "causationId" AS causation_id,
      "correlationId" AS correlation_id,
      "dedupeKey" AS dedupe_key,
      input, before, after, patch, status, metadata,
      "createdAt" AS created_at
     FROM ${q(schema, "events_v1_upgrade")}
     WHERE status NOT IN ('pending', 'processing')
     ORDER BY "createdAt", id`,
  );
  return result.rows;
}

async function copyEvents(
  transaction: SqlTransaction,
  schema: string,
): Promise<number> {
  let count = 0;
  for (const row of await loadLegacyEvents(transaction, schema)) {
    if (EPHEMERAL_TYPES.has(row.event_type)) continue;
    await transaction.query(
      `INSERT INTO ${q(schema, "events")} (
        id, schema_version, type, namespace, thread_id,
        subject_type, subject_id, payload, delta, routing, visibility,
        metadata, causation_id, correlation_id, deduplication_id, created_at
      ) VALUES (
        $1, 2, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
        '{}'::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14::timestamptz
      ) ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        eventType(row),
        row.namespace ?? "default",
        row.thread_id,
        row.subject_type,
        row.subject_id,
        json(row.payload),
        json({
          input: row.input,
          before: row.before,
          after: row.after,
          patch: row.patch,
          operation: row.operation,
          legacyStatus: row.status,
        }),
        json({ kind: "public" }),
        json({ ...(row.metadata ?? {}), migratedFromV1: true }),
        row.causation_id ?? row.parent_event_id,
        row.correlation_id ?? row.trace_id ?? row.id,
        row.dedupe_key,
        iso(row.created_at),
      ],
    );
    count++;
  }
  return count;
}

export async function upgradeV1Schema(
  session: DatabaseSession,
  schemaName: string,
): Promise<UpgradeV1SchemaResult> {
  const schema = validateSchemaName(schemaName);
  await assertDrained(session, schema);
  return await session.transaction(async (transaction) => {
    const hasEvents = await stageTable(transaction, schema, "events");
    if (!hasEvents) {
      throw new Error(`Schema '${schema}' has no v1 event table.`);
    }
    await stageTable(transaction, schema, "threads");
    const hasEdges = await stageTable(transaction, schema, "edges");
    const hasNodes = await stageTable(transaction, schema, "nodes");

    for (const statement of v2BaselineSql(schema)) {
      await transaction.query(statement);
    }
    await copyGraph(transaction, schema, hasNodes, hasEdges);

    const threads = await loadThreads(transaction, schema);
    for (const thread of threads) {
      await upsertThreadNode(transaction, schema, thread);
    }
    let participants = 0;
    for (const thread of threads) {
      participants += await mergeThreadRelationships(
        transaction,
        schema,
        thread,
      );
    }
    const events = await copyEvents(transaction, schema);

    if (hasEdges) {
      await transaction.query(`DROP TABLE ${q(schema, "edges_v1_upgrade")}`);
    }
    if (hasNodes) {
      await transaction.query(`DROP TABLE ${q(schema, "nodes_v1_upgrade")}`);
    }
    if (await tableExists(transaction, schema, "threads_v1_upgrade")) {
      await transaction.query(`DROP TABLE ${q(schema, "threads_v1_upgrade")}`);
    }
    await transaction.query(`DROP TABLE ${q(schema, "events_v1_upgrade")}`);

    return {
      schema,
      threads: threads.length,
      participants,
      events,
    };
  });
}

export async function upgradeV1Database(
  options: UpgradeV1Options = {},
): Promise<readonly UpgradeV1SchemaResult[]> {
  const config = options.database ?? {};
  const { instance, schema: _schema, oxian, ...connection } = config;
  const database = instance ?? await Ominipg.connect({
    ...connection,
    ...resolveAutoProviders(connection),
    oxian,
  });
  const owned = !instance;
  const session = new DatabaseSession(database);
  try {
    const schemas = options.schemas?.map(validateSchemaName) ??
      await legacySchemas(session);
    const results: UpgradeV1SchemaResult[] = [];
    for (const schema of schemas) {
      results.push(await upgradeV1Schema(session, schema));
    }
    return results;
  } finally {
    if (owned) await session.close();
  }
}
