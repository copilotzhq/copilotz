/**
 * Explicit, one-way v1 database upgrade.
 *
 * This module is intentionally outside the normal runtime graph. Applications
 * import it only for a controlled maintenance operation after draining work.
 */
import { ulid } from "../../dependencies/ulid.ts";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../../runtime/events/schema.ts";
import type { SqlExecutor, SqlSession } from "../../runtime/events/session.ts";

type LegacyThreadRow = Record<string, unknown> & {
  id: string;
  namespace: string | null;
  name: string;
  external_id: string | null;
  description: string | null;
  participants: unknown;
  initial_message: string | null;
  mode: string;
  status: string;
  summary: string | null;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  last_event_id: string | null;
  last_event_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type LegacyEventRow = Record<string, unknown> & {
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
  metadata: unknown;
  created_at: string | Date;
};

type LegacyNodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ParticipantType = "human" | "agent" | "tool" | "job";

type MigratedContentRef = Readonly<{
  assetId: string;
  kind: "text" | "json" | "image" | "audio" | "video" | "file";
  role: string;
  mediaType: string;
  name?: string;
  metadata?: Record<string, unknown>;
}>;

export type LegacyAssetMigrationInput = Readonly<{
  schema: string;
  id: string;
  namespace: string;
  name: string;
  ref: string | null;
  mediaType: string | null;
  data: Readonly<Record<string, unknown>>;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ResolvedLegacyAsset = Readonly<{
  body: Uint8Array;
  mediaType?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ResolveLegacyAsset = (
  input: LegacyAssetMigrationInput,
) => ResolvedLegacyAsset | Promise<ResolvedLegacyAsset>;

export type UpgradeV1SchemaOptions = Readonly<{
  /**
   * Imports bytes addressed by legacy asset metadata. The upgrade aborts when
   * a non-canonical asset exists and no resolver can provide its body.
   */
  resolveLegacyAsset?: ResolveLegacyAsset;
}>;

export type UpgradeV1SchemaResult = Readonly<{
  schema: string;
  nodes: number;
  edges: number;
  threads: number;
  participantsCreated: number;
  events: number;
  alreadyUpgraded: boolean;
}>;

export type UpgradeV1SchemasOptions = UpgradeV1SchemaOptions & {
  /** Defaults to all non-system schemas containing a legacy event table. */
  schemas?: readonly string[];
};

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

function qualified(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

function quoteExistingIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0
    );
  }
  if (typeof value !== "string") return [];
  try {
    return stringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function participantType(
  value: unknown,
  fallback: ParticipantType = "human",
): ParticipantType {
  if (value === "human" || value === "user") return "human";
  if (value === "agent") return "agent";
  if (value === "tool") return "tool";
  if (value === "job" || value === "system") return "job";
  return fallback;
}

function isCanonicalContent(value: unknown): value is MigratedContentRef[] {
  return Array.isArray(value) && value.every((candidate) => {
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      return false;
    }
    const ref = candidate as Record<string, unknown>;
    return typeof ref.assetId === "string" && ref.assetId.length > 0 &&
      typeof ref.kind === "string" && typeof ref.role === "string" &&
      typeof ref.mediaType === "string";
  });
}

function jsonMediaType(mediaType: string): boolean {
  const base = mediaType.toLowerCase().split(";", 1)[0].trim();
  return base === "application/json" || base.endsWith("+json");
}

function contentKind(
  mediaType: string,
): MigratedContentRef["kind"] {
  const base = mediaType.toLowerCase().split(";", 1)[0].trim();
  if (base.startsWith("text/")) return "text";
  if (base === "application/json" || base.endsWith("+json")) return "json";
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("audio/")) return "audio";
  if (base.startsWith("video/")) return "video";
  return "file";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", input),
  );
  return `sha256:${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

function encodeDatabaseBody(
  mediaType: string,
  body: Uint8Array,
): Readonly<{
  body: string;
  location: Readonly<
    { kind: "database"; encoding: "utf8" | "json" | "base64" }
  >;
}> {
  if (mediaType.toLowerCase().startsWith("text/") || jsonMediaType(mediaType)) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (jsonMediaType(mediaType)) JSON.parse(text);
    return {
      body: text,
      location: {
        kind: "database",
        encoding: jsonMediaType(mediaType) ? "json" : "utf8",
      },
    };
  }
  return {
    body: bytesToBase64(body),
    location: { kind: "database", encoding: "base64" },
  };
}

function canonicalAssetData(value: unknown): boolean {
  const data = object(value);
  const location = object(data.location);
  return typeof data.mediaType === "string" &&
    finiteNonNegativeInteger(data.byteLength) !== null &&
    typeof data.digest === "string" && data.digest.startsWith("sha256:") &&
    data.state === "ready" && location.kind === "database" &&
    (location.encoding === "utf8" || location.encoding === "json" ||
      location.encoding === "base64") &&
    typeof data.body === "string";
}

function semanticEventType(row: LegacyEventRow): string {
  if (row.event_type.includes(".")) return row.event_type;
  switch (row.event_type) {
    case "NEW_MESSAGE":
      return "message.created";
    case "LLM_CALL":
      return "llm_attempt.created";
    case "LLM_RESULT":
      return object(row.payload).status === "failed"
        ? "llm_attempt.failed"
        : "llm_attempt.completed";
    case "TOOL_CALL":
      return "tool_execution.created";
    case "TOOL_RESULT":
      return object(row.payload).status === "failed"
        ? "tool_execution.failed"
        : "tool_execution.completed";
    default:
      return row.event_type.toLowerCase().replaceAll("_", ".");
  }
}

function eventVisibility(row: LegacyEventRow): Record<string, unknown> {
  const metadataVisibility = object(row.metadata).visibility;
  if (
    metadataVisibility && typeof metadataVisibility === "object" &&
    !Array.isArray(metadataVisibility) &&
    typeof (metadataVisibility as Record<string, unknown>).kind === "string"
  ) {
    return metadataVisibility as Record<string, unknown>;
  }

  const payload = object(row.payload);
  const policy = payload.historyVisibility;
  const agent = object(payload.agent);
  if (
    row.event_type === "TOOL_RESULT" &&
    (policy === "requester_only" || policy === "public_status" ||
      policy === "public") &&
    typeof agent.id === "string"
  ) {
    return { kind: "tool", policy, requesterId: agent.id };
  }
  return { kind: "public" };
}

async function tableExists(
  executor: SqlExecutor,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schema, table],
  );
  return result.rows[0]?.exists === true;
}

async function tableColumns(
  executor: SqlExecutor,
  schema: string,
  table: string,
): Promise<Set<string>> {
  const result = await executor.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function countTable(
  executor: SqlExecutor,
  schema: string,
  table: string,
): Promise<number> {
  if (!await tableExists(executor, schema, table)) return 0;
  const result = await executor.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${qualified(schema, table)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function isAlreadyUpgraded(
  executor: SqlExecutor,
  schema: string,
): Promise<boolean> {
  const columns = await tableColumns(executor, schema, "events");
  return columns.has("position") && columns.has("schema_version") &&
    !columns.has("status") && !columns.has("eventType");
}

async function assertLegacyWorkDrained(
  session: SqlSession,
  schema: string,
): Promise<void> {
  const active = await session.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${qualified(schema, "events")}
     WHERE "status" IN ('pending', 'processing')`,
  );
  if (Number(active.rows[0]?.count ?? 0) > 0) {
    throw new Error(
      `Refusing to upgrade '${schema}': legacy work is pending or processing.`,
    );
  }

  if (await tableExists(session, schema, "threads")) {
    const leases = await session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${qualified(schema, "threads")}
       WHERE "workerLockedBy" IS NOT NULL
         AND (
           "workerLeaseExpiresAt" IS NULL
           OR "workerLeaseExpiresAt" > NOW()
         )`,
    );
    if (Number(leases.rows[0]?.count ?? 0) > 0) {
      throw new Error(
        `Refusing to upgrade '${schema}': thread worker leases are active.`,
      );
    }
  }
}

async function freeIndexNames(
  transaction: SqlExecutor,
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
    const replacement = `v1_${table}_${sequence++}`.slice(0, 63);
    await transaction.query(
      `ALTER INDEX ${quoteEventIdentifier(schema)}.${
        quoteExistingIdentifier(indexname)
      } RENAME TO ${quoteExistingIdentifier(replacement)}`,
    );
  }
}

async function stageTable(
  transaction: SqlExecutor,
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
    `ALTER TABLE ${qualified(schema, table)}
     RENAME TO ${quoteEventIdentifier(staged)}`,
  );
  await freeIndexNames(transaction, schema, staged);
  return true;
}

async function copyNodes(
  transaction: SqlExecutor,
  schema: string,
  hasNodes: boolean,
): Promise<number> {
  if (!hasNodes) return 0;
  const result = await transaction.query<{ id: string }>(
    `INSERT INTO ${qualified(schema, "nodes")} (
       id, namespace, type, name, content, data, embedding,
       source_type, source_id, created_at, updated_at
     )
     SELECT id, COALESCE(namespace, 'default'), type, name, content,
       COALESCE(data, '{}'::jsonb),
       CASE WHEN embedding IS NULL THEN NULL ELSE to_jsonb(embedding) END,
       source_type, source_id,
       COALESCE(created_at, NOW()),
       COALESCE(updated_at, created_at, NOW())
     FROM ${qualified(schema, "nodes_v1_upgrade")}
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
  );
  return result.rows.length;
}

