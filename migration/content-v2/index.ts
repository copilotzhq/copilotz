/** Explicit current-schema repair and database-to-object content migration. */
import {
  assetBodyKey,
  createBodyStorageRuntime,
  digestContent,
} from "../../runtime/content/index.ts";
import type {
  AssetOrigin,
  BodyHead,
  BodyStorageOptions,
  BodyStore,
} from "../../runtime/content/index.ts";
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../../runtime/events/schema.ts";
import type { SqlExecutor, SqlSession } from "../../runtime/events/index.ts";
import {
  finalizeLegacyToolMessageRepair,
  planLegacyToolMessageRepair,
  repairLegacyToolMessages,
  type ToolMessageRepairReport,
} from "./semantic.ts";

type AssetRow = {
  id: string;
  namespace: string;
  data: unknown;
  created_at: string | Date;
  cursor_created_at: string;
};

type AssetBodyRow = {
  id: string;
  namespace: string;
  body: string;
  encoding: string;
  media_type: string;
  digest: string;
  byte_length: string | number;
};

export type ContentV2MigrationMode = "dry-run" | "apply";
export type ContentV2SemanticIndexMode = "blocking" | "concurrent";

export type ContentV2SchemaReport =
  & ToolMessageRepairReport
  & Readonly<{
    schema: string;
    mode: ContentV2MigrationMode;
    databaseAssets: number;
    uploadedObjects: number;
    bytesMoved: number;
    failures: readonly Readonly<{ id: string; message: string }>[];
  }>;

export type ContentV2MigrationProgress = Readonly<{
  schema: string;
  mode: ContentV2MigrationMode;
  stage: "planning" | "semantic" | "assets" | "complete";
  processed: number;
  total?: number;
  bytesMoved?: number;
}>;

export type MigrateContentV2SchemaOptions = Readonly<{
  mode?: ContentV2MigrationMode;
  assets?: BodyStorageOptions;
  batchSize?: number;
  semanticBatchSize?: number;
  semanticConcurrency?: number;
  semanticIndexMode?: ContentV2SemanticIndexMode;
  uploadConcurrency?: number;
  bodyBatchMaxBytes?: number;
  onProgress?: (
    progress: ContentV2MigrationProgress,
  ) => void | Promise<void>;
}>;

function emptySemanticReport(): ToolMessageRepairReport {
  return {
    candidateMessages: 0,
    mergedExecutions: 0,
    synthesizedExecutions: 0,
    extractedAssets: 0,
    deletedMessages: 0,
    deletedDuplicateEvents: 0,
    deletedOrphanAssets: 0,
  };
}

function addSemanticReport(
  target: ToolMessageRepairReport,
  source: ToolMessageRepairReport,
): void {
  target.candidateMessages += source.candidateMessages;
  target.mergedExecutions += source.mergedExecutions;
  target.synthesizedExecutions += source.synthesizedExecutions;
  target.extractedAssets += source.extractedAssets;
  target.deletedMessages += source.deletedMessages;
  target.deletedDuplicateEvents += source.deletedDuplicateEvents;
  target.deletedOrphanAssets += source.deletedOrphanAssets;
}

