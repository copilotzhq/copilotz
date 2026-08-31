import type { BodyHead } from "../content/body-store.ts";
import {
  quoteEventIdentifier,
  type SqlExecutor,
  type SqlSession,
  validateEventSchemaName,
} from "../events/index.ts";
import type { StreamOutputDescriptor } from "./types.ts";
import { snapshotStreamMetadata } from "./json.ts";

export const OPERATION_CATALOG_VERSION = 1;
export const OPERATION_CHANGE_CHANNEL = "copilotz_operations";
export const DEFAULT_OPERATION_STREAM_RETENTION_MS = 15 * 60_000;
export const DEFAULT_OPERATION_REPLAY_RETENTION_MS = 24 * 60 * 60_000;

export type OperationChangeSubscription = Readonly<{
  /** True means a notification arrived; false is the bounded safety timeout. */
  wait(
    options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
  ): Promise<boolean>;
  close(): void;
}>;

export type OperationState =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type OperationRecord = Readonly<{
  operationId: string;
  namespace: string;
  rootEventId: string;
  correlationId: string;
  metadata: Readonly<Record<string, unknown>>;
  state: OperationState;
  acceptedAt: string;
  updatedAt: string;
  completedAt?: string;
}>;

export type OperationStreamAssetRetention = "canonical" | "observation";

export type OperationStreamRecord = Readonly<{
  operationId: string;
  namespace: string;
  streamId: string;
  /** Stable logical lane shared by retry execution incarnations. */
  semanticStreamId: string;
  replayKey: string;
  streamOrdinal: string;
  bodyId: string;
  descriptor: StreamOutputDescriptor;
  state: "open" | "sealed" | "aborted";
  committedOffset: number;
  digest?: `sha256:${string}`;
  assetId?: string;
  assetRetention?: OperationStreamAssetRetention;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type OperationStreamReconciliationRecord =
  & OperationStreamRecord
  & Readonly<{ operationState: OperationState }>;

export type OperationCatalogTables = Readonly<{
  metadata: string;
  operations: string;
  operationEvents: string;
  operationStreams: string;
  events: string;
}>;

export type OperationEventIndexInput = Readonly<{
  namespace: string;
  operationId: string;
  eventId: string;
  position: string;
  correlationId: string;
  createdAt: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type OperationCatalog = Readonly<{
  databaseSchema: string;
  tables: OperationCatalogTables;
  watch(operationId: string): Promise<OperationChangeSubscription>;
  indexEvent(
    transaction: SqlExecutor,
    input: OperationEventIndexInput,
  ): Promise<void>;
  get(namespace: string, operationId: string): Promise<OperationRecord | null>;
  list(
    input: Readonly<{
      namespace: string;
      operationIds?: readonly string[];
      states?: readonly OperationState[];
      metadata?: Readonly<Record<string, unknown>>;
      limit?: number;
    }>,
  ): Promise<readonly OperationRecord[]>;
  belongsToThread(
    namespace: string,
    operationId: string,
    threadId: string,
  ): Promise<boolean>;
  listForThread(
    input: Readonly<{
      namespace: string;
      threadId: string;
      states?: readonly OperationState[];
      limit?: number;
    }>,
  ): Promise<readonly OperationRecord[]>;
  threadEventWatermark(
    namespace: string,
    threadId: string,
  ): Promise<string | undefined>;
  mark(
    namespace: string,
    operationId: string,
    state: Exclude<OperationState, "accepted">,
  ): Promise<boolean>;
  listEventIds(
    input: Readonly<{
      namespace: string;
      operationId: string;
      afterPosition?: string;
      limit?: number;
    }>,
  ): Promise<readonly Readonly<{ eventId: string; position: string }>[]>;
  openStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      semanticStreamId?: string;
      bodyId: string;
      descriptor: StreamOutputDescriptor;
    }>,
  ): Promise<
    Readonly<{ replayKey: string; streamOrdinal: string }> | undefined
  >;
  commitStreamOffset(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      committedOffset: number;
    }>,
  ): Promise<void>;
  sealStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      body: BodyHead;
      expiresAt: string;
    }>,
  ): Promise<boolean>;
  abortStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
    }>,
  ): Promise<boolean>;
  retainStream(
    input:
      & Readonly<{
        namespace: string;
        operationId: string;
        streamId: string;
      }>
      & (
        | Readonly<{ retention: "canonical"; assetId: string }>
        | Readonly<{ retention: "observation"; expiresAt: string }>
      ),
  ): Promise<void>;
  listStreams(
    input: Readonly<{
      namespace: string;
      operationId: string;
      afterStreamOrdinal?: string;
      limit?: number;
    }>,
  ): Promise<readonly OperationStreamRecord[]>;
  getStream(
    namespace: string,
    operationId: string,
    streamId: string,
  ): Promise<OperationStreamRecord | null>;
  hasOpenStreams(namespace: string, operationId: string): Promise<boolean>;
  /** True while this catalog owns replay/retention responsibility for a Body. */
  hasStreamBody(bodyId: string): Promise<boolean>;
  listOpenStreams(
    input?: Readonly<{ afterReplayKey?: string; limit?: number }>,
  ): Promise<readonly OperationStreamReconciliationRecord[]>;
  listExpiredObservationStreams(
    input?: Readonly<{
      now?: Date;
      operationRetentionMs?: number;
      limit?: number;
    }>,
  ): Promise<readonly OperationStreamRecord[]>;
  reconcile(input?: Readonly<{ limit?: number }>): Promise<number>;
  pruneTerminalMetadata(
    input: Readonly<{ now?: Date; retentionMs: number; limit?: number }>,
  ): Promise<
    Readonly<{ streams: number; events: number; operations: number }>
  >;
  pruneStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
    }>,
  ): Promise<boolean>;
}>;

type OperationNotificationHub = Readonly<{
  listeners: Set<(operationId: string) => void>;
}>;