async function copyEdges(
  transaction: SqlExecutor,
  schema: string,
  hasEdges: boolean,
): Promise<number> {
  if (!hasEdges) return 0;
  const result = await transaction.query<{ id: string }>(
    `INSERT INTO ${qualified(schema, "edges")} (
       id, namespace, source_node_id, target_node_id,
       type, data, weight, created_at
     )
     SELECT edge.id, source.namespace,
       edge.source_node_id, edge.target_node_id, edge.type,
       COALESCE(edge.data, '{}'::jsonb), edge.weight,
       COALESCE(edge.created_at, NOW())
     FROM ${qualified(schema, "edges_v1_upgrade")} edge
     JOIN ${qualified(schema, "nodes")} source
       ON source.id = edge.source_node_id
     JOIN ${qualified(schema, "nodes")} target
       ON target.id = edge.target_node_id
     ON CONFLICT DO NOTHING
     RETURNING id`,
  );
  return result.rows.length;
}

async function loadNodes(
  transaction: SqlExecutor,
  schema: string,
  types: readonly string[],
): Promise<LegacyNodeRow[]> {
  const result = await transaction.query<LegacyNodeRow>(
    `SELECT id, namespace, type, name, content, data,
       source_type, source_id, created_at, updated_at
     FROM ${qualified(schema, "nodes")}
     WHERE type = ANY($1::text[])
     ORDER BY created_at, id`,
    [[...types]],
  );
  return result.rows;
}

async function ensureEdge(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    namespace: string;
    sourceId: string;
    targetId: string;
    type: string;
    data?: Record<string, unknown>;
  }>,
): Promise<void> {
  await transaction.query(
    `INSERT INTO ${qualified(schema, "edges")} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     )
     SELECT $1, $2, $3, $4, $5, $6::jsonb, 1
     WHERE EXISTS (
       SELECT 1 FROM ${qualified(schema, "nodes")}
       WHERE namespace = $2 AND id = $3
     ) AND EXISTS (
       SELECT 1 FROM ${qualified(schema, "nodes")}
       WHERE namespace = $2 AND id = $4
     ) AND NOT EXISTS (
       SELECT 1 FROM ${qualified(schema, "edges")}
       WHERE namespace = $2 AND source_node_id = $3
         AND target_node_id = $4 AND type = $5
     )`,
    [
      ulid(),
      input.namespace,
      input.sourceId,
      input.targetId,
      input.type,
      json(input.data ?? {}),
    ],
  );
}

async function writeCanonicalAsset(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    id: string;
    namespace: string;
    mediaType: string;
    body: Uint8Array;
    metadata?: Readonly<Record<string, unknown>>;
    sourceType?: string | null;
    sourceId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    insert: boolean;
  }>,
): Promise<void> {
  if (!(input.body instanceof Uint8Array)) {
    throw new TypeError(`Asset '${input.id}' resolver did not return bytes.`);
  }
  const mediaType = input.mediaType.trim();
  if (!mediaType) {
    throw new TypeError(`Asset '${input.id}' has no media type.`);
  }
  let encoded: ReturnType<typeof encodeDatabaseBody>;
  try {
    encoded = encodeDatabaseBody(mediaType, input.body);
  } catch (cause) {
    throw new Error(
      `Asset '${input.id}' could not be encoded as '${mediaType}'.`,
      { cause },
    );
  }
  const readyAt = input.updatedAt ?? new Date().toISOString();
  const data = {
    mediaType,
    byteLength: input.body.byteLength,
    digest: await sha256(input.body),
    state: "ready",
    location: encoded.location,
    body: encoded.body,
    readyAt,
    metadata: structuredClone(input.metadata ?? {}),
  };
  if (input.insert) {
    await transaction.query(
      `INSERT INTO ${qualified(schema, "nodes")} (
         id, namespace, type, name, content, data,
         source_type, source_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'asset', $3, NULL, $4::jsonb,
         $5, $6, $7::timestamptz, $8::timestamptz
       )`,
      [
        input.id,
        input.namespace,
        mediaType,
        json(data),
        input.sourceType ?? null,
        input.sourceId ?? null,
        input.createdAt ?? readyAt,
        readyAt,
      ],
    );
    return;
  }
  await transaction.query(
    `UPDATE ${qualified(schema, "nodes")}
     SET name = $3, content = NULL, data = $4::jsonb,
       source_type = $5, source_id = $6, updated_at = $7::timestamptz
     WHERE namespace = $1 AND id = $2 AND type = 'asset'`,
    [
      input.namespace,
      input.id,
      mediaType,
      json(data),
      input.sourceType ?? null,
      input.sourceId ?? null,
      readyAt,
    ],
  );
}

async function canonicalizeLegacyAssets(
  transaction: SqlExecutor,
  schema: string,
  options: UpgradeV1SchemaOptions,
): Promise<void> {
  for (const row of await loadNodes(transaction, schema, ["asset"])) {
    if (canonicalAssetData(row.data)) continue;
    const data = object(row.data);
    const ref = optionalString(data.ref) ?? optionalString(row.source_id);
    const inferredMediaType = optionalString(data.mediaType) ??
      optionalString(data.mime);
    if (!options.resolveLegacyAsset) {
      throw new Error(
        `Cannot upgrade legacy asset '${row.id}' in schema '${schema}' without resolveLegacyAsset.`,
      );
    }
    const resolved = await options.resolveLegacyAsset({
      schema,
      id: row.id,
      namespace: row.namespace,
      name: row.name,
      ref,
      mediaType: inferredMediaType,
      data: structuredClone(data),
      sourceType: row.source_type,
      sourceId: row.source_id,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    });
    if (!resolved || !(resolved.body instanceof Uint8Array)) {
      throw new TypeError(
        `resolveLegacyAsset did not return a body for '${row.id}'.`,
      );
    }
    await writeCanonicalAsset(transaction, schema, {
      id: row.id,
      namespace: row.namespace,
      mediaType: optionalString(resolved.mediaType) ?? inferredMediaType ??
        "application/octet-stream",
      body: resolved.body,
      metadata: {
        ...object(data.metadata),
        ...object(resolved.metadata),
        migratedFromV1: {
          ref,
          sourceType: row.source_type,
          sourceId: row.source_id,
          data: structuredClone(data),
        },
      },
      sourceType: "legacy_asset_ref",
      sourceId: ref ?? row.id,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      insert: false,
    });
  }
}