function q(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

type SemanticIndex = Readonly<{
  name: string;
  table: "nodes" | "events";
  definition: string;
}>;

const SEMANTIC_INDEXES: readonly SemanticIndex[] = Object.freeze([
  {
    name: "_copilotz_content_v2_tool_message_created_idx",
    table: "nodes",
    definition: `(created_at, id)
      WHERE type = 'message'
        AND data -> 'metadata' -> 'migratedFromV1' ->> 'senderType' = 'tool'`,
  },
  {
    name: "_copilotz_content_v2_tool_execution_lookup_idx",
    table: "nodes",
    definition: `(namespace, (data ->> 'threadId'),
        (data ->> 'toolCallId'),
        (COALESCE(data -> 'tool' ->> 'id', data ->> 'toolId')),
        created_at, id)
      WHERE type = 'tool_execution'`,
  },
  {
    name: "_copilotz_content_v2_participant_external_idx",
    table: "nodes",
    definition: `(namespace, (data ->> 'externalId'), created_at, id)
      WHERE type = 'participant'`,
  },
  {
    name: "_copilotz_content_v2_message_event_subject_idx",
    table: "events",
    definition: `(namespace, subject_id)
      WHERE type = 'message.created'
        AND metadata ->> 'migratedFromV1' = 'true'`,
  },
  {
    name: "_copilotz_content_v2_message_event_payload_idx",
    table: "events",
    definition: `(namespace, (payload ->> 'messageId'))
      WHERE type = 'message.created'
        AND metadata ->> 'migratedFromV1' = 'true'`,
  },
]);

const ASSET_RELOCATION_INDEX: SemanticIndex = Object.freeze({
  name: "_copilotz_content_v2_database_asset_created_idx",
  table: "nodes",
  definition: `(created_at, id)
    WHERE type = 'asset'
      AND data ->> 'state' = 'ready'
      AND data -> 'location' ->> 'kind' = 'database'`,
});

// Keep concurrent transactions large enough to amortize commit and connection
// round trips, but bounded so a retry never rolls back an unreasonably large
// partition. The planner page size remains independently tunable up to 1,000.
const MAX_CONCURRENT_SEMANTIC_TRANSACTION_SIZE = 100;
const DEFAULT_BODY_BATCH_MAX_BYTES = 64 * 1024 * 1024;
const MAX_BODY_BATCH_MAX_BYTES = 1024 * 1024 * 1024;

async function createSemanticIndexes(
  session: SqlSession,
  schema: string,
  mode: ContentV2SemanticIndexMode,
): Promise<void> {
  for (const index of SEMANTIC_INDEXES) {
    await createMigrationIndex(session, schema, mode, index);
  }
}

async function createAssetRelocationIndex(
  session: SqlSession,
  schema: string,
  mode: ContentV2SemanticIndexMode,
): Promise<void> {
  await createMigrationIndex(session, schema, mode, ASSET_RELOCATION_INDEX);
}

async function createMigrationIndex(
  session: SqlSession,
  schema: string,
  mode: ContentV2SemanticIndexMode,
  index: SemanticIndex,
): Promise<void> {
  const valid = await session.query<{ valid: boolean }>(
    `SELECT index_state.indisvalid AND index_state.indisready AS valid
     FROM pg_catalog.pg_index index_state
     JOIN pg_catalog.pg_class index_class
       ON index_class.oid = index_state.indexrelid
     JOIN pg_catalog.pg_namespace index_namespace
       ON index_namespace.oid = index_class.relnamespace
     WHERE index_namespace.nspname = $1 AND index_class.relname = $2`,
    [schema, index.name],
  );
  if (valid.rows[0]?.valid === true) return;
  // PostgreSQL leaves an invalid relation behind when a concurrent build is
  // interrupted. Remove it explicitly so IF NOT EXISTS cannot mask a broken
  // resumability index on the next run.
  await dropSemanticIndex(session, schema, mode, index.name);
  await session.query(
    `CREATE INDEX ${mode === "concurrent" ? "CONCURRENTLY " : ""}IF NOT EXISTS
       ${quoteEventIdentifier(index.name)} ON ${q(schema, index.table)}
       ${index.definition}`,
  );
}

async function dropSemanticIndex(
  session: SqlSession,
  schema: string,
  mode: ContentV2SemanticIndexMode,
  name: string,
): Promise<void> {
  await session.query(
    `DROP INDEX ${mode === "concurrent" ? "CONCURRENTLY " : ""}IF EXISTS
       ${q(schema, name)}`,
  );
}

async function dropSemanticIndexes(
  session: SqlSession,
  schema: string,
  mode: ContentV2SemanticIndexMode,
): Promise<void> {
  for (const index of [...SEMANTIC_INDEXES].reverse()) {
    await dropSemanticIndex(session, schema, mode, index.name);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function databaseBytes(assetId: string, row: AssetBodyRow): Uint8Array {
  if (typeof row.body !== "string") {
    throw new Error(`Asset '${assetId}' is not a readable database body.`);
  }
  return row.encoding === "base64"
    ? decodeBase64(row.body)
    : new TextEncoder().encode(row.body);
}

function storedOrigin(
  value: unknown,
  namespace: string,
): AssetOrigin {
  const fields = record(value);
  if (
    Object.keys(fields).length === 2 && typeof fields.type === "string" &&
    fields.type.trim() && typeof fields.id === "string" && fields.id.trim()
  ) return { type: fields.type.trim(), id: fields.id.trim() };
  const scope = record(fields.scope);
  if (scope.type === "thread" && typeof scope.id === "string") {
    const id = scope.id.trim();
    if (id) return { type: "thread", id };
  }
  if (
    scope.type === "collection" && typeof scope.collection === "string" &&
    typeof scope.id === "string"
  ) {
    const type = scope.collection.trim();
    const id = scope.id.trim();
    if (type && id) return { type, id };
  }
  return { type: "namespace", id: namespace };
}

async function inferOrigins(
  session: SqlExecutor,
  schema: string,
  rows: readonly AssetRow[],
): Promise<ReadonlyMap<string, AssetOrigin>> {
  const origins = new Map<string, AssetOrigin>();
  const unresolved: AssetRow[] = [];
  for (const row of rows) {
    const origin = record(row.data).origin;
    if (origin !== undefined) {
      origins.set(row.id, storedOrigin(origin, row.namespace));
    } else unresolved.push(row);
  }
  if (unresolved.length === 0) return origins;
  const owners = await session.query<
    { asset_id: string; id: string; type: string; data: unknown }
  >(
    `SELECT DISTINCT ON (edge.target_node_id)
       edge.target_node_id AS asset_id, owner.id, owner.type, owner.data
     FROM ${q(schema, "edges")} edge
     JOIN ${q(schema, "nodes")} owner
       ON owner.namespace = edge.namespace AND owner.id = edge.source_node_id
     WHERE edge.target_node_id = ANY($1::text[]) AND edge.type = 'has_asset'
     ORDER BY edge.target_node_id, edge.created_at, edge.id`,
    [unresolved.map((row) => row.id)],
  );
  const ownersByAsset = new Map(
    owners.rows.map((owner) => [owner.asset_id, owner]),
  );
  for (const row of unresolved) {
    const found = ownersByAsset.get(row.id);
    if (!found) {
      origins.set(row.id, {
        type: "namespace",
        id: row.namespace,
      });
      continue;
    }
    const data = record(found.data);
    const threadId = typeof data.threadId === "string"
      ? data.threadId
      : undefined;
    origins.set(row.id, {
      type: threadId ? "thread" : found.type,
      id: threadId ?? found.id,
    });
  }
  return origins;
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  if (values.length === 0) return Object.freeze([]);
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(values.length, concurrency) },
      async () => {
        while (true) {
          const index = cursor++;
          if (index >= values.length) return;
          results[index] = await run(values[index]);
        }
      },
    ),
  );
  return Object.freeze(results);
}