const notificationHubs = new WeakMap<
  SqlSession,
  Promise<OperationNotificationHub>
>();

function operationNotificationHub(
  session: SqlSession,
): Promise<OperationNotificationHub> {
  const existing = notificationHubs.get(session);
  if (existing) return existing;
  const listeners = new Set<(operationId: string) => void>();
  const hub = Object.freeze({ listeners });
  const pending = (async () => {
    if (session.listen) {
      await session.listen(OPERATION_CHANGE_CHANNEL, (notification) => {
        if (!notification.payload) return;
        for (const listener of listeners) listener(notification.payload);
      }).catch(() => undefined);
    }
    return hub;
  })();
  notificationHubs.set(session, pending);
  return pending;
}

async function notifyOperationChange(
  session: SqlSession,
  executor: SqlExecutor,
  operationId: string,
  strict = false,
): Promise<void> {
  const payload = requiredText(operationId, "Operation id");
  if (!strict) {
    const hub = await operationNotificationHub(session);
    for (const listener of hub.listeners) listener(payload);
  }
  if (!session.listen) return;
  if (new TextEncoder().encode(payload).byteLength > 7_500) return;
  try {
    await executor.query("SELECT pg_notify($1, $2)", [
      OPERATION_CHANGE_CHANNEL,
      payload,
    ]);
  } catch (error) {
    // Event indexing requests strict transactional notification. Standalone
    // catalog mutations are already committed, so their notification is only
    // an acceleration hint and the bounded safety wake preserves correctness.
    if (strict) throw error;
  }
}

function timeoutMs(value: number | undefined): number {
  const resolved = value ?? 5_000;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 60_000) {
    throw new TypeError(
      "Operation watch timeoutMs must be between 100 and 60000.",
    );
  }
  return resolved;
}

function operationCatalogError(
  schema: string,
  message: string,
  code: string,
): Error {
  return Object.assign(
    new Error(`Copilotz operation catalog in schema '${schema}' ${message}.`),
    { name: "CopilotzOperationCatalogError", code, schema },
  );
}

type OperationRow = Record<string, unknown> & {
  operation_id: string;
  namespace: string;
  root_event_id: string;
  correlation_id: string;
  metadata: unknown;
  state: OperationState;
  accepted_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

type StreamRow = Record<string, unknown> & {
  operation_id: string;
  namespace: string;
  stream_id: string;
  semantic_stream_id: string;
  replay_key: string | number | bigint;
  stream_ordinal: string | number | bigint;
  body_id: string;
  descriptor: unknown;
  state: "open" | "sealed" | "aborted";
  committed_offset: string | number | bigint;
  digest: string | null;
  asset_id: string | null;
  asset_retention: OperationStreamAssetRetention | null;
  expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function iso(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new Date(value).toISOString();
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function boundedLimit(value: number | undefined, fallback = 1_000): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError("Operation catalog limit must be between 1 and 10000.");
  }
  return value;
}

function offset(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "Operation stream offset must be a non-negative safe integer.",
    );
  }
  return value;
}

function tableNames(schemaName: string): OperationCatalogTables {
  const schema = quoteEventIdentifier(validateEventSchemaName(schemaName));
  const table = (name: string) => `${schema}.${quoteEventIdentifier(name)}`;
  return Object.freeze({
    metadata: table("copilotz_operation_catalog_metadata"),
    operations: table("copilotz_operations"),
    operationEvents: table("copilotz_operation_events"),
    operationStreams: table("copilotz_operation_streams"),
    events: table("events"),
  });
}

function mapOperation(row: OperationRow): OperationRecord {
  const completedAt = iso(row.completed_at);
  return Object.freeze({
    operationId: String(row.operation_id),
    namespace: String(row.namespace),
    rootEventId: String(row.root_event_id),
    correlationId: String(row.correlation_id),
    metadata: Object.freeze(snapshotStreamMetadata(row.metadata)),
    state: row.state,
    acceptedAt: iso(row.accepted_at)!,
    updatedAt: iso(row.updated_at)!,
    ...(completedAt ? { completedAt } : {}),
  });
}

function mapStream(row: StreamRow): OperationStreamRecord {
  const descriptor = snapshotStreamMetadata(
    row.descriptor,
  ) as StreamOutputDescriptor;
  const byteOffset = Number(row.committed_offset);
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error("Operation stream catalog contains an invalid offset.");
  }
  const expiresAt = iso(row.expires_at);
  return Object.freeze({
    operationId: String(row.operation_id),
    namespace: String(row.namespace),
    streamId: String(row.stream_id),
    semanticStreamId: String(row.semantic_stream_id),
    replayKey: String(row.replay_key),
    streamOrdinal: String(row.stream_ordinal),
    bodyId: String(row.body_id),
    descriptor: Object.freeze(descriptor),
    state: row.state,
    committedOffset: byteOffset,
    ...(row.digest ? { digest: String(row.digest) as `sha256:${string}` } : {}),
    ...(row.asset_id ? { assetId: String(row.asset_id) } : {}),
    ...(row.asset_retention ? { assetRetention: row.asset_retention } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  });
}