async function materializeLegacyContent(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    namespace: string;
    ownerId: string;
    role: string;
    value: unknown;
    mediaType?: string;
    name?: string;
    cache: Map<string, string>;
  }>,
): Promise<MigratedContentRef> {
  const mediaType = input.mediaType ??
    (typeof input.value === "string"
      ? "text/plain;charset=utf-8"
      : "application/json");
  const body = new TextEncoder().encode(
    typeof input.value === "string" ? input.value : JSON.stringify(input.value),
  );
  const digest = await sha256(body);
  const cacheKey = `${mediaType}:${digest}`;
  let assetId = input.cache.get(cacheKey);
  if (!assetId) {
    assetId = ulid();
    await writeCanonicalAsset(transaction, schema, {
      id: assetId,
      namespace: input.namespace,
      mediaType,
      body,
      metadata: {
        migratedFromV1: {
          ownerId: input.ownerId,
          role: input.role,
        },
      },
      sourceType: "v1_inline_content",
      sourceId: `${input.ownerId}:${input.role}`,
      insert: true,
    });
    input.cache.set(cacheKey, assetId);
  }
  await ensureEdge(transaction, schema, {
    namespace: input.namespace,
    sourceId: input.ownerId,
    targetId: assetId,
    type: "has_asset",
  });
  return Object.freeze({
    assetId,
    kind: contentKind(mediaType),
    role: input.role,
    mediaType,
    ...(input.name ? { name: input.name } : {}),
  });
}

async function linkCanonicalContent(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  ownerId: string,
  content: readonly MigratedContentRef[],
): Promise<void> {
  for (const ref of content) {
    const asset = await transaction.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${qualified(schema, "nodes")}
       WHERE namespace = $1 AND id = $2 AND type = 'asset'`,
      [namespace, ref.assetId],
    );
    if (Number(asset.rows[0]?.count ?? 0) !== 1) {
      throw new Error(
        `Canonical content on '${ownerId}' references missing asset '${ref.assetId}'.`,
      );
    }
    await ensureEdge(transaction, schema, {
      namespace,
      sourceId: ownerId,
      targetId: ref.assetId,
      type: "has_asset",
    });
  }
}

async function participantHint(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  externalId: string,
): Promise<ParticipantType> {
  const existing = await transaction.query<
    { data: unknown; source_type: string | null }
  >(
    `SELECT data, source_type FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND type = 'participant'
       AND (id = $2 OR data ->> 'externalId' = $2 OR source_id = $2)
     ORDER BY created_at, id LIMIT 1`,
    [namespace, externalId],
  );
  if (existing.rows[0]) {
    const data = object(existing.rows[0].data);
    if (optionalString(data.participantType)) {
      return participantType(data.participantType);
    }
    if (optionalString(existing.rows[0].source_type)) {
      return participantType(existing.rows[0].source_type);
    }
  }

  const workflows = await transaction.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND type IN ('tool_execution', 'llm_attempt')
       AND data ->> 'agentId' = $2`,
    [namespace, externalId],
  );
  if (Number(workflows.rows[0]?.count ?? 0) > 0) return "agent";

  const sender = await transaction.query<{ sender_type: string | null }>(
    `SELECT data ->> 'senderType' AS sender_type
     FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND type = 'message'
       AND data ->> 'senderId' = $2
     ORDER BY created_at, id LIMIT 1`,
    [namespace, externalId],
  );
  return participantType(sender.rows[0]?.sender_type, "human");
}

async function ensureParticipant(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    namespace: string;
    externalId: string;
    participantType: ParticipantType;
    name?: string | null;
    synthetic?: boolean;
  }>,
): Promise<Readonly<{ id: string; created: boolean }>> {
  const externalId = input.externalId.trim();
  if (!externalId) throw new TypeError("Participant external ID is empty.");
  const found = await transaction.query<LegacyNodeRow>(
    `SELECT id, namespace, type, name, content, data,
       source_type, source_id, created_at, updated_at
     FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND type = 'participant'
       AND (id = $2 OR data ->> 'externalId' = $2 OR source_id = $2)
     ORDER BY
       CASE WHEN source_type = 'participant_external_id' THEN 0
            WHEN id = $2 THEN 1 ELSE 2 END,
       created_at, id
     LIMIT 1`,
    [input.namespace, externalId],
  );
  const row = found.rows[0];
  const timestamp = new Date().toISOString();
  if (!row) {
    const id = ulid();
    await transaction.query(
      `INSERT INTO ${qualified(schema, "nodes")} (
         id, namespace, type, name, content, data,
         source_type, source_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'participant', $3, NULL, $4::jsonb,
         'participant_external_id', $5, $6::timestamptz, $6::timestamptz
       )`,
      [
        id,
        input.namespace,
        input.name ?? externalId,
        json({
          externalId,
          participantType: input.participantType,
          name: input.name ?? externalId,
          email: null,
          agentId: input.participantType === "agent" ? externalId : null,
          metadata: input.synthetic
            ? { migratedFromV1: { synthetic: true } }
            : {},
        }),
        externalId,
        timestamp,
      ],
    );
    return Object.freeze({ id, created: true });
  }

  const data = object(row.data);
  const metadata = object(data.metadata);
  const migrationMetadata = object(metadata.migratedFromV1);
  const storedType = participantType(
    data.participantType ?? row.source_type,
    input.participantType,
  );
  const normalizedType = migrationMetadata.synthetic === true
    ? input.participantType
    : storedType;
  const normalizedMetadata = {
    ...metadata,
    ...(data.profile !== undefined && metadata.profile === undefined
      ? { profile: structuredClone(data.profile) }
      : {}),
  };
  await transaction.query(
    `UPDATE ${qualified(schema, "nodes")}
     SET name = $3, content = NULL, data = $4::jsonb,
       source_type = 'participant_external_id', source_id = $5
     WHERE namespace = $1 AND id = $2 AND type = 'participant'`,
    [
      input.namespace,
      row.id,
      optionalString(data.name) ?? input.name ?? row.name ?? externalId,
      json({
        ...data,
        externalId,
        participantType: normalizedType,
        name: optionalString(data.name) ?? input.name ?? row.name ?? null,
        email: optionalString(data.email),
        agentId: optionalString(data.agentId) ??
          (normalizedType === "agent" ? externalId : null),
        metadata: normalizedMetadata,
      }),
      externalId,
    ],
  );
  return Object.freeze({ id: row.id, created: false });
}