type AssetRelocationFailure = Readonly<{ id: string; message: string }>;

type AssetRelocationPageResult = Readonly<{
  uploadedObjects: number;
  bytesMoved: number;
  failures: readonly AssetRelocationFailure[];
}>;

/**
 * Keeps every decoded body, upload request, and row snapshot inside one
 * short-lived async frame. Large migrations can therefore release a complete
 * page before fetching the next one instead of retaining loop-frame transport
 * state until the whole schema settles.
 */
async function relocateAssetPage(
  session: SqlSession,
  schema: string,
  rows: readonly AssetRow[],
  objectWriter: BodyStore,
  prefix: string,
  uploadConcurrency: number,
  bodyBatchMaxBytes: number,
): Promise<AssetRelocationPageResult> {
  const origins = await inferOrigins(session, schema, rows);
  type Uploaded = Readonly<{
    row: AssetRow;
    origin: AssetOrigin;
    head: BodyHead;
    key: string;
  }>;
  type UploadResult =
    | Readonly<{ status: "uploaded"; value: Uploaded }>
    | Readonly<{
      status: "failed";
      id: string;
      message: string;
      conflict: boolean;
    }>;
  const slices: AssetRow[][] = [];
  let slice: AssetRow[] = [];
  let sliceBytes = 0;
  for (const row of rows) {
    const rawByteLength = Number(record(row.data).byteLength);
    const byteLength = Number.isSafeInteger(rawByteLength) && rawByteLength >= 0
      ? rawByteLength
      : bodyBatchMaxBytes;
    if (
      slice.length > 0 &&
      sliceBytes + byteLength > bodyBatchMaxBytes
    ) {
      slices.push(slice);
      slice = [];
      sliceBytes = 0;
    }
    slice.push(row);
    sliceBytes += byteLength;
  }
  if (slice.length > 0) slices.push(slice);

  const results: UploadResult[] = [];
  for (const slice of slices) {
    // Fetch exactly one byte-bounded slice per round trip. The slice can feed
    // multiple continuous uploader waves without a straggler barrier while
    // keeping the worst-case resident body set inside bodyBatchMaxBytes.
    const bodies = await session.query<AssetBodyRow>(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[])
           AS item(namespace, id)
       )
       SELECT asset.id, asset.namespace,
         asset.data ->> 'body' AS body,
         asset.data -> 'location' ->> 'encoding' AS encoding,
         asset.data ->> 'mediaType' AS media_type,
         asset.data ->> 'digest' AS digest,
         asset.data ->> 'byteLength' AS byte_length
       FROM requested
       JOIN ${q(schema, "nodes")} asset
         ON asset.namespace = requested.namespace AND asset.id = requested.id
       WHERE asset.type = 'asset'
         AND asset.data ->> 'state' = 'ready'
         AND asset.data -> 'location' ->> 'kind' = 'database'`,
      [
        slice.map((row) => row.namespace),
        slice.map((row) => row.id),
      ],
    );
    const bodiesByAsset = new Map(
      bodies.rows.map((body) => [
        `${body.namespace}\u0000${body.id}`,
        body,
      ]),
    );
    const uploaded = await mapBounded(
      slice,
      uploadConcurrency,
      async (row): Promise<UploadResult> => {
        try {
          const stored = bodiesByAsset.get(`${row.namespace}\u0000${row.id}`);
          if (!stored) {
            throw new Error("database asset body changed during relocation");
          }
          const mediaType = stored.media_type;
          const digest = stored.digest as `sha256:${string}`;
          const byteLength = Number(stored.byte_length);
          const bytes = databaseBytes(row.id, stored);
          if (
            !mediaType || !digest.startsWith("sha256:") ||
            bytes.byteLength !== byteLength ||
            await digestContent(bytes) !== digest
          ) {
            throw new Error("database asset integrity verification failed");
          }
          const origin = origins.get(row.id);
          if (!origin) throw new Error("asset origin inference failed");
          const key = assetBodyKey({
            prefix,
            databaseSchema: schema,
            namespace: row.namespace,
            assetId: row.id,
            origin,
          });
          const head = await objectWriter.put({
            bodyId: key,
            bytes,
            mediaType,
            digest,
            ifAbsent: true,
          });
          return {
            status: "uploaded",
            value: { row, origin, head, key },
          };
        } catch (error) {
          return {
            status: "failed",
            id: row.id,
            message: error instanceof Error ? error.message : String(error),
            conflict: (error as { code?: string }).code === "asset_conflict",
          };
        }
      },
    );
    results.push(...uploaded);
  }
  const conflict = results.find((result) =>
    result.status === "failed" && result.conflict
  );
  if (conflict?.status === "failed") {
    throw new Error(
      `Asset '${conflict.id}' conflicts with its existing object: ${conflict.message}`,
    );
  }
  const failures = results.flatMap((result) =>
    result.status === "failed"
      ? [{ id: result.id, message: result.message }]
      : []
  );
  const uploaded = results.flatMap((result) =>
    result.status === "uploaded" ? [result.value] : []
  );
  if (uploaded.length === 0) {
    return Object.freeze({ uploadedObjects: 0, bytesMoved: 0, failures });
  }
  const moved = uploaded.map(({ row, origin, head, key }) => ({
    id: row.id,
    namespace: row.namespace,
    digest: String(record(row.data).digest),
    location: {
      kind: "object",
      backendId: objectWriter.backendId,
      key,
      ...(head.etag ? { etag: head.etag } : {}),
    },
    origin,
  }));
  const changed = await session.transaction((transaction) =>
    transaction.query<{ id: string }>(
      `WITH moved AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           id text,
           namespace text,
           digest text,
           location jsonb,
           origin jsonb
         )
       )
       UPDATE ${q(schema, "nodes")} asset
       SET data = (asset.data - 'body') || jsonb_build_object(
         'location', moved.location,
         'origin', moved.origin
       ), updated_at = NOW()
       FROM moved
       WHERE asset.namespace = moved.namespace AND asset.id = moved.id
         AND asset.type = 'asset'
         AND asset.data ->> 'state' = 'ready'
         AND asset.data -> 'location' ->> 'kind' = 'database'
         AND asset.data ->> 'digest' = moved.digest
       RETURNING asset.id`,
      [JSON.stringify(moved)],
    )
  );
  const changedIds = new Set(changed.rows.map((row) => row.id));
  let uploadedObjects = 0;
  let bytesMoved = 0;
  for (const item of uploaded) {
    if (!changedIds.has(item.row.id)) continue;
    uploadedObjects++;
    bytesMoved += Number(record(item.row.data).byteLength);
  }
  return Object.freeze({ uploadedObjects, bytesMoved, failures });
}

async function dryRunCounts(session: SqlExecutor, schema: string) {
  const messages = await session.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${q(schema, "nodes")}
     WHERE type = 'message'
       AND data -> 'metadata' -> 'migratedFromV1' ->> 'senderType' = 'tool'`,
  );
  const assets = await session.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${q(schema, "nodes")}
     WHERE type = 'asset' AND data ->> 'state' = 'ready'
       AND data -> 'location' ->> 'kind' = 'database'`,
  );
  return {
    messages: Number(messages.rows[0]?.count ?? 0),
    assets: Number(assets.rows[0]?.count ?? 0),
  };
}

/** Repairs tool history, then relocates every ready database asset when object storage is configured. */
export async function migrateContentV2Schema(
  session: SqlSession,
  schemaName: string,
  options: MigrateContentV2SchemaOptions = {},
): Promise<ContentV2SchemaReport> {
  const schema = validateEventSchemaName(schemaName);
  const mode = options.mode ?? "dry-run";
  const batchSize = options.batchSize ?? 100;
  const semanticBatchSize = options.semanticBatchSize ?? 250;
  const semanticConcurrency = options.semanticConcurrency ?? 1;
  const semanticIndexMode = options.semanticIndexMode ?? "blocking";
  const uploadConcurrency = options.uploadConcurrency ?? 8;
  const bodyBatchMaxBytes = options.bodyBatchMaxBytes ??
    DEFAULT_BODY_BATCH_MAX_BYTES;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1_000) {
    throw new TypeError("content-v2 batchSize must be between 1 and 1000.");
  }
  if (
    !Number.isSafeInteger(semanticBatchSize) || semanticBatchSize <= 0 ||
    semanticBatchSize > 1_000
  ) {
    throw new TypeError(
      "content-v2 semanticBatchSize must be between 1 and 1000.",
    );
  }
  if (
    !Number.isSafeInteger(semanticConcurrency) || semanticConcurrency <= 0 ||
    semanticConcurrency > 32
  ) {
    throw new TypeError(
      "content-v2 semanticConcurrency must be between 1 and 32.",
    );
  }
  if (
    semanticIndexMode !== "blocking" && semanticIndexMode !== "concurrent"
  ) {
    throw new TypeError(
      "content-v2 semanticIndexMode must be 'blocking' or 'concurrent'.",
    );
  }
  if (
    !Number.isSafeInteger(uploadConcurrency) || uploadConcurrency <= 0 ||
    uploadConcurrency > 128
  ) {
    throw new TypeError(
      "content-v2 uploadConcurrency must be between 1 and 128.",
    );
  }
  if (
    !Number.isSafeInteger(bodyBatchMaxBytes) || bodyBatchMaxBytes <= 0 ||
    bodyBatchMaxBytes > MAX_BODY_BATCH_MAX_BYTES
  ) {
    throw new TypeError(
      "content-v2 bodyBatchMaxBytes must be between 1 byte and 1 GiB.",
    );
  }
  const counts = await dryRunCounts(session, schema);
  await options.onProgress?.({
    schema,
    mode,
    stage: "planning",
    processed: 0,
    total: counts.messages,
  });
  if (mode === "dry-run") {
    const planned = await planLegacyToolMessageRepair(session, schema, {
      batchSize: semanticBatchSize,
    });
    const result = Object.freeze({
      schema,
      mode,
      ...planned.report,
      databaseAssets: counts.assets + planned.databaseAssetDelta,
      uploadedObjects: 0,
      bytesMoved: 0,
      failures: Object.freeze([]),
    });
    await options.onProgress?.({
      schema,
      mode,
      stage: "complete",
      processed: planned.report.candidateMessages,
      total: planned.report.candidateMessages,
    });
    return result;
  }
  const storage = createBodyStorageRuntime(options.assets);
  const objectWriter = storage.writer;
  if (!objectWriter || objectWriter.kind !== "object") {
    throw new Error(
      `Schema '${schema}' apply mode requires an object body store.`,
    );
  }
  if (counts.messages > 0) {
    // Migration-scoped partial indexes turn the ordered claim and repeated
    // execution, participant, and migrated-event resolution into bounded
    // lookups. They are removed after semantic repair settles.
    await createSemanticIndexes(session, schema, semanticIndexMode);
  }
  // Refuse ambiguous history before committing any resumable batch.
  const preflight = await planLegacyToolMessageRepair(session, schema, {
    batchSize: semanticBatchSize,
  });
  const semantic = emptySemanticReport();
  let semanticFailure: unknown;
  let lastReported = 0;
  let progressTail = Promise.resolve();
  const semanticWorkerCount = Math.min(
    semanticConcurrency,
    preflight.report.candidateMessages,
  );
  const reportProgress = (processed: number) => {
    if (
      processed !== preflight.report.candidateMessages &&
      processed - lastReported < semanticBatchSize
    ) return progressTail;
    lastReported = processed;
    progressTail = progressTail.then(() =>
      options.onProgress?.({
        schema,
        mode,
        stage: "semantic",
        processed,
        total: preflight.report.candidateMessages,
      })
    ).then(() => undefined);
    return progressTail;
  };
  const repairWorker = async (workerIndex: number) => {
    while (
      semanticFailure === undefined &&
      semantic.candidateMessages < preflight.report.candidateMessages
    ) {
      let batch: ToolMessageRepairReport;
      try {
        batch = await session.transaction((transaction) =>
          repairLegacyToolMessages(transaction, schema, {
            batchSize: semanticWorkerCount <= 1 ? semanticBatchSize : Math.min(
              semanticBatchSize,
              MAX_CONCURRENT_SEMANTIC_TRANSACTION_SIZE,
            ),
            finalize: false,
            concurrent: semanticWorkerCount > 1,
            ...(semanticWorkerCount <= 1 ? {} : {
              partition: {
                index: workerIndex,
                count: semanticWorkerCount,
              },
            }),
          })
        );
      } catch (error) {
        semanticFailure ??= error;
        return;
      }
      if (batch.candidateMessages === 0) {
        // Every concurrent worker owns a stable logical-execution partition,
        // so an empty claim means that partition is complete; no polling is
        // needed.
        return;
      }
      addSemanticReport(semantic, batch);
      await reportProgress(semantic.candidateMessages);
    }
  };
  await Promise.all(
    Array.from(
      { length: semanticWorkerCount },
      (_, workerIndex) => repairWorker(workerIndex),
    ),
  );
  await progressTail;
  if (semanticFailure !== undefined) throw semanticFailure;
  const finalized = await session.transaction((transaction) =>
    finalizeLegacyToolMessageRepair(transaction, schema)
  );
  addSemanticReport(semantic, finalized);
  await dropSemanticIndexes(session, schema, semanticIndexMode);
  const postRepairCounts = await dryRunCounts(session, schema);
  /*
   * Semantic repair commits before relocation so each copied body remains
   * independently resumable. Configuration is validated before that commit.
   */
  if (postRepairCounts.assets === 0) {
    return Object.freeze({
      schema,
      mode,
      ...semantic,
      databaseAssets: 0,
      uploadedObjects: 0,
      bytesMoved: 0,
      failures: Object.freeze([]),
    });
  }
  // Keep interrupted relocation resumable without repeatedly scanning every
  // graph node. A successful run removes this migration-only index; an
  // interrupted run reuses it on the next attempt.
  await createAssetRelocationIndex(session, schema, semanticIndexMode);
  let cursorCreatedAt: string | null = null;
  let cursorId = "";
  let uploadedObjects = 0;
  let bytesMoved = 0;
  const failures: { id: string; message: string }[] = [];
  while (true) {
    const page: { rows: AssetRow[] } = await session.query<AssetRow>(
      `SELECT id, namespace, data - 'body' AS data, created_at,
         created_at::text AS cursor_created_at
       FROM ${q(schema, "nodes")}
       WHERE type = 'asset' AND data ->> 'state' = 'ready'
         AND data -> 'location' ->> 'kind' = 'database'
         AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2))
       ORDER BY created_at, id LIMIT $3`,
      [cursorCreatedAt, cursorId, batchSize],
    );
    if (page.rows.length === 0) break;
    const relocated = await relocateAssetPage(
      session,
      schema,
      page.rows,
      objectWriter,
      storage.prefix,
      uploadConcurrency,
      bodyBatchMaxBytes,
    );
    uploadedObjects += relocated.uploadedObjects;
    bytesMoved += relocated.bytesMoved;
    failures.push(...relocated.failures);
    const last: AssetRow = page.rows.at(-1)!;
    cursorCreatedAt = last.cursor_created_at;
    cursorId = last.id;
    await options.onProgress?.({
      schema,
      mode,
      stage: "assets",
      processed: uploadedObjects + failures.length,
      total: postRepairCounts.assets,
      bytesMoved,
    });
  }
  if (failures.length === 0) {
    await dropSemanticIndex(
      session,
      schema,
      semanticIndexMode,
      ASSET_RELOCATION_INDEX.name,
    );
  }
  const result = Object.freeze({
    schema,
    mode,
    ...semantic,
    databaseAssets: postRepairCounts.assets,
    uploadedObjects,
    bytesMoved,
    failures: Object.freeze(failures),
  });
  await options.onProgress?.({
    schema,
    mode,
    stage: "complete",
    processed: uploadedObjects + failures.length,
    total: postRepairCounts.assets,
    bytesMoved,
  });
  return result;
}

export async function discoverContentV2Schemas(
  session: SqlSession,
): Promise<readonly string[]> {
  const result = await session.query<{ table_schema: string }>(
    `SELECT DISTINCT table_schema
     FROM information_schema.columns
     WHERE table_name = 'events' AND column_name = 'position'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_schema NOT LIKE 'pg_toast%'
     ORDER BY table_schema`,
  );
  return Object.freeze(result.rows.map((row) => row.table_schema));
}

export async function migrateContentV2Schemas(
  session: SqlSession,
  options:
    & MigrateContentV2SchemaOptions
    & Readonly<{ schemas?: readonly string[] }> = {},
): Promise<readonly ContentV2SchemaReport[]> {
  const schemas = options.schemas ?? await discoverContentV2Schemas(session);
  const reports: ContentV2SchemaReport[] = [];
  for (const schema of schemas) {
    reports.push(await migrateContentV2Schema(session, schema, options));
  }
  return Object.freeze(reports);
}
