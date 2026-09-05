import type {
  IncompleteBodyHead,
  ReadyBodyHead,
} from "../content/body-store.ts";
import {
  quoteEventIdentifier,
  type SqlExecutor,
  type SqlSession,
  validateEventSchemaName,
} from "../events/index.ts";
import type {
  StreamCapture,
  StreamOutputDescriptor,
  StreamTerminalAvailability,
  StreamTerminalOutcome,
  StreamTerminalStatus,
} from "./types.ts";
import { snapshotStreamMetadata } from "./json.ts";
import { isStreamOutputDescriptor } from "./observation.ts";

export const OPERATION_CATALOG_FINGERPRINT = "retained-terminal-streams";
export const OPERATION_CHANGE_CHANNEL = "copilotz_operations";
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

export type OperationStreamRetention = "canonical" | "observation";

export type OperationStreamState = "open" | "terminating" | "terminal";

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
  state: OperationStreamState;
  outcome?: StreamTerminalOutcome;
  availability: StreamTerminalAvailability;
  capture?: StreamCapture;
  committedOffset: number;
  digest?: `sha256:${string}`;
  assetId?: string;
  retention?: OperationStreamRetention;
  terminalAt?: string;
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
      afterPosition?: string;
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
      semanticStreamId: string;
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
  ): Promise<boolean>;
  sealStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      body: ReadyBodyHead;
    }>,
  ): Promise<boolean>;
  beginStreamTerminalization(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      outcome: StreamTerminalOutcome;
      capture?: StreamCapture;
    }>,
  ): Promise<boolean>;
  terminateStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      body: IncompleteBodyHead;
      outcome: Exclude<StreamTerminalOutcome, "completed">;
      capture?: StreamCapture;
    }>,
  ): Promise<boolean>;
  markStreamUnavailable(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      outcome: Exclude<StreamTerminalOutcome, "completed">;
      availability: "purged" | "missing";
      capture?: StreamCapture;
    }>,
  ): Promise<boolean>;
  /** Removes a never-published catalog reservation and no terminal evidence. */
  discardStream(
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
        | Readonly<{ retention: "observation" }>
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
  findStream(
    namespace: string,
    streamId: string,
  ): Promise<OperationStreamRecord | null>;
  waitForStreamTerminal(
    namespace: string,
    streamId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<StreamTerminalStatus>;
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
  markStreamPurgePending(
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
  state: OperationStreamState;
  outcome: StreamTerminalOutcome | null;
  availability: StreamTerminalAvailability;
  capture: StreamCapture | null;
  committed_offset: string | number | bigint;
  digest: string | null;
  asset_id: string | null;
  asset_retention: OperationStreamRetention | null;
  terminal_at: string | Date | null;
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

function failedOutcome(
  value: Exclude<StreamTerminalOutcome, "completed">,
): Exclude<StreamTerminalOutcome, "completed"> {
  if (
    value !== "failed" && value !== "cancelled" &&
    value !== "superseded" && value !== "abandoned"
  ) {
    throw new TypeError("Operation stream terminal outcome is invalid.");
  }
  return value;
}

function streamCapture(value: StreamCapture | undefined): StreamCapture {
  if (value === undefined) return "truncated";
  if (value !== "complete" && value !== "truncated") {
    throw new TypeError("Operation stream capture is invalid.");
  }
  return value;
}

function terminalStatus(stream: OperationStreamRecord): StreamTerminalStatus {
  if (
    stream.state !== "terminal" || !stream.outcome || !stream.capture ||
    !stream.terminalAt
  ) {
    throw new Error(`Operation stream '${stream.streamId}' is not terminal.`);
  }
  return Object.freeze({
    outcome: stream.outcome,
    availability: stream.availability,
    capture: stream.capture,
    offset: stream.committedOffset,
    terminalAt: stream.terminalAt,
  });
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
  if (!isStreamOutputDescriptor(descriptor)) {
    throw new Error("Operation stream catalog contains an invalid descriptor.");
  }
  const byteOffset = Number(row.committed_offset);
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error("Operation stream catalog contains an invalid offset.");
  }
  const terminalAt = iso(row.terminal_at);
  if (
    (row.state === "open" &&
      (row.outcome !== null || row.capture !== null || terminalAt)) ||
    (row.state === "terminating" &&
      (!row.outcome || !row.capture || terminalAt ||
        (row.outcome === "completed" && row.capture !== "complete"))) ||
    (row.state === "terminal" &&
      (!row.outcome || !row.capture || !terminalAt)) ||
    (row.outcome === "completed" && row.capture !== "complete") ||
    (row.asset_retention === "canonical" && row.outcome !== "completed")
  ) {
    throw new Error(
      "Operation stream catalog contains invalid terminal state.",
    );
  }
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
    ...(row.outcome ? { outcome: row.outcome } : {}),
    availability: row.availability,
    ...(row.capture ? { capture: row.capture } : {}),
    committedOffset: byteOffset,
    ...(row.digest ? { digest: String(row.digest) as `sha256:${string}` } : {}),
    ...(row.asset_id ? { assetId: String(row.asset_id) } : {}),
    ...(row.asset_retention ? { retention: row.asset_retention } : {}),
    ...(terminalAt ? { terminalAt } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  });
}

/** Additive operational tables; the Core Event schema is unchanged. */
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
      fingerprint TEXT NOT NULL CHECK (fingerprint = '${OPERATION_CATALOG_FINGERPRINT}')
    )`);
    await transaction.query(`CREATE TABLE IF NOT EXISTS ${tables.operations} (
      operation_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      root_event_id TEXT NOT NULL UNIQUE,
      correlation_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      next_stream_ordinal BIGINT NOT NULL DEFAULT 1,
      state TEXT NOT NULL CHECK (state IN ('accepted','running','completed','failed','cancelled')),
      accepted_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )`);
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
      stream_ordinal BIGINT NOT NULL,
      stream_id TEXT NOT NULL,
      semantic_stream_id TEXT NOT NULL,
      body_id TEXT NOT NULL,
      descriptor JSONB NOT NULL,
      state TEXT NOT NULL CONSTRAINT copilotz_operation_streams_state_check
        CHECK (state IN ('open','terminating','terminal')),
      outcome TEXT CONSTRAINT copilotz_operation_streams_outcome_check
        CHECK (outcome IN ('completed','failed','cancelled','superseded','abandoned')),
      availability TEXT NOT NULL DEFAULT 'retained'
        CONSTRAINT copilotz_operation_streams_availability_check
        CHECK (availability IN ('retained','purge_pending','purged','missing')),
      capture TEXT CONSTRAINT copilotz_operation_streams_capture_check
        CHECK (capture IN ('complete','truncated')),
      committed_offset BIGINT NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
      digest TEXT,
      asset_id TEXT,
      asset_retention TEXT CHECK (asset_retention IN ('canonical','observation')),
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, operation_id, stream_id),
      UNIQUE (namespace, stream_id),
      UNIQUE (namespace, operation_id, stream_ordinal),
      CONSTRAINT copilotz_operation_streams_terminal_check CHECK (
        (state = 'open' AND outcome IS NULL AND capture IS NULL
          AND terminal_at IS NULL AND availability = 'retained')
        OR
        (state = 'terminating' AND outcome IS NOT NULL
          AND capture IS NOT NULL AND terminal_at IS NULL
          AND availability = 'retained'
          AND (outcome <> 'completed' OR capture = 'complete'))
        OR
        (state = 'terminal' AND outcome IS NOT NULL AND capture IS NOT NULL
          AND terminal_at IS NOT NULL
          AND (outcome <> 'completed' OR capture = 'complete')
          AND (asset_retention <> 'canonical' OR outcome = 'completed'))
      )
    )`,
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
      `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_retention_idx"
      ON ${tables.operationStreams} (
        asset_retention, availability, namespace, operation_id, stream_id
      ) WHERE state = 'terminal'`,
    );
    await transaction.query(
      `INSERT INTO ${tables.metadata} (singleton, fingerprint) VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO NOTHING`,
      [OPERATION_CATALOG_FINGERPRINT],
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
            AND column_name IN (
              'replay_key','stream_ordinal','semantic_stream_id','outcome',
              'availability','capture','terminal_at'
            ))
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
    !present.has("copilotz_operation_streams.semantic_stream_id") ||
    !present.has("copilotz_operation_streams.outcome") ||
    !present.has("copilotz_operation_streams.availability") ||
    !present.has("copilotz_operation_streams.capture") ||
    !present.has("copilotz_operation_streams.terminal_at")
  ) {
    throw operationCatalogError(
      schema,
      "does not match the required stream catalog schema",
      "copilotz_operation_catalog_not_provisioned",
    );
  }
  const marker = await session.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM ${tables.metadata} WHERE singleton = TRUE LIMIT 1`,
  );
  if (marker.rows[0]?.fingerprint !== OPERATION_CATALOG_FINGERPRINT) {
    throw operationCatalogError(
      schema,
      "has an unsupported schema fingerprint",
      "copilotz_operation_catalog_schema_unsupported",
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
      if (
        input.afterPosition && !/^(0|[1-9][0-9]*)$/.test(input.afterPosition)
      ) throw new TypeError("Invalid event position.");
      const progressFilter = input.afterPosition
        ? ` AND (operation.state IN ('accepted', 'running') OR EXISTS (
        SELECT 1 FROM ${tables.operationEvents} AS progress WHERE progress.namespace = operation.namespace
        AND progress.operation_id = operation.operation_id AND progress.event_position > $${
          params.push(input.afterPosition)
        }::bigint))`
        : "";
      params.push(boundedLimit(input.limit));
      const result = await session.query<OperationRow>(
        `SELECT operation.* FROM ${tables.operations} AS operation
          WHERE operation.namespace = $1${stateFilter}${progressFilter}
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
                SET state = 'terminating', outcome = 'cancelled',
                    capture = 'truncated', availability = 'retained',
                    updated_at = NOW()
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
                  AND stream.operation_id = $2
                  AND stream.state IN ('open','terminating')
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
      if (!isStreamOutputDescriptor(descriptor)) {
        throw new TypeError("Operation stream descriptor is invalid.");
      }
      const namespace = requiredText(input.namespace, "Operation namespace");
      const operationId = requiredText(input.operationId, "Operation id");
      const streamId = requiredText(
        input.descriptor.streamId,
        "Operation stream id",
      );
      const semanticStreamId = requiredText(
        input.semanticStreamId,
        "Operation semantic stream id",
      );
      const bodyId = requiredText(input.bodyId, "Operation stream body id");
      const replayKey = await session.transaction(async (transaction) => {
        const operation = await transaction.query<{
          next_stream_ordinal: string | number | bigint;
        }>(
          `SELECT next_stream_ordinal FROM ${tables.operations}
            WHERE namespace = $1 AND operation_id = $2
              AND state IN ('accepted','running')
            LIMIT 1 FOR UPDATE`,
          [namespace, operationId],
        );
        if (!operation.rows[0]) return undefined;
        // A durable delivery retry must never append a restarted provider's
        // bytes to the previous execution. Opening the new physical lane
        // atomically closes any still-open incarnation of the same semantic
        // lane. The catalog records terminal intent before maintenance fences
        // and freezes that published Body prefix.
        await transaction.query(
          `UPDATE ${tables.operationStreams}
              SET state = 'terminating', outcome = 'superseded',
                  capture = 'truncated', availability = 'retained',
                  updated_at = NOW()
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
          state: OperationStreamState;
        }>(
          `SELECT replay_key, stream_ordinal, body_id, semantic_stream_id, state
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
          if (existing.rows[0].state !== "open") {
            throw new Error(
              `Operation stream '${streamId}' cannot reopen after terminalization began.`,
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
             availability, asset_retention, committed_offset,
             created_at, updated_at
           ) VALUES (
             $1,$2,$3::bigint,$4,$5,$6,$7::jsonb,'open',
             'retained','observation',0,NOW(),NOW()
           )
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
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET committed_offset = GREATEST(committed_offset, $4::bigint),
               updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state = 'open'
         RETURNING stream_id`,
        [input.namespace, input.operationId, input.streamId, committedOffset],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async sealStream(input) {
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET state = 'terminal', outcome = 'completed',
               availability = 'retained', capture = 'complete',
               committed_offset = $4::bigint, digest = $5, asset_id = NULL,
               asset_retention = 'observation',
               terminal_at = COALESCE(terminal_at, NOW()), updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND body_id = $6
           AND (
             state = 'open'
             OR (state = 'terminating' AND outcome = 'completed')
             OR (state = 'terminal' AND outcome = 'completed'
               AND committed_offset = $4::bigint AND digest = $5)
           )
         RETURNING stream_id`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          offset(input.body.byteLength),
          input.body.digest,
          input.body.bodyId,
        ],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async beginStreamTerminalization(input) {
      const outcome = input.outcome === "completed"
        ? "completed"
        : failedOutcome(input.outcome);
      const capture = outcome === "completed"
        ? "complete"
        : streamCapture(input.capture);
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET state = 'terminating', outcome = $4, capture = $5,
               availability = 'retained', updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND (
             state = 'open'
             OR (state = 'terminating' AND outcome = $4 AND capture = $5)
           )
         RETURNING stream_id`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          outcome,
          capture,
        ],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async terminateStream(input) {
      const outcome = failedOutcome(input.outcome);
      const capture = streamCapture(input.capture);
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET state = 'terminal',
               outcome = CASE
                 WHEN state IN ('terminating','terminal') THEN outcome ELSE $4
               END,
               capture = CASE
                 WHEN state IN ('terminating','terminal') THEN capture ELSE $5
               END,
               availability = 'retained',
               committed_offset = $6::bigint, digest = $7,
               asset_id = NULL, asset_retention = 'observation',
               terminal_at = COALESCE(terminal_at, NOW()), updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND body_id = $8
           AND (
             state = 'open'
             OR (state = 'terminating' AND outcome <> 'completed')
             OR (state = 'terminal' AND outcome <> 'completed'
               AND committed_offset = $6::bigint AND digest = $7)
           )
         RETURNING stream_id`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          outcome,
          capture,
          offset(input.body.byteLength),
          input.body.digest,
          input.body.bodyId,
        ],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async markStreamUnavailable(input) {
      const outcome = failedOutcome(input.outcome);
      const capture = streamCapture(input.capture);
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
           SET state = 'terminal',
               outcome = CASE
                 WHEN state IN ('terminating','terminal') THEN outcome ELSE $4
               END,
               capture = CASE
                 WHEN state IN ('terminating','terminal') THEN capture ELSE $5
               END,
               availability = $6, digest = NULL, asset_id = NULL,
               asset_retention = 'observation',
               terminal_at = COALESCE(terminal_at, NOW()), updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state IN ('open','terminating')
         RETURNING stream_id`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          outcome,
          capture,
          input.availability,
        ],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async discardStream(input) {
      const result = await session.query<{ stream_id: string }>(
        `DELETE FROM ${tables.operationStreams}
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state = 'open' AND committed_offset = 0
          RETURNING stream_id`,
        [input.namespace, input.operationId, input.streamId],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async retainStream(input) {
      const assetId = input.retention === "canonical"
        ? requiredText(input.assetId, "Operation stream asset id")
        : undefined;
      await session.query(
        `UPDATE ${tables.operationStreams}
           SET asset_id = $4, asset_retention = $5, updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state = 'terminal' AND outcome = 'completed'`,
        [
          input.namespace,
          input.operationId,
          input.streamId,
          assetId ?? null,
          input.retention,
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
    async findStream(namespaceInput, streamIdInput) {
      const result = await session.query<StreamRow>(
        `SELECT * FROM ${tables.operationStreams}
          WHERE namespace = $1 AND stream_id = $2 LIMIT 1`,
        [
          requiredText(namespaceInput, "Operation namespace"),
          requiredText(streamIdInput, "Operation stream id"),
        ],
      );
      return result.rows[0] ? mapStream(result.rows[0]) : null;
    },
    async waitForStreamTerminal(
      namespaceInput,
      streamIdInput,
      waitOptions = {},
    ) {
      const namespace = requiredText(namespaceInput, "Operation namespace");
      const streamId = requiredText(streamIdInput, "Operation stream id");
      let stream = await catalog.findStream(namespace, streamId);
      if (!stream) {
        throw Object.assign(new Error("Operation stream was not found."), {
          status: 404,
          code: "operation_stream_not_found",
        });
      }
      const watch = await catalog.watch(stream.operationId);
      try {
        while (!waitOptions.signal?.aborted) {
          if (stream.state === "terminal") return terminalStatus(stream);
          await watch.wait({ timeoutMs: 5_000, signal: waitOptions.signal });
          const current = await catalog.getStream(
            namespace,
            stream.operationId,
            streamId,
          );
          if (!current) {
            throw Object.assign(
              new Error("Operation stream replay metadata has expired."),
              { status: 410, code: "operation_replay_expired" },
            );
          }
          stream = current;
        }
        throw waitOptions.signal?.reason instanceof Error
          ? waitOptions.signal.reason
          : new DOMException(
            "Operation stream wait was aborted.",
            "AbortError",
          );
      } finally {
        watch.close();
      }
    },
    async hasOpenStreams(namespaceInput, operationIdInput) {
      const result = await session.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${tables.operationStreams}
            WHERE namespace = $1 AND operation_id = $2
              AND state IN ('open','terminating')
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
           SELECT 1 FROM ${tables.operationStreams}
            WHERE body_id = $1
              AND availability IN ('retained','purge_pending')
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
          WHERE stream.state IN ('open','terminating')
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
            AND stream.state = 'terminal'
            AND stream.availability IN ('retained','purge_pending')
            AND operation.state IN ('completed','failed','cancelled')
            AND operation.completed_at IS NOT NULL
            AND operation.completed_at <= $1::timestamptz
          ORDER BY operation.completed_at, stream.namespace,
                   stream.operation_id, stream.stream_id LIMIT $2`,
        [completedCutoff, boundedLimit(input.limit)],
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
                 AND open_stream.state IN ('open','terminating')
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
                  AND open_stream.state IN ('open','terminating')
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
                AND state = 'terminal'
                AND (
                  asset_retention = 'canonical'
                  OR (
                    availability IN ('purged','missing')
                    AND updated_at <= $3::timestamptz
                  )
                )
              RETURNING stream_id`,
            [candidate.namespace, candidate.operation_id, cutoff],
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
        `UPDATE ${tables.operationStreams}
            SET availability = 'purged', digest = NULL, updated_at = NOW()
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state = 'terminal' AND availability = 'purge_pending'
          RETURNING stream_id`,
        [input.namespace, input.operationId, input.streamId],
      );
      if (result.rows.length > 0) {
        await notifyOperationChange(session, session, input.operationId);
      }
      return result.rows.length > 0;
    },
    async markStreamPurgePending(input) {
      const result = await session.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
            SET availability = 'purge_pending', updated_at = NOW()
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state = 'terminal' AND asset_retention = 'observation'
            AND availability = 'retained'
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