async function loadThreads(
  transaction: SqlExecutor,
  schema: string,
): Promise<LegacyThreadRow[]> {
  if (!await tableExists(transaction, schema, "threads_v1_upgrade")) return [];
  const result = await transaction.query<LegacyThreadRow>(
    `SELECT id, namespace, name,
       "externalId" AS external_id,
       description, participants,
       "initialMessage" AS initial_message,
       mode, status, summary,
       "parentThreadId" AS parent_thread_id,
       "rootThreadId" AS root_thread_id,
       "lastEventId" AS last_event_id,
       "lastEventAt" AS last_event_at,
       "createdAt" AS created_at,
       "updatedAt" AS updated_at
     FROM ${qualified(schema, "threads_v1_upgrade")}
     ORDER BY "createdAt", id`,
  );
  return result.rows;
}

async function resolveThreadNamespace(
  transaction: SqlExecutor,
  schema: string,
  thread: LegacyThreadRow,
): Promise<string> {
  if (thread.namespace?.trim()) return thread.namespace.trim();
  const existing = await transaction.query<{ namespace: string }>(
    `SELECT namespace FROM ${qualified(schema, "nodes")}
     WHERE id = $1 AND type = 'thread' LIMIT 1`,
    [thread.id],
  );
  return existing.rows[0]?.namespace ?? "default";
}

async function upsertThreadNode(
  transaction: SqlExecutor,
  schema: string,
  thread: LegacyThreadRow,
): Promise<string> {
  const namespace = await resolveThreadNamespace(transaction, schema, thread);
  const data = {
    id: thread.id,
    threadId: thread.id,
    externalId: thread.external_id,
    description: thread.description,
    participants: stringArray(thread.participants),
    initialMessage: thread.initial_message,
    mode: thread.mode,
    status: thread.status,
    summary: thread.summary,
    parentThreadId: thread.parent_thread_id,
    rootThreadId: thread.root_thread_id ?? thread.id,
    lastEventId: thread.last_event_id,
    lastEventAt: iso(thread.last_event_at),
    createdAt: iso(thread.created_at),
    updatedAt: iso(thread.updated_at),
  };
  const externalId = optionalString(thread.external_id);
  await transaction.query(
    `INSERT INTO ${qualified(schema, "nodes")} (
       id, namespace, type, name, content, data,
       source_type, source_id, created_at, updated_at
     ) VALUES (
       $1, $2, 'thread', $3, NULL, $4::jsonb,
       $7, $8, $5::timestamptz, $6::timestamptz
     )
     ON CONFLICT (id) DO UPDATE SET
       namespace = EXCLUDED.namespace,
       type = 'thread',
       name = EXCLUDED.name,
       data = COALESCE(${qualified(schema, "nodes")}.data, '{}'::jsonb)
         || EXCLUDED.data,
       source_type = EXCLUDED.source_type,
       source_id = EXCLUDED.source_id,
       updated_at = EXCLUDED.updated_at`,
    [
      thread.id,
      namespace,
      thread.name,
      json(data),
      iso(thread.created_at),
      iso(thread.updated_at),
      externalId ? "thread_external_id" : null,
      externalId,
    ],
  );
  return namespace;
}

async function ensureThreadParentEdge(
  transaction: SqlExecutor,
  schema: string,
  thread: LegacyThreadRow,
  namespace: string,
): Promise<void> {
  if (!thread.parent_thread_id) return;
  await transaction.query(
    `INSERT INTO ${qualified(schema, "edges")} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     )
     SELECT $1, $2, $3, $4, 'has_child_thread', '{}'::jsonb, 1
     WHERE EXISTS (
       SELECT 1 FROM ${qualified(schema, "nodes")} WHERE id = $3
     ) AND EXISTS (
       SELECT 1 FROM ${qualified(schema, "nodes")} WHERE id = $4
     ) AND NOT EXISTS (
       SELECT 1 FROM ${qualified(schema, "edges")}
       WHERE namespace = $2 AND source_node_id = $3
         AND target_node_id = $4 AND type = 'has_child_thread'
     )`,
    [ulid(), namespace, thread.parent_thread_id, thread.id],
  );
}

async function ensureThreadParticipants(
  transaction: SqlExecutor,
  schema: string,
  thread: LegacyThreadRow,
  namespace: string,
): Promise<number> {
  let created = 0;
  for (const externalId of new Set(stringArray(thread.participants))) {
    const ensured = await ensureParticipant(transaction, schema, {
      namespace,
      externalId,
      participantType: await participantHint(
        transaction,
        schema,
        namespace,
        externalId,
      ),
      synthetic: true,
    });
    if (ensured.created) created++;
    await ensureEdge(transaction, schema, {
      namespace,
      sourceId: ensured.id,
      targetId: thread.id,
      type: "participates_in",
    });
  }
  return created;
}

async function normalizeParticipantNodes(
  transaction: SqlExecutor,
  schema: string,
): Promise<number> {
  let created = 0;
  for (const row of await loadNodes(transaction, schema, ["participant"])) {
    const data = object(row.data);
    const externalId = optionalString(data.externalId) ??
      optionalString(row.source_id) ?? row.id;
    const result = await ensureParticipant(transaction, schema, {
      namespace: row.namespace,
      externalId,
      participantType: participantType(
        data.participantType ?? row.source_type,
      ),
      name: optionalString(data.name) ?? row.name,
    });
    if (result.created) created++;
  }
  return created;
}