/** Additive operational tables; the immutable Core Event schema stays v4. */
export async function provisionOperationCatalog(
  session: SqlSession,
  databaseSchema = "public",
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = tableNames(schema);
  await session.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [schema, "copilotz-operation-catalog"],
    );
    await transaction.query(`CREATE TABLE IF NOT EXISTS ${tables.metadata} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      version INTEGER NOT NULL
    )`);
    await transaction.query(`CREATE TABLE IF NOT EXISTS ${tables.operations} (
      operation_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      root_event_id TEXT NOT NULL UNIQUE,
      correlation_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      state TEXT NOT NULL CHECK (state IN ('accepted','running','completed','failed','cancelled')),
      accepted_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )`);
    await transaction.query(
      `ALTER TABLE ${tables.operations}
         ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.operations}
         ADD COLUMN IF NOT EXISTS next_stream_ordinal BIGINT NOT NULL DEFAULT 1`,
    );
    await transaction.query(
      `CREATE INDEX IF NOT EXISTS "copilotz_operations_namespace_updated_idx"
      ON ${tables.operations} (namespace, updated_at, operation_id)`,
    );
    await transaction.query(
      `CREATE TABLE IF NOT EXISTS ${tables.operationEvents} (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_position BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (namespace, operation_id, event_id)
    )`,
    );
    await transaction.query(
      `CREATE INDEX IF NOT EXISTS "copilotz_operation_events_position_idx"
      ON ${tables.operationEvents} (namespace, operation_id, event_position)`,
    );
    await transaction.query(
      `CREATE TABLE IF NOT EXISTS ${tables.operationStreams} (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      replay_key BIGSERIAL NOT NULL UNIQUE,
      stream_ordinal BIGINT,
      stream_id TEXT NOT NULL,
      semantic_stream_id TEXT NOT NULL,
      body_id TEXT NOT NULL,
      descriptor JSONB NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open','sealed','aborted')),
      committed_offset BIGINT NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
      digest TEXT,
      asset_id TEXT,
      asset_retention TEXT CHECK (asset_retention IN ('canonical','observation')),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, operation_id, stream_id),
      UNIQUE (namespace, stream_id)
    )`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.operationStreams}
         ADD COLUMN IF NOT EXISTS replay_key BIGSERIAL`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.operationStreams}
         ADD COLUMN IF NOT EXISTS stream_ordinal BIGINT`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.operationStreams}
         ADD COLUMN IF NOT EXISTS semantic_stream_id TEXT`,
    );
    await transaction.query(
      `UPDATE ${tables.operationStreams}
          SET semantic_stream_id = stream_id
        WHERE semantic_stream_id IS NULL`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.operationStreams}
         ALTER COLUMN semantic_stream_id SET NOT NULL`,
    );
    // Preserve immutable schema-global replay keys while adding the compact
    // operation-local ordering used by high-watermark cursors.
    await transaction.query(
      `WITH ranked AS (
         SELECT namespace, operation_id, stream_id,
                ROW_NUMBER() OVER (
                  PARTITION BY namespace, operation_id
                  ORDER BY replay_key, stream_id
                ) AS ordinal
           FROM ${tables.operationStreams}
       )
       UPDATE ${tables.operationStreams} AS stream
          SET stream_ordinal = ranked.ordinal
         FROM ranked
        WHERE stream.namespace = ranked.namespace
          AND stream.operation_id = ranked.operation_id
          AND stream.stream_id = ranked.stream_id
          AND stream.stream_ordinal IS NULL`,
    );
    await transaction.query(
      `ALTER TABLE ${tables.operationStreams}
         ALTER COLUMN stream_ordinal SET NOT NULL`,
    );
    await transaction.query(
      `UPDATE ${tables.operations} AS operation
          SET next_stream_ordinal = GREATEST(
            operation.next_stream_ordinal,
            COALESCE((
              SELECT MAX(stream.stream_ordinal) + 1
                FROM ${tables.operationStreams} AS stream
               WHERE stream.namespace = operation.namespace
                 AND stream.operation_id = operation.operation_id
            ), 1)
          )`,
    );
    await transaction.query(
      `DROP INDEX IF EXISTS ${
        quoteEventIdentifier(schema)
      }."copilotz_operation_streams_replay_key_idx"`,
    );
    await transaction.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_streams_replay_key_idx"
       ON ${tables.operationStreams} (replay_key)`,
    );
    await transaction.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_streams_ordinal_idx"
       ON ${tables.operationStreams} (namespace, operation_id, stream_ordinal)`,
    );
    await transaction.query(
      `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_semantic_idx"
       ON ${tables.operationStreams} (namespace, operation_id, semantic_stream_id)`,
    );
    await transaction.query(
      `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_body_idx"
       ON ${tables.operationStreams} (body_id)`,
    );
    await transaction.query(
      `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_expiry_idx"
      ON ${tables.operationStreams} (expires_at, namespace, operation_id, stream_id)
      WHERE asset_retention = 'observation' AND expires_at IS NOT NULL`,
    );
    const marker = await transaction.query<{ version: string | number }>(
      `SELECT version FROM ${tables.metadata} WHERE singleton = TRUE LIMIT 1`,
    );
    const version = marker.rows[0] ? Number(marker.rows[0].version) : undefined;
    if (version !== undefined && version !== OPERATION_CATALOG_VERSION) {
      throw new Error(
        `Operation catalog in schema '${schema}' has unsupported version ${version}.`,
      );
    }
    await transaction.query(
      `INSERT INTO ${tables.metadata} (singleton, version) VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO NOTHING`,
      [OPERATION_CATALOG_VERSION],
    );
  });
  return tables;
}

