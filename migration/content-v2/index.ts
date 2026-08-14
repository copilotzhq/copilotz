/** Explicit current-schema repair and database-to-object content migration. */
import {
  assetBodyKey,
  createAssetStorageRuntime,
  digestContent,
} from "../../runtime/content/index.ts";
import type {
  AssetOrigin,
  AssetStorageOptions,
} from "../../runtime/content/index.ts";
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../../runtime/events/schema.ts";
import type { SqlExecutor, SqlSession } from "../../runtime/events/index.ts";
import {
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

export type MigrateContentV2SchemaOptions = Readonly<{
  mode?: ContentV2MigrationMode;
  assets?: AssetStorageOptions;
  batchSize?: number;
}>;

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

async function inferOrigin(
  session: SqlExecutor,
  schema: string,
  row: AssetRow,
): Promise<AssetOrigin> {
  const existing = storedOrigin(record(row.data).origin);
  if (existing) return existing;
  const owner = await session.query<
    { id: string; type: string; data: unknown }
  >(
    `SELECT owner.id, owner.type, owner.data
     FROM ${q(schema, "edges")} edge
     JOIN ${q(schema, "nodes")} owner
       ON owner.namespace = edge.namespace AND owner.id = edge.source_node_id
     WHERE edge.namespace = $1 AND edge.target_node_id = $2
       AND edge.type = 'has_asset'
     ORDER BY edge.created_at, edge.id LIMIT 1`,
    [row.namespace, row.id],
  );
  const found = owner.rows[0];
  if (!found) {
    return {
      scope: { type: "namespace", id: row.namespace },
      producer: { type: "asset", id: row.id },
      inferred: true,
    };
  }
  const data = record(found.data);
  const threadId = typeof data.threadId === "string"
    ? data.threadId
    : undefined;
  return {
    scope: threadId
      ? { type: "thread", id: threadId }
      : { type: "collection", collection: found.type, id: found.id },
    producer: { type: found.type, id: found.id },
    inferred: true,
  };
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
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1_000) {
    throw new TypeError("content-v2 batchSize must be between 1 and 1000.");
  }
  const counts = await dryRunCounts(session, schema);
  if (mode === "dry-run") {
    const marker = Symbol("content-v2-dry-run");
    type DryRunRollback = Error & {
      marker: symbol;
      semantic: ToolMessageRepairReport;
      databaseAssets: number;
    };
    try {
      await session.transaction(async (transaction) => {
        const semantic = await repairLegacyToolMessages(transaction, schema);
        const simulated = await dryRunCounts(transaction, schema);
        const rollback = new Error(
          "Rollback successful content-v2 dry-run simulation.",
        ) as DryRunRollback;
        rollback.marker = marker;
        rollback.semantic = semantic;
        rollback.databaseAssets = simulated.assets;
        throw rollback;
      });
    } catch (error) {
      const rollback = error as Partial<DryRunRollback>;
      if (rollback.marker !== marker || !rollback.semantic) throw error;
      return Object.freeze({
        schema,
        mode,
        ...rollback.semantic,
        databaseAssets: rollback.databaseAssets ?? counts.assets,
        uploadedObjects: 0,
        bytesMoved: 0,
        failures: Object.freeze([]),
      });
    }
    throw new Error("content-v2 dry-run did not roll back as expected.");
  }
  const storage = createAssetStorageRuntime(options.assets);
  const objectWriter = storage.writer;
  if (!objectWriter || objectWriter.kind !== "object") {
    throw new Error(
      `Schema '${schema}' apply mode requires an object body store.`,
    );
  }
  const semantic = await session.transaction((transaction) =>
    repairLegacyToolMessages(transaction, schema)
  );
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
    for (const row of page.rows) {
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
        const origin = await inferOrigin(session, schema, row);
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
        const changed = await session.transaction((transaction) =>
          transaction.query<{ id: string }>(
            `UPDATE ${q(schema, "nodes")}
           SET data = (data - 'body') || jsonb_build_object(
             'location', $3::jsonb,
             'origin', $4::jsonb
           ), updated_at = NOW()
           WHERE namespace = $1 AND id = $2 AND type = 'asset'
             AND data ->> 'state' = 'ready'
             AND data -> 'location' ->> 'kind' = 'database'
             AND data ->> 'digest' = $5
           RETURNING id`,
            [
              row.namespace,
              row.id,
              JSON.stringify({
                kind: "object",
                backendId: objectWriter.backendId,
                key,
                ...(head.etag ? { etag: head.etag } : {}),
              }),
              JSON.stringify(origin),
              digest,
            ],
          )
        );
        if (changed.rows.length === 1) {
          uploadedObjects++;
          bytesMoved += bytes.byteLength;
        }
      } catch (error) {
        if ((error as { code?: string }).code === "asset_conflict") {
          throw error;
        }
        failures.push({
          id: row.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const last: AssetRow = page.rows.at(-1)!;
    cursorCreatedAt = last.cursor_created_at;
    cursorId = last.id;
  }
  return Object.freeze({
    schema,
    mode,
    ...semantic,
    databaseAssets: postRepairCounts.assets,
    uploadedObjects,
    bytesMoved,
    failures: Object.freeze(failures),
  });
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
