/** Explicit current-schema repair and database-to-object content migration. */
import {
  assetBodyKey,
  createAssetStorageRuntime,
  digestContent,
} from "../../runtime/content/index.ts";
import type {
  AssetBodyHead,
  AssetOrigin,
  AssetStorageOptions,
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

export type ContentV2MigrationMode = "dry-run" | "apply";

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
  assets?: AssetStorageOptions;
  batchSize?: number;
  semanticBatchSize?: number;
  uploadConcurrency?: number;
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

function databaseBytes(row: AssetRow): Uint8Array {
  const data = record(row.data);
  const location = record(data.location);
  if (location.kind !== "database" || typeof data.body !== "string") {
    throw new Error(`Asset '${row.id}' is not a readable database body.`);
  }
  return location.encoding === "base64"
    ? decodeBase64(data.body)
    : new TextEncoder().encode(data.body);
}

function storedOrigin(value: unknown): AssetOrigin | undefined {
  const fields = record(value);
  const scope = record(fields.scope);
  const producer = record(fields.producer);
  if (typeof producer.type !== "string" || typeof producer.id !== "string") {
    return undefined;
  }
  if (scope.type === "thread" && typeof scope.id === "string") {
    return {
      scope: { type: "thread", id: scope.id },
      producer: { type: producer.type, id: producer.id },
      ...(typeof fields.path === "string" ? { path: fields.path } : {}),
      ...(fields.inferred === true ? { inferred: true } : {}),
    };
  }
  if (
    scope.type === "collection" && typeof scope.collection === "string" &&
    typeof scope.id === "string"
  ) {
    return {
      scope: { type: "collection", collection: scope.collection, id: scope.id },
      producer: { type: producer.type, id: producer.id },
      ...(typeof fields.path === "string" ? { path: fields.path } : {}),
      ...(fields.inferred === true ? { inferred: true } : {}),
    };
  }
  if (scope.type === "namespace" && typeof scope.id === "string") {
    return {
      scope: { type: "namespace", id: scope.id },
      producer: { type: producer.type, id: producer.id },
      ...(typeof fields.path === "string" ? { path: fields.path } : {}),
      ...(fields.inferred === true ? { inferred: true } : {}),
    };
  }
  return undefined;
}

async function inferOrigins(
  session: SqlExecutor,
  schema: string,
  rows: readonly AssetRow[],
): Promise<ReadonlyMap<string, AssetOrigin>> {
  const origins = new Map<string, AssetOrigin>();
  const unresolved: AssetRow[] = [];
  for (const row of rows) {
    const existing = storedOrigin(record(row.data).origin);
    if (existing) origins.set(row.id, existing);
    else unresolved.push(row);
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
        scope: { type: "namespace", id: row.namespace },
        producer: { type: "asset", id: row.id },
        inferred: true,
      });
      continue;
    }
    const data = record(found.data);
    const threadId = typeof data.threadId === "string"
      ? data.threadId
      : undefined;
    origins.set(row.id, {
      scope: threadId
        ? { type: "thread", id: threadId }
        : { type: "collection", collection: found.type, id: found.id },
      producer: { type: found.type, id: found.id },
      inferred: true,
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
  const uploadConcurrency = options.uploadConcurrency ?? 8;
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
    !Number.isSafeInteger(uploadConcurrency) || uploadConcurrency <= 0 ||
    uploadConcurrency > 32
  ) {
    throw new TypeError(
      "content-v2 uploadConcurrency must be between 1 and 32.",
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
  const storage = createAssetStorageRuntime(options.assets);
  const objectWriter = storage.writer;
  if (!objectWriter || objectWriter.kind !== "object") {
    throw new Error(
      `Schema '${schema}' apply mode requires an object body store.`,
    );
  }
  // Refuse ambiguous history before committing any resumable batch.
  const preflight = await planLegacyToolMessageRepair(session, schema, {
    batchSize: semanticBatchSize,
  });
  const semantic = emptySemanticReport();
  while (semantic.candidateMessages < preflight.report.candidateMessages) {
    const batch = await session.transaction((transaction) =>
      repairLegacyToolMessages(transaction, schema, {
        batchSize: semanticBatchSize,
        finalize: false,
      })
    );
    if (batch.candidateMessages === 0) break;
    addSemanticReport(semantic, batch);
    await options.onProgress?.({
      schema,
      mode,
      stage: "semantic",
      processed: semantic.candidateMessages,
      total: preflight.report.candidateMessages,
    });
  }
  const finalized = await session.transaction((transaction) =>
    finalizeLegacyToolMessageRepair(transaction, schema)
  );
  addSemanticReport(semantic, finalized);
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
  let cursorCreatedAt: string | null = null;
  let cursorId = "";
  let uploadedObjects = 0;
  let bytesMoved = 0;
  const failures: { id: string; message: string }[] = [];
  while (true) {
    const page: { rows: AssetRow[] } = await session.query<AssetRow>(
      `SELECT id, namespace, data, created_at,
         created_at::text AS cursor_created_at
       FROM ${q(schema, "nodes")}
       WHERE type = 'asset' AND data ->> 'state' = 'ready'
         AND data -> 'location' ->> 'kind' = 'database'
         AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2))
       ORDER BY created_at, id LIMIT $3`,
      [cursorCreatedAt, cursorId, batchSize],
    );
    if (page.rows.length === 0) break;
    const origins = await inferOrigins(session, schema, page.rows);
    type Uploaded = Readonly<{
      row: AssetRow;
      origin: AssetOrigin;
      head: AssetBodyHead;
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
    const results = await mapBounded(
      page.rows,
      uploadConcurrency,
      async (row): Promise<UploadResult> => {
        try {
          const data = record(row.data);
          const mediaType = String(data.mediaType ?? "");
          const digest = String(data.digest ?? "") as `sha256:${string}`;
          const byteLength = Number(data.byteLength);
          const bytes = databaseBytes(row);
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
            prefix: storage.prefix,
            databaseSchema: schema,
            namespace: row.namespace,
            assetId: row.id,
            origin,
          });
          const head = await objectWriter.put({
            key,
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
    const conflict = results.find((result) =>
      result.status === "failed" && result.conflict
    );
    if (conflict?.status === "failed") {
      throw new Error(
        `Asset '${conflict.id}' conflicts with its existing object: ${conflict.message}`,
      );
    }
    for (const result of results) {
      if (result.status === "failed") {
        failures.push({ id: result.id, message: result.message });
      }
    }
    const uploaded = results.flatMap((result) =>
      result.status === "uploaded" ? [result.value] : []
    );
    if (uploaded.length > 0) {
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
      for (const item of uploaded) {
        if (!changedIds.has(item.row.id)) continue;
        uploadedObjects++;
        bytesMoved += Number(record(item.row.data).byteLength);
      }
    }
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