/** Read-only validation used while selecting an already provisioned scope. */
export async function validateOperationCatalog(
  session: SqlSession,
  databaseSchema = "public",
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = tableNames(schema);
  const required = [
    ["metadata", tables.metadata],
    ["operations", tables.operations],
    ["operation events", tables.operationEvents],
    ["operation streams", tables.operationStreams],
  ] as const;
  for (const [label, table] of required) {
    const result = await session.query<{ table_name: string | null }>(
      "SELECT to_regclass($1) AS table_name",
      [`${schema}.${table.split(".").at(-1)!.replaceAll('"', "")}`],
    );
    if (!result.rows[0]?.table_name) {
      throw operationCatalogError(
        schema,
        `is not provisioned; missing ${label} table`,
        "copilotz_operation_catalog_not_provisioned",
      );
    }
  }
  const columns = await session.query<
    { table_name: string; column_name: string }
  >(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = $1
        AND (
          (table_name = 'copilotz_operations' AND column_name = 'next_stream_ordinal')
          OR
          (table_name = 'copilotz_operation_streams'
            AND column_name IN ('replay_key','stream_ordinal','semantic_stream_id'))
        )`,
    [schema],
  );
  const present = new Set(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  if (
    !present.has("copilotz_operations.next_stream_ordinal") ||
    !present.has("copilotz_operation_streams.replay_key") ||
    !present.has("copilotz_operation_streams.stream_ordinal") ||
    !present.has("copilotz_operation_streams.semantic_stream_id")
  ) {
    throw operationCatalogError(
      schema,
      "requires the additive replay ordinal migration",
      "copilotz_operation_catalog_not_provisioned",
    );
  }
  const marker = await session.query<{ version: string | number }>(
    `SELECT version FROM ${tables.metadata} WHERE singleton = TRUE LIMIT 1`,
  );
  const version = marker.rows[0] ? Number(marker.rows[0].version) : undefined;
  if (version !== OPERATION_CATALOG_VERSION) {
    throw operationCatalogError(
      schema,
      `has unsupported version ${version ?? "none"}`,
      "copilotz_operation_catalog_version_unsupported",
    );
  }
  return tables;
}

export function createOperationCatalog(
  session: SqlSession,
  databaseSchema = "public",
  options: Readonly<{
    /** Drains request-local/remote relay frames before a zero-settlement terminal inference. */
    beforeTerminal?: (
      operation: Readonly<{ namespace: string; operationId: string }>,
    ) => Promise<void>;
  }> = {},
): OperationCatalog {
  const tables = tableNames(databaseSchema);
  const catalog: OperationCatalog = {
    databaseSchema: validateEventSchemaName(databaseSchema),
    tables,
    async watch(operationIdInput) {
      const operationId = requiredText(operationIdInput, "Operation id");
      const hub = await operationNotificationHub(session);
      let pending = 0;
      let closed = false;
      let resolveWaiting: ((notified: boolean) => void) | undefined;
      const listener = (changedOperationId: string) => {
        if (closed || changedOperationId !== operationId) return;
        pending = 1;
        resolveWaiting?.(true);
      };
      hub.listeners.add(listener);
      return Object.freeze({
        wait(options = {}) {
          if (closed) return Promise.resolve(false);
          if (pending > 0) {
            pending -= 1;
            return Promise.resolve(true);
          }
          const delay = timeoutMs(options.timeoutMs);
          return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (notified: boolean) => {
              if (settled) return;
              settled = true;
              if (notified && pending > 0) pending -= 1;
              clearTimeout(timer);
              options.signal?.removeEventListener("abort", aborted);
              if (resolveWaiting === finish) resolveWaiting = undefined;
              resolve(notified);
            };
            const aborted = () => finish(false);
            const timer = setTimeout(() => finish(false), delay);
            resolveWaiting = finish;
            if (options.signal?.aborted) aborted();
            else {
              options.signal?.addEventListener("abort", aborted, {
                once: true,
              });
            }
          });
        },
        close() {
          if (closed) return;
          closed = true;
          hub.listeners.delete(listener);
          resolveWaiting?.(false);
          resolveWaiting = undefined;
        },
      });
    },
    async indexEvent(transaction, input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const operationId = requiredText(input.operationId, "Operation id");
      const eventId = requiredText(input.eventId, "Operation event id");
      if (!/^(0|[1-9][0-9]*)$/.test(input.position)) {
        throw new TypeError("Operation event position is invalid.");
      }
      if (operationId === eventId) {
        await transaction.query(
          `INSERT INTO ${tables.operations} (
             operation_id, namespace, root_event_id, correlation_id, metadata,
             state, accepted_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5::jsonb,'accepted',$6::timestamptz,$6::timestamptz)
           ON CONFLICT (operation_id) DO NOTHING`,
          [
            operationId,
            namespace,
            eventId,
            input.correlationId,
            JSON.stringify(snapshotStreamMetadata(input.metadata ?? {})),
            input.createdAt,
          ],
        );
      }
      const indexed = await transaction.query<{ event_id: string }>(
        `INSERT INTO ${tables.operationEvents} (
           namespace, operation_id, event_id, event_position, created_at
         ) SELECT $1,$2,$3,$4::bigint,$5::timestamptz
             FROM ${tables.operations}
            WHERE namespace = $1 AND operation_id = $2
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [namespace, operationId, eventId, input.position, input.createdAt],
      );
      // Detached delivery settlement scopes deliberately have no operation
      // root. They remain Core delivery mechanics and must not leak orphaned
      // reconnect catalog rows.
      if (indexed.rows.length === 0) return;
      if (operationId !== eventId) {
        await transaction.query(
          `UPDATE ${tables.operations}
             SET state = CASE WHEN state = 'accepted' THEN 'running' ELSE state END,
                 updated_at = GREATEST(updated_at, $3::timestamptz)
           WHERE namespace = $1 AND operation_id = $2`,
          [namespace, operationId, input.createdAt],
        );
      }
      await notifyOperationChange(session, transaction, operationId, true);
    },
    async get(namespaceInput, operationIdInput) {
      const namespace = requiredText(namespaceInput, "Operation namespace");
      const operationId = requiredText(operationIdInput, "Operation id");
      const result = await session.query<OperationRow>(
        `SELECT * FROM ${tables.operations}
          WHERE namespace = $1 AND operation_id = $2 LIMIT 1`,
        [namespace, operationId],
      );
      return result.rows[0] ? mapOperation(result.rows[0]) : null;
    },
    async list(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const conditions = ["namespace = $1"];
      const params: unknown[] = [namespace];
      if (input.operationIds?.length) {
        params.push([
          ...new Set(
            input.operationIds.map((id) => requiredText(id, "Operation id")),
          ),
        ]);
        conditions.push(`operation_id = ANY($${params.length}::text[])`);
      }
      if (input.states?.length) {
        params.push([...new Set(input.states)]);
        conditions.push(`state = ANY($${params.length}::text[])`);
      }
      if (input.metadata && Object.keys(input.metadata).length) {
        params.push(JSON.stringify(snapshotStreamMetadata(input.metadata)));
        conditions.push(`metadata @> $${params.length}::jsonb`);
      }
      params.push(boundedLimit(input.limit));
      const result = await session.query<OperationRow>(
        `SELECT * FROM ${tables.operations}
          WHERE ${conditions.join(" AND ")}
          ORDER BY updated_at DESC, operation_id DESC LIMIT $${params.length}`,
        params,
      );
      return Object.freeze(result.rows.map(mapOperation));
    },
    async belongsToThread(namespaceInput, operationIdInput, threadIdInput) {
      const namespace = requiredText(namespaceInput, "Operation namespace");
      const operationId = requiredText(operationIdInput, "Operation id");
      const threadId = requiredText(threadIdInput, "Thread id");
      const result = await session.query<{ operation_id: string }>(
        `SELECT operation.operation_id
           FROM ${tables.operations} AS operation
          WHERE operation.namespace = $1 AND operation.operation_id = $2
            AND (
              operation.metadata -> 'operationMetadata' ->> 'threadId' = $3
              OR EXISTS (
                SELECT 1 FROM ${tables.operationEvents} AS indexed
                JOIN ${tables.events} AS event ON event.id = indexed.event_id
                WHERE indexed.namespace = operation.namespace
                  AND indexed.operation_id = operation.operation_id
                  AND event.thread_id = $3
              )
            )
          LIMIT 1`,
        [namespace, operationId, threadId],
      );
      return result.rows.length > 0;
    },
    async listForThread(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const threadId = requiredText(input.threadId, "Thread id");
      const params: unknown[] = [namespace, threadId];
      const stateFilter = input.states?.length
        ? ` AND operation.state = ANY($${
          params.push([...new Set(input.states)])
        }::text[])`
        : "";
      params.push(boundedLimit(input.limit));
      const result = await session.query<OperationRow>(
        `SELECT operation.* FROM ${tables.operations} AS operation
          WHERE operation.namespace = $1${stateFilter}
            AND (
              operation.metadata -> 'operationMetadata' ->> 'threadId' = $2
              OR EXISTS (
                SELECT 1 FROM ${tables.operationEvents} AS indexed
                JOIN ${tables.events} AS event ON event.id = indexed.event_id
                WHERE indexed.namespace = operation.namespace
                  AND indexed.operation_id = operation.operation_id
                  AND event.thread_id = $2
              )
            )
          ORDER BY operation.updated_at DESC, operation.operation_id DESC
          LIMIT $${params.length}`,
        params,
      );
      return Object.freeze(result.rows.map(mapOperation));
    },
    async threadEventWatermark(namespaceInput, threadIdInput) {
      const result = await session.query<{
        position: string | number | bigint | null;
      }>(
        `SELECT MAX(position) AS position FROM ${tables.events}
          WHERE namespace = $1 AND thread_id = $2`,
        [
          requiredText(namespaceInput, "Operation namespace"),
          requiredText(threadIdInput, "Thread id"),
        ],
      );
      const value = result.rows[0]?.position;
      return value === null || value === undefined ? undefined : String(value);
    },
    async mark(namespaceInput, operationIdInput, state) {
      const namespace = requiredText(namespaceInput, "Operation namespace");
      const operationId = requiredText(operationIdInput, "Operation id");
      const result = await session.transaction(async (transaction) => {
        if (state === "cancelled") {
          await transaction.query(
            `UPDATE ${tables.operationStreams}
                SET state = 'aborted', updated_at = NOW()
              WHERE namespace = $1 AND operation_id = $2 AND state = 'open'`,
            [namespace, operationId],
          );
        }
        return await transaction.query<{ operation_id: string }>(
          `UPDATE ${tables.operations}
           SET state = $3, updated_at = NOW(),
               completed_at = CASE WHEN $3 IN ('completed','failed','cancelled')
                 THEN COALESCE(completed_at, NOW()) ELSE completed_at END
         WHERE namespace = $1 AND operation_id = $2
           AND state NOT IN ('completed','failed','cancelled')
           AND state IS DISTINCT FROM $3
           AND (
             $3 = 'cancelled'
             OR $3 = 'running'
             OR NOT EXISTS (
               SELECT 1 FROM ${tables.operationStreams} AS stream
                WHERE stream.namespace = $1
                  AND stream.operation_id = $2 AND stream.state = 'open'
             )
           )
         RETURNING operation_id`,
          [namespace, operationId, state],
        );
      });
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, operationId);
      }
      return result.rows.length > 0;
    },
    async listEventIds(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const operationId = requiredText(input.operationId, "Operation id");
      const params: unknown[] = [namespace, operationId];
      const after = input.afterPosition?.trim();
      const condition = after
        ? ` AND event_position > $${params.push(after)}::bigint`
        : "";
      params.push(boundedLimit(input.limit));
      const result = await session.query<{
        event_id: string;
        event_position: string | number | bigint;
      }>(
        `SELECT event_id, event_position FROM ${tables.operationEvents}
          WHERE namespace = $1 AND operation_id = $2${condition}
          ORDER BY event_position LIMIT $${params.length}`,
        params,
      );
      return Object.freeze(result.rows.map((row) =>
        Object.freeze({
          eventId: String(row.event_id),
          position: String(row.event_position),
        })
      ));
    },
    async openStream(input) {
      const descriptor = snapshotStreamMetadata(input.descriptor);
      const namespace = requiredText(input.namespace, "Operation namespace");
      const operationId = requiredText(input.operationId, "Operation id");
      const streamId = requiredText(
        input.descriptor.streamId,
        "Operation stream id",
      );
      const semanticStreamId = requiredText(
        input.semanticStreamId ?? streamId,
        "Operation semantic stream id",
      );
      const bodyId = requiredText(input.bodyId, "Operation stream body id");
      const replayKey = await session.transaction(async (transaction) => {
        const operation = await transaction.query<{
          next_stream_ordinal: string | number | bigint;
        }>(
          `SELECT next_stream_ordinal FROM ${tables.operations}
            WHERE namespace = $1 AND operation_id = $2
            LIMIT 1 FOR UPDATE`,
          [namespace, operationId],
        );
        if (!operation.rows[0]) return undefined;
        // A durable delivery retry must never append a restarted provider's
        // bytes to the previous execution. Opening the new physical lane
        // atomically closes any still-open incarnation of the same semantic
        // lane. Its Body remains fenced by its writer generation and is later
        // retired by progressive/operation maintenance.
        await transaction.query(
          `UPDATE ${tables.operationStreams}
              SET state = 'aborted', updated_at = NOW()
            WHERE namespace = $1 AND operation_id = $2
              AND semantic_stream_id = $3 AND stream_id <> $4
              AND state = 'open'`,
          [namespace, operationId, semanticStreamId, streamId],
        );
        const existing = await transaction.query<{
          replay_key: string | number | bigint;
          stream_ordinal: string | number | bigint;
          body_id: string;
          semantic_stream_id: string;
        }>(
          `SELECT replay_key, stream_ordinal, body_id, semantic_stream_id
             FROM ${tables.operationStreams}
            WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            LIMIT 1`,
          [namespace, operationId, streamId],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].body_id !== bodyId) {
            throw new Error(
              `Operation stream '${streamId}' conflicts with another Body.`,
            );
          }
          if (existing.rows[0].semantic_stream_id !== semanticStreamId) {
            throw new Error(
              `Operation stream '${streamId}' conflicts with another semantic lane.`,
            );
          }
          await transaction.query(
            `UPDATE ${tables.operationStreams}
                SET descriptor = $4::jsonb, updated_at = NOW()
              WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3`,
            [namespace, operationId, streamId, JSON.stringify(descriptor)],
          );
          return Object.freeze({
            replayKey: String(existing.rows[0].replay_key),
            streamOrdinal: String(existing.rows[0].stream_ordinal),
          });
        }
        const ordinal = String(operation.rows[0].next_stream_ordinal);
        await transaction.query(
          `UPDATE ${tables.operations}
              SET next_stream_ordinal = next_stream_ordinal + 1,
                  updated_at = NOW()
            WHERE namespace = $1 AND operation_id = $2`,
          [namespace, operationId],
        );
        const inserted = await transaction.query<{
          replay_key: string | number | bigint;
        }>(
          `INSERT INTO ${tables.operationStreams} (
             namespace, operation_id, stream_ordinal, stream_id,
             semantic_stream_id, body_id, descriptor, state,
             committed_offset, created_at, updated_at
           ) VALUES ($1,$2,$3::bigint,$4,$5,$6,$7::jsonb,'open',0,NOW(),NOW())
           RETURNING replay_key`,
          [
            namespace,
            operationId,
            ordinal,
            streamId,
            semanticStreamId,
            bodyId,
            JSON.stringify(descriptor),
          ],
        );
        return Object.freeze({
          replayKey: String(inserted.rows[0].replay_key),
          streamOrdinal: ordinal,
        });
      });
      if (replayKey === undefined) return undefined;
      await notifyOperationChange(session, session, operationId);
      return replayKey;
    },
    async commitStreamOffset(input) {
      const committedOffset = offset(input.committedOffset);
      await session.query(
        `UPDATE ${tables.operationStreams}
           SET committed_offset = GREATEST(committed_offset, $4::bigint),
               updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state = 'open'`,
        [input.namespace, input.operationId, input.streamId, committedOffset],
      );
      await notifyOperationChange(session, session, input.operationId);
    },
    async sealStream(input) {
      const expiresAt = new Date(input.expiresAt).toISOString();
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET state = 'sealed', committed_offset = $4::bigint,
               digest = $5, asset_id = NULL,
               asset_retention = 'observation',
               expires_at = $7::timestamptz, updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND body_id = $6 AND state = 'open'
         RETURNING stream_id`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          offset(input.body.byteLength),
          input.body.digest,
          input.body.bodyId,
          expiresAt,
        ],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async abortStream(input) {
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET state = 'aborted', updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state = 'open'
         RETURNING stream_id`,
        [input.namespace, input.operationId, input.streamId],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async retainStream(input) {
      const expiresAt = input.retention === "observation"
        ? new Date(input.expiresAt).toISOString()
        : undefined;
      const assetId = input.retention === "canonical"
        ? requiredText(input.assetId, "Operation stream asset id")
        : undefined;
      await session.query(
        `UPDATE ${tables.operationStreams}
           SET asset_id = $4, asset_retention = $5,
               expires_at = $6::timestamptz, updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state = 'sealed'`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          assetId ?? null,
          input.retention,
          expiresAt ?? null,
        ],
      );
      await notifyOperationChange(session, session, input.operationId);
    },
    async listStreams(input) {
      const after = input.afterStreamOrdinal?.trim();
      if (after !== undefined && !/^(0|[1-9][0-9]*)$/.test(after)) {
        throw new TypeError(
          "Operation stream ordinal must be a non-negative integer.",
        );
      }
      const result = await session.query<StreamRow>(
        `SELECT * FROM ${tables.operationStreams}
          WHERE namespace = $1 AND operation_id = $2
            ${after === undefined ? "" : "AND stream_ordinal > $3::bigint"}
          ORDER BY stream_ordinal LIMIT $${after === undefined ? 3 : 4}`,
        after === undefined
          ? [input.namespace, input.operationId, boundedLimit(input.limit)]
          : [
            input.namespace,
            input.operationId,
            after,
            boundedLimit(input.limit),
          ],
      );
      return Object.freeze(result.rows.map(mapStream));
    },
    async getStream(namespace, operationId, streamId) {
      const result = await session.query<StreamRow>(
        `SELECT * FROM ${tables.operationStreams}
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
          LIMIT 1`,
        [
          requiredText(namespace, "Operation namespace"),
          requiredText(operationId, "Operation id"),
          requiredText(streamId, "Operation stream id"),
        ],
      );
      return result.rows[0] ? mapStream(result.rows[0]) : null;
    },
    async hasOpenStreams(namespaceInput, operationIdInput) {
      const result = await session.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${tables.operationStreams}
            WHERE namespace = $1 AND operation_id = $2 AND state = 'open'
         ) AS present`,
        [
          requiredText(namespaceInput, "Operation namespace"),
          requiredText(operationIdInput, "Operation id"),
        ],
      );
      return result.rows[0]?.present === true;
    },
    async hasStreamBody(bodyId) {
      const result = await session.query<{ retained: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${tables.operationStreams} WHERE body_id = $1
         ) AS retained`,
        [requiredText(bodyId, "Operation stream body id")],
      );
      return result.rows[0]?.retained === true;
    },
    async listOpenStreams(input = {}) {
      const after = input.afterReplayKey?.trim();
      if (after !== undefined && !/^(0|[1-9][0-9]*)$/.test(after)) {
        throw new TypeError(
          "Operation stream replay key must be a non-negative integer.",
        );
      }
      const result = await session.query<
        StreamRow & {
          operation_state: OperationState;
        }
      >(
        `SELECT stream.*, operation.state AS operation_state
           FROM ${tables.operationStreams} AS stream
           JOIN ${tables.operations} AS operation
             ON operation.namespace = stream.namespace
            AND operation.operation_id = stream.operation_id
          WHERE stream.state = 'open'
            ${after === undefined ? "" : "AND stream.replay_key > $1::bigint"}
          ORDER BY stream.replay_key
          LIMIT $${after === undefined ? 1 : 2}`,
        after === undefined
          ? [boundedLimit(input.limit)]
          : [after, boundedLimit(input.limit)],
      );
      return Object.freeze(result.rows.map((row) =>
        Object.freeze({
          ...mapStream(row),
          operationState: row.operation_state,
        })
      ));
    },
    async listExpiredObservationStreams(input = {}) {
      const operationRetentionMs = input.operationRetentionMs ??
        DEFAULT_OPERATION_REPLAY_RETENTION_MS;
      if (
        !Number.isFinite(operationRetentionMs) || operationRetentionMs < 0
      ) {
        throw new TypeError(
          "Operation replay retentionMs must be non-negative.",
        );
      }
      const now = input.now ?? new Date();
      const completedCutoff = new Date(
        now.getTime() - operationRetentionMs,
      ).toISOString();
      const result = await session.query<StreamRow>(
        `SELECT stream.* FROM ${tables.operationStreams} AS stream
          JOIN ${tables.operations} AS operation
            ON operation.namespace = stream.namespace
           AND operation.operation_id = stream.operation_id
          WHERE stream.asset_retention = 'observation'
            AND stream.expires_at IS NOT NULL
            AND stream.expires_at <= $1::timestamptz
            AND operation.state IN ('completed','failed','cancelled')
            AND operation.completed_at IS NOT NULL
            AND operation.completed_at <= $2::timestamptz
          ORDER BY stream.expires_at, stream.namespace,
                   stream.operation_id, stream.stream_id LIMIT $3`,
        [now.toISOString(), completedCutoff, boundedLimit(input.limit)],
      );
      return Object.freeze(result.rows.map(mapStream));
    },
    async reconcile(input = {}) {
      const terminalizable = await session.query<{
        operation_id: string;
        namespace: string;
      }>(
        `SELECT operation.operation_id, operation.namespace
           FROM ${tables.operations} AS operation
          WHERE operation.state IN ('accepted','running')
            AND NOT EXISTS (
              SELECT 1 FROM ${tables.operationStreams} AS open_stream
               WHERE open_stream.namespace = operation.namespace
                 AND open_stream.operation_id = operation.operation_id
                 AND open_stream.state = 'open'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM ${tables.operationEvents} AS active_index
                JOIN ${
          quoteEventIdentifier(databaseSchema)
        }."event_deliveries" AS active_delivery
                  ON active_delivery.event_id = active_index.event_id
                 AND active_delivery.settlement_scope_id = operation.operation_id
                 AND active_delivery.status IN ('pending','leased','retry_wait')
               WHERE active_index.namespace = operation.namespace
                 AND active_index.operation_id = operation.operation_id
            )
          ORDER BY operation.updated_at, operation.operation_id
          LIMIT $1`,
        [boundedLimit(input.limit)],
      );
      for (const operation of terminalizable.rows) {
        await options.beforeTerminal?.({
          namespace: operation.namespace,
          operationId: operation.operation_id,
        });
      }
      if (terminalizable.rows.length === 0) return 0;
      const drainedOperationIds = terminalizable.rows.map((operation) =>
        operation.operation_id
      );
      const result = await session.query<{ operation_id: string }>(
        `WITH candidates AS (
           SELECT operation.operation_id, operation.namespace
           FROM ${tables.operations} AS operation
           WHERE operation.state IN ('accepted','running')
             AND operation.operation_id = ANY($1::text[])
             AND NOT EXISTS (
               SELECT 1 FROM ${tables.operationStreams} AS open_stream
                WHERE open_stream.namespace = operation.namespace
                  AND open_stream.operation_id = operation.operation_id
                  AND open_stream.state = 'open'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM ${tables.operationEvents} AS active_index
               JOIN ${
          quoteEventIdentifier(databaseSchema)
        }."event_deliveries" AS active_delivery
                 ON active_delivery.event_id = active_index.event_id
                AND active_delivery.settlement_scope_id = operation.operation_id
                AND active_delivery.status IN ('pending','leased','retry_wait')
               WHERE active_index.namespace = operation.namespace
                 AND active_index.operation_id = operation.operation_id
             )
         ), totals AS (
           SELECT candidate.operation_id, candidate.namespace,
             COUNT(delivery.id) FILTER (
               WHERE delivery.status IN ('pending','leased','retry_wait')
                 AND delivery.settlement_scope_id = candidate.operation_id
             ) AS unsettled,
             COUNT(delivery.id) FILTER (
               WHERE delivery.status = 'dead_letter'
                 AND delivery.settlement_scope_id = candidate.operation_id
             ) AS failed,
             COUNT(delivery.id) FILTER (
               WHERE delivery.status = 'cancelled'
                 AND delivery.settlement_scope_id = candidate.operation_id
             ) AS cancelled
           FROM candidates AS candidate
           LEFT JOIN ${tables.operationEvents} AS indexed
             ON indexed.namespace = candidate.namespace
            AND indexed.operation_id = candidate.operation_id
           LEFT JOIN ${
          quoteEventIdentifier(databaseSchema)
        }."event_deliveries" AS delivery
             ON delivery.event_id = indexed.event_id
           GROUP BY candidate.operation_id, candidate.namespace
         )
         UPDATE ${tables.operations} AS operation
         SET state = CASE
               WHEN totals.failed > 0 THEN 'failed'
               WHEN totals.cancelled > 0 THEN 'cancelled'
               WHEN totals.unsettled > 0 THEN 'running'
               ELSE 'completed'
             END,
             updated_at = NOW(),
             completed_at = CASE
               WHEN totals.unsettled = 0 THEN COALESCE(operation.completed_at, NOW())
               ELSE operation.completed_at
             END
         FROM totals
         WHERE operation.operation_id = totals.operation_id
           AND operation.namespace = totals.namespace
           AND operation.state IS DISTINCT FROM CASE
               WHEN totals.failed > 0 THEN 'failed'
               WHEN totals.cancelled > 0 THEN 'cancelled'
               WHEN totals.unsettled > 0 THEN 'running'
               ELSE 'completed'
             END
         RETURNING operation.operation_id`,
        [drainedOperationIds],
      );
      for (const row of result.rows) {
        await notifyOperationChange(session, session, row.operation_id);
      }
      return result.rows.length;
    },
    async pruneTerminalMetadata(input) {
      if (!Number.isFinite(input.retentionMs) || input.retentionMs < 0) {
        throw new TypeError(
          "Operation catalog retentionMs must be non-negative.",
        );
      }
      const cutoff = new Date(
        (input.now ?? new Date()).getTime() - input.retentionMs,
      ).toISOString();
      const candidates = await session.query<{
        namespace: string;
        operation_id: string;
      }>(
        `SELECT namespace, operation_id FROM ${tables.operations}
          WHERE state IN ('completed','failed','cancelled')
            AND completed_at IS NOT NULL
            AND completed_at <= $1::timestamptz
          ORDER BY completed_at, namespace, operation_id LIMIT $2`,
        [cutoff, boundedLimit(input.limit)],
      );
      let streams = 0;
      let events = 0;
      let operations = 0;
      for (const candidate of candidates.rows) {
        const result = await session.transaction(async (transaction) => {
          // Canonical Asset storage remains authoritative after replay grace;
          // deleting this metadata must never touch its Body. Expiring
          // observation rows remain until their Body CAS retirement succeeds.
          const removedStreams = await transaction.query<{ stream_id: string }>(
            `DELETE FROM ${tables.operationStreams}
              WHERE namespace = $1 AND operation_id = $2
                AND (state = 'aborted' OR asset_retention = 'canonical')
              RETURNING stream_id`,
            [candidate.namespace, candidate.operation_id],
          );
          const remaining = await transaction.query<{ stream_id: string }>(
            `SELECT stream_id FROM ${tables.operationStreams}
              WHERE namespace = $1 AND operation_id = $2 LIMIT 1`,
            [candidate.namespace, candidate.operation_id],
          );
          if (remaining.rows.length > 0) {
            return Object.freeze({
              streams: removedStreams.rows.length,
              events: 0,
              operations: 0,
            });
          }
          const removedEvents = await transaction.query<{ event_id: string }>(
            `DELETE FROM ${tables.operationEvents}
              WHERE namespace = $1 AND operation_id = $2 RETURNING event_id`,
            [candidate.namespace, candidate.operation_id],
          );
          const removedOperation = await transaction.query<{
            operation_id: string;
          }>(
            `DELETE FROM ${tables.operations}
              WHERE namespace = $1 AND operation_id = $2
                AND state IN ('completed','failed','cancelled')
              RETURNING operation_id`,
            [candidate.namespace, candidate.operation_id],
          );
          return Object.freeze({
            streams: removedStreams.rows.length,
            events: removedEvents.rows.length,
            operations: removedOperation.rows.length,
          });
        });
        streams += result.streams;
        events += result.events;
        operations += result.operations;
      }
      return Object.freeze({ streams, events, operations });
    },
    async pruneStream(input) {
      const result = await session.query<{ stream_id: string }>(
        `DELETE FROM ${tables.operationStreams}
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state IN ('sealed','aborted')
          RETURNING stream_id`,
        [input.namespace, input.operationId, input.streamId],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
  };
  return Object.freeze(catalog);
}

export function operationStreamBodyId(
  input: Readonly<{
    namespace: string;
    streamId: string;
    bodyPrefix?: string;
  }>,
): string {
  const clean = (value: string) =>
    encodeURIComponent(requiredText(value, "Operation stream identity"))
      .replaceAll("%2F", "%252F");
  return [
    ...(input.bodyPrefix?.split("/").map((part) => part.trim()).filter(
      Boolean,
    ) ?? []),
    "content-streams",
    clean(input.namespace),
    clean(input.streamId),
  ].join("/");
}