async function nodeExists(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  id: string | null,
  type?: string,
): Promise<boolean> {
  if (!id) return false;
  const result = await transaction.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND id = $2${type ? " AND type = $3" : ""}`,
    type ? [namespace, id, type] : [namespace, id],
  );
  return Number(result.rows[0]?.count ?? 0) === 1;
}

async function resolveParticipantReference(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    namespace: string;
    reference: string | null;
    type: ParticipantType;
    name?: string | null;
  }>,
): Promise<Readonly<{ id: string; created: boolean }> | null> {
  if (!input.reference) return null;
  const exact = await transaction.query<LegacyNodeRow>(
    `SELECT id, namespace, type, name, content, data,
       source_type, source_id, created_at, updated_at
     FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND id = $2 AND type = 'participant' LIMIT 1`,
    [input.namespace, input.reference],
  );
  const exactRow = exact.rows[0];
  const exactData = object(exactRow?.data);
  const externalId = exactRow
    ? optionalString(exactData.externalId) ??
      optionalString(exactRow.source_id) ?? exactRow.id
    : input.reference;
  return await ensureParticipant(transaction, schema, {
    namespace: input.namespace,
    externalId,
    participantType: input.type,
    name: input.name,
  });
}

async function resolveMessageSender(
  transaction: SqlExecutor,
  schema: string,
  row: LegacyNodeRow,
  data: Record<string, unknown>,
): Promise<Readonly<{ id: string; created: boolean }>> {
  const legacyType = optionalString(data.senderType) ?? "user";
  const type = participantType(legacyType);
  const senderId = optionalString(data.senderId);
  const senderUserId = optionalString(data.senderUserId);
  for (const candidate of [senderUserId, senderId]) {
    if (
      candidate &&
      await nodeExists(
        transaction,
        schema,
        row.namespace,
        candidate,
        "participant",
      )
    ) {
      return (await resolveParticipantReference(transaction, schema, {
        namespace: row.namespace,
        reference: candidate,
        type,
      }))!;
    }
  }

  let externalId = senderId ?? senderUserId ?? `unknown:${row.id}`;
  if (legacyType === "tool") {
    externalId = `tool:${optionalString(data.toolCallId) ?? externalId}`;
  } else if (legacyType === "system") {
    externalId = "system";
  }
  return (await resolveParticipantReference(transaction, schema, {
    namespace: row.namespace,
    reference: externalId,
    type,
    name: optionalString(data.senderName),
  }))!;
}

async function resolveRecipientIds(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  value: unknown,
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const reference of stringArray(value)) {
    if (
      await nodeExists(
        transaction,
        schema,
        namespace,
        reference,
        "participant",
      )
    ) {
      ids.add(reference);
      continue;
    }
    const resolved = await resolveParticipantReference(transaction, schema, {
      namespace,
      reference,
      type: await participantHint(
        transaction,
        schema,
        namespace,
        reference,
      ),
    });
    if (resolved) ids.add(resolved.id);
  }
  return Object.freeze([...ids]);
}

async function canonicalMessageContent(
  transaction: SqlExecutor,
  schema: string,
  row: LegacyNodeRow,
  data: Record<string, unknown>,
): Promise<readonly MigratedContentRef[]> {
  const content: MigratedContentRef[] = isCanonicalContent(data.content)
    ? structuredClone(data.content)
    : [];
  if (content.length > 0) {
    await linkCanonicalContent(
      transaction,
      schema,
      row.namespace,
      row.id,
      content,
    );
  }
  const cache = new Map<string, string>();
  const body = row.content ??
    (typeof data.content === "string" ? data.content : null);
  if (body !== null && !content.some((ref) => ref.role === "body")) {
    content.push(
      await materializeLegacyContent(transaction, schema, {
        namespace: row.namespace,
        ownerId: row.id,
        role: "body",
        value: body,
        cache,
      }),
    );
  }
  if (
    typeof data.reasoning === "string" &&
    !content.some((ref) => ref.role === "reasoning")
  ) {
    content.push(
      await materializeLegacyContent(transaction, schema, {
        namespace: row.namespace,
        ownerId: row.id,
        role: "reasoning",
        value: data.reasoning,
        cache,
      }),
    );
  }
  if (
    Array.isArray(data.toolCalls) &&
    !content.some((ref) => ref.role === "llm.tool_calls")
  ) {
    content.push(
      await materializeLegacyContent(transaction, schema, {
        namespace: row.namespace,
        ownerId: row.id,
        role: "llm.tool_calls",
        value: data.toolCalls,
        cache,
      }),
    );
  }
  return Object.freeze(content);
}

async function normalizeMessages(
  transaction: SqlExecutor,
  schema: string,
): Promise<number> {
  let participantsCreated = 0;
  for (const row of await loadNodes(transaction, schema, ["message"])) {
    const data = object(row.data);
    const threadId = optionalString(data.threadId) ??
      (row.source_type === "thread" ? optionalString(row.source_id) : null);
    if (
      !threadId ||
      !await nodeExists(
        transaction,
        schema,
        row.namespace,
        threadId,
        "thread",
      )
    ) {
      throw new Error(`Legacy message '${row.id}' has no readable thread.`);
    }
    const sender = await resolveMessageSender(
      transaction,
      schema,
      row,
      data,
    );
    if (sender.created) participantsCreated++;
    const recipientIds = await resolveRecipientIds(
      transaction,
      schema,
      row.namespace,
      data.recipientIds ?? object(data.metadata).recipientIds,
    );
    const content = await canonicalMessageContent(
      transaction,
      schema,
      row,
      data,
    );
    const metadata = {
      ...object(data.metadata),
      migratedFromV1: {
        ...object(object(data.metadata).migratedFromV1),
        senderType: optionalString(data.senderType),
        senderId: optionalString(data.senderId),
        senderUserId: optionalString(data.senderUserId),
        externalId: optionalString(data.externalId),
        toolCallId: optionalString(data.toolCallId),
      },
    };
    await transaction.query(
      `UPDATE ${qualified(schema, "nodes")}
       SET content = NULL, data = $3::jsonb,
         source_type = 'thread', source_id = $4
       WHERE namespace = $1 AND id = $2 AND type = 'message'`,
      [
        row.namespace,
        row.id,
        json({
          threadId,
          senderId: sender.id,
          recipientIds,
          content,
          metadata,
        }),
        threadId,
      ],
    );
    await ensureEdge(transaction, schema, {
      namespace: row.namespace,
      sourceId: threadId,
      targetId: row.id,
      type: "has_message",
    });
    await ensureEdge(transaction, schema, {
      namespace: row.namespace,
      sourceId: sender.id,
      targetId: row.id,
      type: "sent_by",
    });
    await ensureEdge(transaction, schema, {
      namespace: row.namespace,
      sourceId: sender.id,
      targetId: threadId,
      type: "participates_in",
    });
    for (const recipientId of recipientIds) {
      await ensureEdge(transaction, schema, {
        namespace: row.namespace,
        sourceId: recipientId,
        targetId: threadId,
        type: "participates_in",
      });
    }
  }
  return participantsCreated;
}

function workflowStatus(
  value: unknown,
  input: Readonly<{
    output?: unknown;
    answer?: unknown;
    error?: unknown;
  }>,
): "pending" | "running" | "completed" | "failed" | "cancelled" {
  if (
    value === "pending" || value === "running" || value === "completed" ||
    value === "failed" || value === "cancelled"
  ) return value;
  if (input.error !== undefined && input.error !== null) return "failed";
  if (input.output !== undefined || input.answer !== undefined) {
    return "completed";
  }
  return "running";
}

function safeError(
  value: unknown,
  fallback: string,
): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return { message: value };
  const fields = object(value);
  return {
    ...(optionalString(fields.name) ? { name: fields.name } : {}),
    message: optionalString(fields.message) ?? fallback,
    ...(optionalString(fields.code) ? { code: fields.code } : {}),
    ...(typeof fields.retryable === "boolean"
      ? { retryable: fields.retryable }
      : {}),
    ...(fields.metadata ? { metadata: object(fields.metadata) } : {}),
  };
}

async function resolveWorkflowParticipant(
  transaction: SqlExecutor,
  schema: string,
  row: LegacyNodeRow,
  data: Record<string, unknown>,
): Promise<Readonly<{ id: string; created: boolean }> | null> {
  const storedParticipantId = optionalString(data.participantId);
  if (
    storedParticipantId &&
    await nodeExists(
      transaction,
      schema,
      row.namespace,
      storedParticipantId,
      "participant",
    )
  ) {
    return await resolveParticipantReference(transaction, schema, {
      namespace: row.namespace,
      reference: storedParticipantId,
      type: "agent",
    });
  }
  return await resolveParticipantReference(transaction, schema, {
    namespace: row.namespace,
    reference: optionalString(data.agentId),
    type: "agent",
    name: optionalString(data.agentName),
  });
}

async function canonicalWorkflowContent(
  transaction: SqlExecutor,
  schema: string,
  row: LegacyNodeRow,
  data: Record<string, unknown>,
  fields: readonly Readonly<{
    role: string;
    value: unknown;
    present: boolean;
  }>[],
): Promise<readonly MigratedContentRef[]> {
  const content: MigratedContentRef[] = isCanonicalContent(data.content)
    ? structuredClone(data.content)
    : [];
  if (content.length > 0) {
    await linkCanonicalContent(
      transaction,
      schema,
      row.namespace,
      row.id,
      content,
    );
  }
  const cache = new Map<string, string>();
  for (const field of fields) {
    if (!field.present || content.some((ref) => ref.role === field.role)) {
      continue;
    }
    content.push(
      await materializeLegacyContent(transaction, schema, {
        namespace: row.namespace,
        ownerId: row.id,
        role: field.role,
        value: field.value,
        cache,
      }),
    );
  }
  return Object.freeze(content);
}

async function normalizeToolExecutions(
  transaction: SqlExecutor,
  schema: string,
): Promise<number> {
  let participantsCreated = 0;
  for (
    const row of await loadNodes(transaction, schema, ["tool_execution"])
  ) {
    const data = object(row.data);
    const threadId = optionalString(data.threadId);
    if (
      !threadId ||
      !await nodeExists(
        transaction,
        schema,
        row.namespace,
        threadId,
        "thread",
      )
    ) {
      throw new Error(
        `Legacy tool execution '${row.id}' has no readable thread.`,
      );
    }
    const messageId = optionalString(data.messageId);
    const linkedMessageId = await nodeExists(
        transaction,
        schema,
        row.namespace,
        messageId,
        "message",
      )
      ? messageId
      : null;
    const participant = await resolveWorkflowParticipant(
      transaction,
      schema,
      row,
      data,
    );
    if (participant?.created) participantsCreated++;
    const toolCallId = optionalString(data.toolCallId) ??
      optionalString(row.source_id) ?? row.id;
    const tool = object(data.tool);
    const toolId = optionalString(tool.id) ?? optionalString(data.toolId) ??
      optionalString(tool.name) ?? row.name ?? "unknown";
    const normalizedTool = { ...tool, id: toolId };
    const error = data.error ?? data.safeError;
    const content = await canonicalWorkflowContent(
      transaction,
      schema,
      row,
      data,
      [
        {
          role: "tool.arguments",
          value: data.args ?? data.arguments ?? {},
          present: true,
        },
        {
          role: "tool.output",
          value: data.output,
          present: data.output !== undefined,
        },
        {
          role: "tool.projected_output",
          value: data.projectedOutput,
          present: data.projectedOutput !== undefined,
        },
        {
          role: "tool.error_detail",
          value: error,
          present: error !== undefined && error !== null,
        },
      ],
    );
    const status = workflowStatus(data.status, { output: data.output, error });
    await transaction.query(
      `UPDATE ${qualified(schema, "nodes")}
       SET content = NULL, data = $3::jsonb,
         source_type = 'tool_call', source_id = $4
       WHERE namespace = $1 AND id = $2 AND type = 'tool_execution'`,
      [
        row.namespace,
        row.id,
        json({
          threadId,
          messageId: linkedMessageId,
          participantId: participant?.id ?? null,
          agentId: optionalString(data.agentId),
          toolCallId,
          tool: normalizedTool,
          status,
          content,
          historyVisibility: optionalString(data.historyVisibility),
          safeError: safeError(
            error,
            `Legacy tool execution '${row.id}' failed.`,
          ),
          startedAt: optionalString(data.startedAt) ?? iso(row.created_at),
          finishedAt: optionalString(data.finishedAt),
          durationMs: finiteNonNegativeInteger(data.durationMs),
          metadata: {
            ...object(data.metadata),
            migratedFromV1: {
              eventId: optionalString(data.eventId),
              agentName: optionalString(data.agentName),
            },
          },
        }),
        JSON.stringify([threadId, toolCallId]),
      ],
    );
    for (
      const link of [
        { sourceId: threadId, type: "has_tool_execution" },
        ...(linkedMessageId
          ? [{ sourceId: linkedMessageId, type: "has_tool_execution" }]
          : []),
        ...(participant
          ? [{ sourceId: participant.id, type: "performed_by" }]
          : []),
      ]
    ) {
      await ensureEdge(transaction, schema, {
        namespace: row.namespace,
        sourceId: link.sourceId,
        targetId: row.id,
        type: link.type,
      });
    }
  }
  return participantsCreated;
}

function inferredToolIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((candidate) => {
    const fields = object(candidate);
    const id = optionalString(fields.id) ?? optionalString(fields.name);
    return id ? [id] : [];
  }));
}

async function normalizeLlmAttempts(
  transaction: SqlExecutor,
  schema: string,
): Promise<number> {
  let participantsCreated = 0;
  for (const row of await loadNodes(transaction, schema, ["llm_attempt"])) {
    const data = object(row.data);
    const threadId = optionalString(data.threadId);
    if (
      !threadId ||
      !await nodeExists(
        transaction,
        schema,
        row.namespace,
        threadId,
        "thread",
      )
    ) {
      throw new Error(`Legacy LLM attempt '${row.id}' has no readable thread.`);
    }
    const messageId = optionalString(data.messageId);
    const linkedMessageId = await nodeExists(
        transaction,
        schema,
        row.namespace,
        messageId,
        "message",
      )
      ? messageId
      : null;
    const participant = await resolveWorkflowParticipant(
      transaction,
      schema,
      row,
      data,
    );
    if (participant?.created) participantsCreated++;
    const error = data.error ?? data.safeError;
    const content = await canonicalWorkflowContent(
      transaction,
      schema,
      row,
      data,
      [
        {
          role: "llm.input",
          value: data.messages,
          present: data.messages !== undefined,
        },
        {
          role: "llm.tool_definitions",
          value: data.tools,
          present: data.tools !== undefined,
        },
        {
          role: "body",
          value: data.answer ?? data.partialAnswer,
          present: data.answer !== undefined ||
            data.partialAnswer !== undefined,
        },
        {
          role: "reasoning",
          value: data.reasoning ?? data.partialReasoning,
          present: data.reasoning !== undefined ||
            data.partialReasoning !== undefined,
        },
        {
          role: "llm.tool_calls",
          value: data.toolCalls,
          present: data.toolCalls !== undefined,
        },
        {
          role: "provider.error_detail",
          value: error,
          present: error !== undefined && error !== null,
        },
      ],
    );
    const status = workflowStatus(data.status, {
      answer: data.answer ?? data.partialAnswer,
      error,
    });
    const attemptIndex = finiteNonNegativeInteger(data.attemptIndex) ?? 0;
    const parentAttemptId = optionalString(data.parentAttemptId);
    const linkedParentId = await nodeExists(
        transaction,
        schema,
        row.namespace,
        parentAttemptId,
        "llm_attempt",
      )
      ? parentAttemptId
      : null;
    await transaction.query(
      `UPDATE ${qualified(schema, "nodes")}
       SET content = NULL, data = $3::jsonb,
         source_type = 'llm_attempt', source_id = $2
       WHERE namespace = $1 AND id = $2 AND type = 'llm_attempt'`,
      [
        row.namespace,
        row.id,
        json({
          threadId,
          messageId: linkedMessageId,
          participantId: participant?.id ?? null,
          initiatorParticipantId: null,
          agentId: optionalString(data.agentId),
          provider: optionalString(data.provider),
          model: optionalString(data.model),
          status,
          attemptIndex,
          parentAttemptId: linkedParentId,
          inputMessageIds: stringArray(data.inputMessageIds),
          availableToolIds: stringArray(data.availableToolIds).length > 0
            ? stringArray(data.availableToolIds)
            : inferredToolIds(data.tools),
          content,
          finishReason: optionalString(data.finishReason),
          usage: object(data.usage),
          cost: object(data.cost),
          safeError: safeError(
            error,
            `Legacy LLM attempt '${row.id}' failed.`,
          ),
          startedAt: optionalString(data.startedAt) ?? iso(row.created_at),
          finishedAt: optionalString(data.finishedAt),
          metricsFinalizedAt: optionalString(data.metricsFinalizedAt),
          metadata: {
            ...object(data.metadata),
            migratedFromV1: {
              eventId: optionalString(data.eventId),
              agentName: optionalString(data.agentName),
              config: data.config === undefined
                ? null
                : structuredClone(data.config),
              runSender: data.runSender === undefined
                ? null
                : structuredClone(data.runSender),
            },
          },
        }),
      ],
    );
    for (
      const link of [
        { sourceId: threadId, type: "has_llm_attempt" },
        ...(linkedMessageId
          ? [{ sourceId: linkedMessageId, type: "has_llm_attempt" }]
          : []),
        ...(participant
          ? [{ sourceId: participant.id, type: "performed_by" }]
          : []),
        ...(linkedParentId
          ? [{ sourceId: linkedParentId, type: "has_child_attempt" }]
          : []),
      ]
    ) {
      await ensureEdge(transaction, schema, {
        namespace: row.namespace,
        sourceId: link.sourceId,
        targetId: row.id,
        type: link.type,
      });
    }
  }
  return participantsCreated;
}

async function assetContentRef(
  transaction: SqlExecutor,
  schema: string,
  input: Readonly<{
    namespace: string;
    ownerId: string;
    assetId: string;
    role: string;
    name?: string | null;
  }>,
): Promise<MigratedContentRef> {
  const result = await transaction.query<{ data: unknown }>(
    `SELECT data FROM ${qualified(schema, "nodes")}
     WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
    [input.namespace, input.assetId],
  );
  const data = object(result.rows[0]?.data);
  const mediaType = optionalString(data.mediaType);
  if (!mediaType || !canonicalAssetData(data)) {
    throw new Error(
      `Legacy owner '${input.ownerId}' references unreadable asset '${input.assetId}'.`,
    );
  }
  await ensureEdge(transaction, schema, {
    namespace: input.namespace,
    sourceId: input.ownerId,
    targetId: input.assetId,
    type: "has_asset",
  });
  return Object.freeze({
    assetId: input.assetId,
    kind: contentKind(mediaType),
    role: input.role,
    mediaType,
    ...(input.name ? { name: input.name } : {}),
  });
}

function knowledgeStatus(
  value: unknown,
): "pending" | "processing" | "indexed" | "duplicate" | "failed" {
  if (
    value === "pending" || value === "processing" || value === "indexed" ||
    value === "duplicate" || value === "failed"
  ) return value;
  return "pending";
}

async function normalizeKnowledgeDocuments(
  transaction: SqlExecutor,
  schema: string,
): Promise<void> {
  for (const row of await loadNodes(transaction, schema, ["document"])) {
    const data = object(row.data);
    let source: MigratedContentRef[] = isCanonicalContent(data.source)
      ? structuredClone(data.source)
      : [];
    if (source.length > 0) {
      await linkCanonicalContent(
        transaction,
        schema,
        row.namespace,
        row.id,
        source,
      );
    } else {
      const assetId = optionalString(data.assetId);
      if (assetId) {
        source = [
          await assetContentRef(transaction, schema, {
            namespace: row.namespace,
            ownerId: row.id,
            assetId,
            role: "document.source",
            name: optionalString(data.title) ?? row.name,
          }),
        ];
      } else if (row.content !== null) {
        source = [
          await materializeLegacyContent(transaction, schema, {
            namespace: row.namespace,
            ownerId: row.id,
            role: "document.source",
            value: row.content,
            mediaType: optionalString(data.mediaType) ??
              optionalString(data.mimeType) ?? "text/plain;charset=utf-8",
            name: optionalString(data.title) ?? row.name,
            cache: new Map(),
          }),
        ];
      }
    }
    const metadata = object(data.metadata);
    const scope = object(metadata.scope);
    const threadId = optionalString(data.threadId) ??
      optionalString(scope.threadId) ??
      (row.source_type === "thread" ? optionalString(row.source_id) : null);
    const readableThreadId = await nodeExists(
        transaction,
        schema,
        row.namespace,
        threadId,
        "thread",
      )
      ? threadId
      : null;
    const mediaType = optionalString(data.mediaType) ??
      optionalString(data.mimeType) ?? source[0]?.mediaType ?? null;
    const errorMessage = optionalString(data.errorMessage);
    await transaction.query(
      `UPDATE ${qualified(schema, "nodes")}
       SET content = NULL, data = $3::jsonb,
         source_type = $4, source_id = $5
       WHERE namespace = $1 AND id = $2 AND type = 'document'`,
      [
        row.namespace,
        row.id,
        json({
          sourceType: optionalString(data.sourceType) ??
            (source.length ? "asset" : "text"),
          sourceUri: optionalString(data.sourceUri),
          title: optionalString(data.title) ?? row.name,
          mediaType,
          contentHash: optionalString(data.contentHash),
          source,
          status: knowledgeStatus(data.status),
          chunkCount: finiteNonNegativeInteger(data.chunkCount) ?? 0,
          duplicateOfDocumentId: optionalString(data.duplicateOfDocumentId),
          threadId: readableThreadId,
          requestedByParticipantId: optionalString(
            data.requestedByParticipantId,
          ),
          forceReindex: data.forceReindex === true,
          error: errorMessage
            ? { code: "legacy_ingestion_error", message: errorMessage }
            : (Object.keys(object(data.error)).length > 0
              ? object(data.error)
              : null),
          externalId: optionalString(data.externalId),
          metadata: {
            ...metadata,
            migratedFromV1: {
              ...object(metadata.migratedFromV1),
              assetId: optionalString(data.assetId),
              mimeType: optionalString(data.mimeType),
            },
          },
        }),
        readableThreadId ? "thread" : null,
        readableThreadId,
      ],
    );
    if (readableThreadId) {
      await ensureEdge(transaction, schema, {
        namespace: row.namespace,
        sourceId: readableThreadId,
        targetId: row.id,
        type: "has_document",
      });
    }
  }
}

async function normalizeLongTermMemory(
  transaction: SqlExecutor,
  schema: string,
): Promise<void> {
  for (
    const row of await loadNodes(transaction, schema, ["long_term_memory"])
  ) {
    const data = object(row.data);
    let content: MigratedContentRef[] = isCanonicalContent(data.content)
      ? structuredClone(data.content)
      : [];
    if (content.length > 0) {
      await linkCanonicalContent(
        transaction,
        schema,
        row.namespace,
        row.id,
        content,
      );
    } else {
      const body = typeof data.content === "string"
        ? data.content
        : row.content;
      if (body !== null) {
        content = [
          await materializeLegacyContent(transaction, schema, {
            namespace: row.namespace,
            ownerId: row.id,
            role: "memory.snapshot",
            value: body,
            cache: new Map(),
          }),
        ];
      }
    }
    const threadId = optionalString(data.threadId) ??
      (row.source_type === "thread" ? optionalString(row.source_id) : null);
    const readableThreadId = await nodeExists(
        transaction,
        schema,
        row.namespace,
        threadId,
        "thread",
      )
      ? threadId
      : null;
    await transaction.query(
      `UPDATE ${qualified(schema, "nodes")}
       SET content = NULL,
         data = (COALESCE(data, '{}'::jsonb) || $3::jsonb),
         source_type = $4, source_id = $5
       WHERE namespace = $1 AND id = $2 AND type = 'long_term_memory'`,
      [
        row.namespace,
        row.id,
        json({
          content,
          metadata: {
            ...object(data.metadata),
            migratedFromV1: {
              ...object(object(data.metadata).migratedFromV1),
              canonicalContent: true,
            },
          },
        }),
        readableThreadId ? "thread" : row.source_type,
        readableThreadId ?? row.source_id,
      ],
    );
    if (readableThreadId) {
      await ensureEdge(transaction, schema, {
        namespace: row.namespace,
        sourceId: readableThreadId,
        targetId: row.id,
        type: "has_long_term_memory",
      });
    }
  }
}

async function loadLegacyEvents(
  transaction: SqlExecutor,
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
     FROM ${qualified(schema, "events_v1_upgrade")}
     WHERE status NOT IN ('pending', 'processing')
     ORDER BY "createdAt", id`,
  );
  return result.rows;
}

async function copyEvents(
  transaction: SqlExecutor,
  schema: string,
): Promise<number> {
  let count = 0;
  for (const row of await loadLegacyEvents(transaction, schema)) {
    if (EPHEMERAL_TYPES.has(row.event_type)) continue;
    const metadata = {
      ...object(row.metadata),
      migratedFromV1: true,
      legacyStatus: row.status,
    };
    const delta = {
      ...(row.operation == null ? {} : { operation: row.operation }),
      ...(row.input == null ? {} : { input: row.input }),
      ...(row.before == null ? {} : { before: row.before }),
      ...(row.after == null ? {} : { after: row.after }),
      ...(row.patch == null ? {} : { patch: row.patch }),
    };
    const result = await transaction.query<{ id: string }>(
      `INSERT INTO ${qualified(schema, "events")} (
         id, schema_version, type, namespace, thread_id,
         subject_type, subject_id, payload, delta, routing, visibility,
         metadata, causation_id, correlation_id, deduplication_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8::jsonb, $9::jsonb, '{}'::jsonb, $10::jsonb,
         $11::jsonb, $12, $13, $14, $15::timestamptz
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        row.id,
        EVENT_SCHEMA_VERSION,
        semanticEventType(row),
        row.namespace?.trim() || "default",
        row.thread_id || null,
        row.subject_type,
        row.subject_id,
        json(row.payload),
        json(delta),
        json(eventVisibility(row)),
        json(metadata),
        row.causation_id ?? row.parent_event_id,
        row.correlation_id ?? row.trace_id ?? row.id,
        row.dedupe_key,
        iso(row.created_at),
      ],
    );
    count += result.rows.length;
  }
  return count;
}

async function updateThreadActivity(
  transaction: SqlExecutor,
  schema: string,
): Promise<void> {
  await transaction.query(
    `WITH latest AS (
       SELECT DISTINCT ON (namespace, thread_id)
         namespace, thread_id, id, position, created_at
       FROM ${qualified(schema, "events")}
       WHERE thread_id IS NOT NULL
       ORDER BY namespace, thread_id, position DESC
     )
     UPDATE ${qualified(schema, "nodes")} AS node
     SET data = COALESCE(node.data, '{}'::jsonb) || jsonb_build_object(
       'lastEventId', latest.id,
       'lastEventPosition', latest.position::text,
       'lastEventAt', latest.created_at
     ), updated_at = GREATEST(node.updated_at, latest.created_at)
     FROM latest
     WHERE node.id = latest.thread_id
       AND node.namespace = latest.namespace
       AND node.type = 'thread'`,
  );
}

async function dropStagedTables(
  transaction: SqlExecutor,
  schema: string,
  staged: { nodes: boolean; edges: boolean; threads: boolean },
): Promise<void> {
  if (staged.edges) {
    await transaction.query(
      `DROP TABLE ${qualified(schema, "edges_v1_upgrade")}`,
    );
  }
  if (staged.nodes) {
    await transaction.query(
      `DROP TABLE ${qualified(schema, "nodes_v1_upgrade")}`,
    );
  }
  if (staged.threads) {
    await transaction.query(
      `DROP TABLE ${qualified(schema, "threads_v1_upgrade")}`,
    );
  }
  await transaction.query(
    `DROP TABLE ${qualified(schema, "events_v1_upgrade")}`,
  );
}

async function upgradedResult(
  session: SqlSession,
  schema: string,
): Promise<UpgradeV1SchemaResult> {
  return Object.freeze({
    schema,
    nodes: await countTable(session, schema, "nodes"),
    edges: await countTable(session, schema, "edges"),
    threads: 0,
    participantsCreated: 0,
    events: await countTable(session, schema, "events"),
    alreadyUpgraded: true,
  });
}

/** Upgrades one tenant schema atomically after active legacy work is drained. */
export async function upgradeV1Schema(
  session: SqlSession,
  schemaName: string,
  options: UpgradeV1SchemaOptions = {},
): Promise<UpgradeV1SchemaResult> {
  const schema = validateEventSchemaName(schemaName);
  if (await isAlreadyUpgraded(session, schema)) {
    return await upgradedResult(session, schema);
  }
  if (!await tableExists(session, schema, "events")) {
    throw new Error(`Schema '${schema}' has no Copilotz event table.`);
  }
  await assertLegacyWorkDrained(session, schema);

  return await session.transaction(async (transaction) => {
    const eventsStaged = await stageTable(transaction, schema, "events");
    if (!eventsStaged) {
      throw new Error(`Schema '${schema}' has no v1 event table.`);
    }
    const staged = {
      threads: await stageTable(transaction, schema, "threads"),
      edges: await stageTable(transaction, schema, "edges"),
      nodes: await stageTable(transaction, schema, "nodes"),
    };

    for (const statement of createCoreSchemaStatements(schema)) {
      await transaction.query(statement);
    }

    const nodes = await copyNodes(transaction, schema, staged.nodes);
    const edges = await copyEdges(transaction, schema, staged.edges);
    await canonicalizeLegacyAssets(transaction, schema, options);
    const threads = await loadThreads(transaction, schema);
    const namespaces = new Map<string, string>();
    for (const thread of threads) {
      namespaces.set(
        thread.id,
        await upsertThreadNode(transaction, schema, thread),
      );
    }

    let participantsCreated = 0;
    for (const thread of threads) {
      const namespace = namespaces.get(thread.id)!;
      await ensureThreadParentEdge(transaction, schema, thread, namespace);
      participantsCreated += await ensureThreadParticipants(
        transaction,
        schema,
        thread,
        namespace,
      );
    }
    participantsCreated += await normalizeParticipantNodes(
      transaction,
      schema,
    );
    participantsCreated += await normalizeMessages(transaction, schema);
    participantsCreated += await normalizeToolExecutions(transaction, schema);
    participantsCreated += await normalizeLlmAttempts(transaction, schema);
    await normalizeKnowledgeDocuments(transaction, schema);
    await normalizeLongTermMemory(transaction, schema);

    const events = await copyEvents(transaction, schema);
    await updateThreadActivity(transaction, schema);
    await dropStagedTables(transaction, schema, staged);

    return Object.freeze({
      schema,
      nodes,
      edges,
      threads: threads.length,
      participantsCreated,
      events,
      alreadyUpgraded: false,
    });
  });
}

export async function discoverV1Schemas(
  session: SqlSession,
): Promise<readonly string[]> {
  const result = await session.query<{ table_schema: string }>(
    `SELECT DISTINCT table_schema
     FROM information_schema.columns
     WHERE table_name = 'events' AND column_name = 'eventType'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_schema NOT LIKE 'pg_toast%'
     ORDER BY table_schema`,
  );
  return result.rows.map((row) => row.table_schema);
}

/** Upgrades each selected tenant independently; no normal runtime imports it. */
export async function upgradeV1Schemas(
  session: SqlSession,
  options: UpgradeV1SchemasOptions = {},
): Promise<readonly UpgradeV1SchemaResult[]> {
  const schemas = options.schemas?.map(validateEventSchemaName) ??
    await discoverV1Schemas(session);
  const results: UpgradeV1SchemaResult[] = [];
  for (const schema of schemas) {
    results.push(
      await upgradeV1Schema(session, schema, {
        resolveLegacyAsset: options.resolveLegacyAsset,
      }),
    );
  }
  return results;
}

export { createCoreTableNames };
