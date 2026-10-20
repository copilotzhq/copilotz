import { invalidateOwnerAlarm } from "../engine/alarms.ts";
import {
  CONTENT_REPLAY_RETENTION_MS,
  type ContentCatalog,
  type ContentTerminal,
  createContentCatalog,
} from "../content/catalog.ts";
import {
  reconciliationAlarmKey,
  writeOwnerDeadline,
} from "../engine/alarms.ts";
import {
  assertSchemaCommandTransaction,
  type CommandContext,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import { afterSqlCommit } from "../events/session.ts";
import {
  attachOwnerPush,
  type OwnerPushPosition,
  stageOwnerChange,
} from "../events/push.ts";
import {
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
} from "../events/schema.ts";
import { runSqlTransaction } from "../events/session.ts";
import type { ReadyBodyHead } from "../content/body-store.ts";
import type { DeliveryLease, DurableEvent } from "../events/types.ts";
import {
  quoteEventIdentifier,
  type SqlExecutor,
  type SqlSession,
  validateEventSchemaName,
} from "../events/index.ts";
import type {
  StreamOutputDescriptor,
  StreamTerminalAvailability,
  StreamTerminalOutcome,
  StreamTerminalStatus,
} from "./types.ts";
import { ContentStreamOwnershipLostError } from "./stream.ts";
import { snapshotStreamMetadata } from "./json.ts";
import { isStreamOutputDescriptor } from "./observation.ts";

type StreamCoordinates = Readonly<{
  namespace: string;
  operationId: string;
  streamId: string;
}>;

export const OPERATION_CATALOG_FINGERPRINT = "stream-content-authority-v1";
const STREAM_TERMINAL_CHECK = `
  (reason IS NULL OR length(btrim(reason)) > 0)
  AND (availability_reason IS NULL OR length(btrim(availability_reason)) > 0)
  AND (availability = 'retained' OR availability_reason IS NOT NULL)
  AND (availability <> 'retained' OR availability_reason IS NULL)
  AND (cleanup_state IS NULL OR (state = 'terminal' AND availability = 'retained'))
  AND (
    (state = 'open' AND outcome IS NULL AND reason IS NULL
      AND terminal_at IS NULL AND availability = 'retained')
    OR (state = 'terminating' AND outcome IS NOT NULL
      AND terminal_at IS NULL AND availability = 'retained')
    OR (state = 'terminal' AND outcome IS NOT NULL AND terminal_at IS NOT NULL
      AND (asset_retention <> 'canonical' OR outcome = 'completed'))
  )`;
export const DEFAULT_OPERATION_REPLAY_RETENTION_MS = 24 * 60 * 60_000;

// Query work budget, independent of page size or operation membership rules.
const MAX_CORRELATED_ASSOCIATION_CANDIDATES = 32;

export type OperationChangeSubscription = Readonly<{
  /** True means a committed change or repair arrived; false is the wait deadline. */
  wait(
    options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
  ): Promise<boolean>;
  close(): void;
}>;

export type OperationChangeDetail = Readonly<{
  namespace: string;
  selectionKeys: readonly string[];
  kind?:
    | "event"
    | "operation"
    | "stream"
    | "stream-offset"
    | "retirement"
    | "heartbeat"
    | "checkpoint"
    | "reset";
  headSeq?: string;
  positions?: readonly OwnerPushPosition[];
  reason?: string;
  streamId?: string;
  committedOffset?: number;
}>;
export type OperationChangeListener = (
  operationId: string,
  detail: OperationChangeDetail,
) => void;
export type OperationSelectionHead = Readonly<{
  selectionKey: string;
  changeOrdinal: string;
}>;
export type OperationSelectionChange = OperationRecord & OperationSelectionHead;

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
  cancellationRequestedAt?: string;
  parent?: Readonly<{ operationId: string; actionRunId: string }>;
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
  availabilityReason?: string;
  /** Internal retirement progress; availability changes only after deletion. */
  cleanupState?: "pending";
  reason?: string;
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
  selectionHeads: string;
  selectionOperations: string;
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

/**
 * Generic metadata branches used to associate operations with indexed events.
 * Supplied branches are combined with OR semantics; list metadata stays AND.
 */
export type OperationCatalogAssociation = Readonly<{
  operationMetadata?: Readonly<Record<string, unknown>>;
  eventMetadata?: Readonly<Record<string, unknown>>;
}>;

export type OperationCatalog = Readonly<{
  /** Last sequenced command associated with this operation, including terminal publication. */
  resultSequence(namespace: string, operationId: string): Promise<string>;
  databaseSchema: string;
  /** In-memory committed frontier from the existing owner subscription. */
  pushState(
    input: Readonly<
      {
        namespace: string;
        operationIds: readonly string[];
        streamIds?: readonly string[];
      }
    >,
  ): Readonly<
    {
      headSeq: string;
      payloadPositions: readonly Readonly<
        { streamId: string; committedOffset: number }
      >[];
    }
  >;
  watch(
    operationId: string,
    options?: Readonly<{
      namespace?: string;
      /** Filter lifecycle changes; repair frames always wake the reader. */
      kind?: OperationChangeDetail["kind"];
    }>,
  ): Promise<OperationChangeSubscription>;
  /** Owner-ordered postcommit changes; heartbeats repair lost pushes. */
  onChange(
    listener: OperationChangeListener,
    options?: Readonly<{ namespace?: string }>,
  ): Promise<() => void>;
  getSelectionHeads(
    input: Readonly<{
      namespace: string;
      selectionKeys: readonly string[];
    }>,
  ): Promise<readonly OperationSelectionHead[]>;
  /** Latest changes, ordered by the commit-ordered selection counter. */
  listSelectionChanges(
    input: Readonly<{
      namespace: string;
      selectionKey: string;
      afterChangeOrdinal?: string;
      operationIds?: readonly string[];
      states?: readonly OperationState[];
      limit?: number;
    }>,
  ): Promise<readonly OperationSelectionChange[]>;
  listOperationEventIds(
    input: Readonly<{
      namespace: string;
      operationId: string;
      afterEventOrdinal?: string;
      limit?: number;
    }>,
  ): Promise<readonly Readonly<{ eventId: string; eventOrdinal: string }>[]>;
  /** Same scope lock as settlement, before new event work is admitted. */
  admitEventSql(
    input: Readonly<
      {
        namespace: string;
        operationId: string;
        requireScope?: boolean;
        cancellationTerminal?: boolean;
      }
    >,
    param: (value: unknown) => string,
  ): Readonly<{ ctes: readonly string[]; gate: string; cancelled: string }>;
  indexEvent(
    transaction: SqlExecutor,
    input: OperationEventIndexInput,
  ): Promise<void>;
  /**
   * Returns CTEs that index an event inserted by a sibling `inserted_event`
   * CTE of the same statement. `param` binds a value and returns its
   * placeholder.
   */
  indexEventSql(
    input: Omit<OperationEventIndexInput, "position">,
    param: (value: unknown) => string,
  ): string;
  get(
    namespace: string,
    operationId: string,
    transaction?: SqlExecutor,
  ): Promise<OperationRecord | null>;
  list(
    input: Readonly<{
      namespace: string;
      operationIds?: readonly string[];
      states?: readonly OperationState[];
      metadata?: Readonly<Record<string, unknown>>;
      association?: OperationCatalogAssociation;
      afterPosition?: string;
      limit?: number;
    }>,
  ): Promise<readonly OperationRecord[]>;
  /** Omitted or empty eventMetadata means every event in the namespace. */
  maxEventPosition(
    input: Readonly<{
      namespace: string;
      eventMetadata?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<string | undefined>;
  requestCancellation(
    transaction: SqlExecutor,
    namespace: string,
    operationId: string,
    reason: string,
  ): Promise<void>;
  listEventIds(
    input: Readonly<{
      namespace: string;
      operationId: string;
      afterPosition?: string;
      limit?: number;
    }>,
  ): Promise<readonly Readonly<{ eventId: string; position: string }>[]>;
  /**
   * Finds an event in the operation by opaque subject/type coordinates. An
   * optional authoritative deduplication identity is preferred; the earliest
   * scoped match is the fallback for events without that identity.
   */
  findEventId(
    input: Readonly<{
      namespace: string;
      operationId: string;
      subjectId: string;
      typeSuffix: string;
      deduplicationId?: string;
    }>,
  ): Promise<string | undefined>;
  openStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      semanticStreamId: string;
      bodyId: string;
      descriptor: StreamOutputDescriptor;
      deliveryLease?: DeliveryLease;
    }>,
  ): Promise<
    Readonly<{ replayKey: string; streamOrdinal: string }> | undefined
  >;
  /** Accepted logical transitions and their exact stream projection share one command. */
  acceptStreamCheckpoint(
    input: StreamCoordinates & {
      content: Parameters<ContentCatalog["checkpoint"]>[0];
    },
  ): Promise<number>;
  acceptStreamSealIntent(
    input: StreamCoordinates & {
      content: Parameters<ContentCatalog["sealIntent"]>[0];
    },
  ): ReturnType<ContentCatalog["sealIntent"]>;
  acceptStreamSeal(
    input: StreamCoordinates & {
      content: Parameters<ContentCatalog["sealAccepted"]>[0];
    },
  ): Promise<ContentTerminal>;
  acceptStreamFailure(
    input: StreamCoordinates & {
      content: Parameters<ContentCatalog["recordFailure"]>[0];
    },
  ): Promise<ContentTerminal>;
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
      reason?: string;
    }>,
  ): Promise<boolean>;
  terminateStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      body: Readonly<{ bodyId: string; byteLength: number }>;
      outcome: Exclude<StreamTerminalOutcome, "completed">;
      reason?: string;
    }>,
  ): Promise<boolean>;
  markStreamUnavailable(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      outcome: StreamTerminalOutcome;
      availabilityReason: string;
      reason?: string;
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
  /** Internal commit hooks share the serialized owner transaction. */
  failDeliveryStreams(
    transaction: SqlExecutor,
    input: Readonly<{
      deliveryId: string;
      operationId: string;
      outcome: "failed" | "cancelled";
    }>,
  ): Promise<void>;
  reconcile(
    input?: Readonly<
      { limit?: number; namespace?: string; operationId?: string }
    >,
    transaction?: SqlExecutor,
    outcome?: "failed",
  ): Promise<number>;
  pruneTerminalMetadata(
    input: Readonly<{ now?: Date; retentionMs: number; limit?: number }>,
  ): Promise<
    Readonly<{ streams: number; events: number; operations: number }>
  >;
  /** Records confirmed deletion or absence of the physical copy. */
  pruneStream(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
      availabilityReason?: "deleted" | "missing";
    }>,
  ): Promise<boolean>;
  beginStreamCleanup(
    input: Readonly<{
      namespace: string;
      operationId: string;
      streamId: string;
    }>,
  ): Promise<boolean>;
}>;

/** Publish one committed catalog transition and record its lifecycle in owner history. */
export async function publishOperationChange(
  _session: SqlSession,
  executor: SqlExecutor,
  schema: string,
  namespace: string,
  operationId: string,
  change: Pick<OperationChangeDetail, "kind" | "streamId" | "committedOffset"> =
    { kind: "operation" },
): Promise<void> {
  assertSchemaCommandTransaction(executor, schema);
  const tables = createOperationCatalogTables(schema);
  const core = createCoreTableNames(schema);
  const kind = change.kind ?? "operation";
  if (kind !== "stream-offset" && kind !== "event") {
    invalidateOwnerAlarm(executor, schema, "content");
  }
  if (["heartbeat", "checkpoint", "reset"].includes(kind)) {
    throw new TypeError("Control frames are not catalog mutations.");
  }
  // Read publication state and selection membership from the same snapshot.
  const publication = (await executor.query<{
    selection_keys: string[];
    last_seq: string | number;
    state: Record<string, unknown> | null;
  }>(
    `SELECT ARRAY(SELECT selection_key FROM ${tables.selectionOperations}
       WHERE namespace=$1 AND operation_id=$2 ORDER BY selection_key) AS selection_keys,
       (SELECT last_seq FROM ${core.owner_epochs} WHERE owner='schema') AS last_seq,
       ${
      kind === "stream-offset" || kind === "event"
        ? "NULL::jsonb"
        : change.streamId
        ? `(SELECT to_jsonb(publication_state) FROM (SELECT stream_id,state,outcome,reason,availability,availability_reason,descriptor
             FROM ${tables.operationStreams} WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3) publication_state)`
        : `(SELECT to_jsonb(publication_state) FROM (SELECT state,cancellation_requested_at
             FROM ${tables.operations} WHERE namespace=$1 AND operation_id=$2) publication_state)`
    } AS state`,
    change.streamId && kind !== "stream-offset" && kind !== "event"
      ? [namespace, operationId, change.streamId]
      : [namespace, operationId],
  )).rows[0];
  const selectionKeys = publication.selection_keys;
  let seq: string;
  let event: DurableEvent | undefined;
  if (kind === "stream-offset" || kind === "event") {
    seq = String(publication.last_seq);
  } else {
    // Preserve the retained publication digest's field order and timestamp
    // encoding when the snapshot arrives as jsonb instead of separate columns.
    const state = publication.state === null
      ? null
      : change.streamId
      ? Object.fromEntries([
        "stream_id",
        "state",
        "outcome",
        "reason",
        "availability",
        "availability_reason",
        "descriptor",
      ].map((key) => [key, publication.state![key]]))
      : {
        state: publication.state.state,
        cancellation_requested_at: publication.state.cancellation_requested_at
          ? new Date(String(publication.state.cancellation_requested_at))
            .toISOString()
          : null,
      };
    const payload = {
      operationId,
      kind,
      ...(change.streamId ? { streamId: change.streamId } : {}),
      state,
      selectionKeys,
    };
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify(payload),
          ),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const dedup = `catalog:${operationId}:${digest}`;
    const id = crypto.randomUUID();
    const result = await executor.query<
      {
        seq: string | number;
        position: string | number;
        created_at: string | Date;
      }
    >(
      `WITH allocated AS (UPDATE ${core.owner_epochs} SET last_seq=last_seq+1 WHERE owner='schema'
         AND NOT EXISTS (SELECT 1 FROM ${core.events} WHERE namespace=$3 AND deduplication_id=$6) RETURNING last_seq),
       inserted AS (INSERT INTO ${core.events} (seq,id,schema_version,type,namespace,payload,metadata,correlation_id,deduplication_id)
         SELECT last_seq,$1,$2,'operation.catalog.changed',$3,$4::jsonb,'{}'::jsonb,$5,$6 FROM allocated RETURNING seq,id,position,created_at)
       SELECT seq,position,created_at FROM inserted`,
      [
        id,
        EVENT_SCHEMA_VERSION,
        namespace,
        JSON.stringify(payload),
        operationId,
        dedup,
      ],
    );
    if (!result.rows.length) return;
    seq = String(result.rows[0].seq);
    event = {
      durable: true,
      id,
      position: String(result.rows[0].position),
      seq,
      schemaVersion: EVENT_SCHEMA_VERSION,
      type: "operation.catalog.changed",
      namespace,
      payload,
      metadata: {},
      correlationId: operationId,
      deduplicationId: dedup,
      createdAt: new Date(result.rows[0].created_at).toISOString(),
    };
  }
  stageOwnerChange(executor, schema, {
    namespace,
    operationId,
    selectionKeys,
    seq,
    ...(event ? { event } : {}),
    kind: kind as
      | "event"
      | "operation"
      | "stream"
      | "stream-offset"
      | "retirement",
    ...(change.streamId ? { streamId: change.streamId } : {}),
    ...(change.committedOffset === undefined
      ? {}
      : { committedOffset: change.committedOffset }),
  });
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
  cancellation_requested_at: string | Date | null;
  parent_operation_id: string | null;
  parent_action_run_id: string | null;
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
  reason: string | null;
  availability_reason: string | null;
  cleanup_state: "pending" | null;
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

function eventPosition(value: string, label = "Event position"): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function operationState(value: OperationState): OperationState {
  if (
    value !== "accepted" && value !== "running" &&
    value !== "completed" && value !== "failed" && value !== "cancelled"
  ) {
    throw new TypeError("Operation state is invalid.");
  }
  return value;
}

function metadataObject(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return snapshotStreamMetadata(value);
}

type PreparedAssociation = Readonly<{
  operationMetadata?: string;
  eventMetadata?: string;
}>;

function prepareAssociation(
  value: OperationCatalogAssociation | undefined,
): PreparedAssociation | undefined {
  if (value === undefined) return undefined;
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Operation association must be a plain object.");
  }
  const operationMetadata = value.operationMetadata === undefined
    ? undefined
    : metadataObject(
      value.operationMetadata,
      "Operation association operationMetadata",
    );
  const eventMetadata = value.eventMetadata === undefined
    ? undefined
    : metadataObject(
      value.eventMetadata,
      "Operation association eventMetadata",
    );
  if (operationMetadata === undefined && eventMetadata === undefined) {
    throw new TypeError(
      "Operation association requires operationMetadata or eventMetadata.",
    );
  }
  if (operationMetadata && Object.keys(operationMetadata).length === 0) {
    throw new TypeError("Operation association operationMetadata is empty.");
  }
  if (eventMetadata && Object.keys(eventMetadata).length === 0) {
    throw new TypeError("Operation association eventMetadata is empty.");
  }
  return {
    ...(operationMetadata
      ? { operationMetadata: JSON.stringify(operationMetadata) }
      : {}),
    ...(eventMetadata ? { eventMetadata: JSON.stringify(eventMetadata) } : {}),
  };
}

function failedOutcome(
  value: Exclude<StreamTerminalOutcome, "completed">,
): Exclude<StreamTerminalOutcome, "completed"> {
  if (
    value !== "failed" && value !== "cancelled"
  ) {
    throw new TypeError("Operation stream terminal outcome is invalid.");
  }
  return value;
}

function streamReason(value: string | undefined): string | null {
  return value === undefined
    ? null
    : requiredText(value, "Operation stream reason");
}

function terminalStatus(stream: OperationStreamRecord): StreamTerminalStatus {
  if (
    stream.state !== "terminal" || !stream.outcome ||
    !stream.terminalAt
  ) {
    throw new Error(`Operation stream '${stream.streamId}' is not terminal.`);
  }
  return ({
    outcome: stream.outcome,
    availability: stream.availability,
    ...(stream.reason ? { reason: stream.reason } : {}),
    ...(stream.availabilityReason
      ? { availabilityReason: stream.availabilityReason }
      : {}),
    offset: stream.committedOffset,
    terminalAt: stream.terminalAt,
  } as const);
}

export function createOperationCatalogTables(
  schemaName: string,
): OperationCatalogTables {
  const schema = quoteEventIdentifier(validateEventSchemaName(schemaName));
  const table = (name: string) => `${schema}.${quoteEventIdentifier(name)}`;
  return ({
    metadata: table("copilotz_operation_catalog_metadata"),
    operations: table("copilotz_operations"),
    operationEvents: table("copilotz_operation_events"),
    operationStreams: table("copilotz_operation_streams"),
    events: table("events"),
    selectionHeads: table("copilotz_operation_selection_heads"),
    selectionOperations: table("copilotz_operation_selections"),
  } as const);
}

function mapOperation(row: OperationRow): OperationRecord {
  const completedAt = iso(row.completed_at);
  return ({
    operationId: String(row.operation_id),
    namespace: String(row.namespace),
    rootEventId: String(row.root_event_id),
    correlationId: String(row.correlation_id),
    metadata: snapshotStreamMetadata(row.metadata),
    state: row.state,
    acceptedAt: iso(row.accepted_at)!,
    updatedAt: iso(row.updated_at)!,
    ...(completedAt ? { completedAt } : {}),
    ...(row.parent_operation_id && row.parent_action_run_id
      ? {
        parent: {
          operationId: row.parent_operation_id,
          actionRunId: row.parent_action_run_id,
        },
      }
      : {}),
    ...(row.cancellation_requested_at
      ? { cancellationRequestedAt: iso(row.cancellation_requested_at)! }
      : {}),
  } as const);
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
      (row.outcome !== null || row.reason !== null || terminalAt)) ||
    (row.state === "terminating" &&
      (!row.outcome || terminalAt)) ||
    (row.state === "terminal" &&
      (!row.outcome || !terminalAt)) ||
    (row.asset_retention === "canonical" && row.outcome !== "completed")
  ) {
    throw new Error(
      "Operation stream catalog contains invalid terminal state.",
    );
  }
  return ({
    operationId: String(row.operation_id),
    namespace: String(row.namespace),
    streamId: String(row.stream_id),
    semanticStreamId: String(row.semantic_stream_id),
    replayKey: String(row.replay_key),
    streamOrdinal: String(row.stream_ordinal),
    bodyId: String(row.body_id),
    descriptor: descriptor,
    state: row.state,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    availability: row.availability,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.availability_reason
      ? { availabilityReason: row.availability_reason }
      : {}),
    ...(row.cleanup_state ? { cleanupState: row.cleanup_state } : {}),
    committedOffset: byteOffset,
    ...(row.digest ? { digest: String(row.digest) as `sha256:${string}` } : {}),
    ...(row.asset_id ? { assetId: String(row.asset_id) } : {}),
    ...(row.asset_retention ? { retention: row.asset_retention } : {}),
    ...(terminalAt ? { terminalAt } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  } as const);
}

async function provisionSelectionTables(
  transaction: SqlExecutor,
  tables: OperationCatalogTables,
): Promise<void> {
  await transaction.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operation_events_ordinal_idx"
    ON ${tables.operationEvents} (namespace, operation_id, event_ordinal)`,
  );
  await transaction.query(`CREATE TABLE IF NOT EXISTS ${tables.selectionHeads} (
    namespace TEXT NOT NULL,
    selection_key TEXT NOT NULL,
    change_ordinal BIGINT NOT NULL CHECK (change_ordinal >= 0),
    PRIMARY KEY (namespace, selection_key)
  )`);
  await transaction.query(
    `CREATE TABLE IF NOT EXISTS ${tables.selectionOperations} (
    namespace TEXT NOT NULL,
    selection_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    change_ordinal BIGINT NOT NULL CHECK (change_ordinal >= 1),
    PRIMARY KEY (namespace, selection_key, operation_id)
  )`,
  );
  await transaction.query(
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_selections_changes_idx"
    ON ${tables.selectionOperations} (namespace, selection_key, change_ordinal, operation_id)`,
  );
  await transaction.query(
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_selections_operation_idx"
    ON ${tables.selectionOperations} (namespace, operation_id, selection_key)`,
  );
}

function observationKeys(
  metadata: Readonly<Record<string, unknown>>,
): readonly string[] {
  const value = metadata.observationKeys;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) {
    throw new TypeError(
      "Operation metadata observationKeys must be an array of strings.",
    );
  }
  return [...new Set(value.map((key) => requiredText(key, "Observation key")))]
    .sort();
}

/** Additive operational tables; the Core Event schema is unchanged. */
function lifecycleIndexStatements(
  tables: OperationCatalogTables,
): readonly string[] {
  return [
    `CREATE INDEX IF NOT EXISTS "copilotz_operations_parent_idx"
     ON ${tables.operations} (namespace, parent_operation_id) WHERE parent_operation_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operations_live_idx"
     ON ${tables.operations} (updated_at, operation_id) WHERE state IN ('accepted','running')`,
    `CREATE INDEX IF NOT EXISTS "copilotz_operation_streams_action_scope_idx"
     ON ${tables.operationStreams} (namespace, operation_id, ((descriptor -> 'metadata' ->> 'sourceActionScopeId')))
     WHERE (descriptor -> 'metadata' ->> 'sourceActionScopeId') IS NOT NULL`,
  ];
}

export async function provisionOperationCatalog(
  session: SqlSession,
  databaseSchema = "public",
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = createOperationCatalogTables(schema);
  await createSchemaCommandRunner(session, schema)(
    "schema.catalog",
    {},
    async (_input, { transaction }) => {
      const existing = await transaction.query<{ table_name: string | null }>(
        "SELECT to_regclass($1) AS table_name",
        [tables.metadata],
      );
      if (existing.rows[0]?.table_name) {
        const marker = await transaction.query<{ fingerprint: string }>(
          `SELECT fingerprint FROM ${tables.metadata} WHERE singleton = TRUE`,
        );
        if (marker.rows[0]?.fingerprint !== OPERATION_CATALOG_FINGERPRINT) {
          throw operationCatalogError(
            schema,
            "requires an explicit offline upgrade with upgradeOperationCatalog",
            "copilotz_operation_catalog_schema_unsupported",
          );
        }
      }
      await transaction.query(`CREATE TABLE IF NOT EXISTS ${tables.metadata} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      fingerprint TEXT NOT NULL CHECK (fingerprint = '${OPERATION_CATALOG_FINGERPRINT}')
    )`);
      await transaction.query(`CREATE TABLE IF NOT EXISTS ${tables.operations} (
      operation_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      root_event_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
      correlation_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      next_stream_ordinal BIGINT NOT NULL DEFAULT 1,
      next_event_ordinal BIGINT NOT NULL DEFAULT 1,
      observation_keys TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      state TEXT NOT NULL CHECK (state IN ('accepted','running','completed','failed','cancelled')),
      accepted_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      parent_operation_id TEXT,
      parent_action_run_id TEXT,
      cancellation_requested_at TIMESTAMPTZ,
      cancellation_reason TEXT
    )`);
      await transaction.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operations_public_root_idx"
       ON ${tables.operations} (root_event_id) WHERE visibility = 'public'`,
      );
      await transaction.query(
        `CREATE INDEX IF NOT EXISTS "copilotz_operations_namespace_updated_idx"
      ON ${tables.operations} (namespace, updated_at, operation_id)`,
      );
      await transaction.query(
        `CREATE INDEX IF NOT EXISTS "copilotz_operations_metadata_idx"
      ON ${tables.operations} USING GIN (metadata jsonb_path_ops)`,
      );
      await transaction.query(
        `CREATE TABLE IF NOT EXISTS ${tables.operationEvents} (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_position BIGINT NOT NULL,
      event_ordinal BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (namespace, operation_id, event_id)
    )`,
      );
      await transaction.query(
        `CREATE INDEX IF NOT EXISTS "copilotz_operation_events_position_idx"
      ON ${tables.operationEvents} (namespace, operation_id, event_position)`,
      );
      await provisionSelectionTables(transaction, tables);
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
        CHECK (outcome IN ('completed','failed','cancelled')),
      availability TEXT NOT NULL DEFAULT 'retained'
        CONSTRAINT copilotz_operation_streams_availability_check
        CHECK (availability IN ('retained','purged')),
      reason TEXT,
      availability_reason TEXT,
      cleanup_state TEXT CONSTRAINT copilotz_operation_streams_cleanup_check
        CHECK (cleanup_state = 'pending'),
      asset_id TEXT,
      asset_retention TEXT CHECK (asset_retention IN ('canonical','observation')),
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (namespace, operation_id, stream_id),
      UNIQUE (namespace, stream_id),
      UNIQUE (namespace, operation_id, stream_ordinal),
      CONSTRAINT copilotz_operation_streams_terminal_check CHECK (${STREAM_TERMINAL_CHECK})
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
      for (const statement of lifecycleIndexStatements(tables)) {
        await transaction.query(statement);
      }
      await transaction.query(
        `INSERT INTO ${tables.metadata} (singleton, fingerprint) VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO NOTHING`,
        [OPERATION_CATALOG_FINGERPRINT],
      );
    },
  );
  return tables;
}

export type OperationCatalogBackfillInput = Readonly<{
  namespace: string;
  operationId: string;
  eventId: string;
  operationMetadata: Readonly<Record<string, unknown>>;
  metadata: Readonly<Record<string, unknown>>;
}>;

/**
 * Explicit offline upgrade: stop application writers before calling this.
 * The transaction takes exclusive table locks and backfills committed events.
 * The resolver owns domain interpretation; the runtime only stores opaque keys.
 */
export async function upgradeOperationCatalog(
  session: SqlSession,
  databaseSchema = "public",
  options: Readonly<{
    resolveObservationKeys?: (
      input: OperationCatalogBackfillInput,
    ) => readonly string[] | Promise<readonly string[]>;
    /** Only these top-level metadata branches are passed to the resolver. */
    backfillMetadataKeys?: readonly string[];
  }> = {},
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = createOperationCatalogTables(schema);
  if (
    options.backfillMetadataKeys !== undefined &&
    !Array.isArray(options.backfillMetadataKeys)
  ) {
    throw new TypeError("Catalog backfill metadata keys must be an array.");
  }
  const metadataKeys = options.backfillMetadataKeys === undefined
    ? undefined
    : [
      ...new Set(
        options.backfillMetadataKeys.map((key) =>
          requiredText(key, "Catalog backfill metadata key")
        ),
      ),
    ];
  const projectMetadata = (alias: string, keysParameter: string) =>
    metadataKeys === undefined
      ? `${alias}.metadata`
      : `COALESCE((SELECT jsonb_object_agg(key, ${alias}.metadata -> key)
        FROM unnest(${keysParameter}::text[]) AS key WHERE ${alias}.metadata ? key), '{}'::jsonb)`;
  await runSqlTransaction(session, async (transaction) => {
    await transaction.query(
      `LOCK TABLE ${tables.metadata}, ${tables.operations}, ${tables.operationEvents}, ${tables.operationStreams}, ${tables.events} IN ACCESS EXCLUSIVE MODE`,
    );
    const marker = await transaction.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ${tables.metadata} WHERE singleton = TRUE`,
    );
    if (marker.rows[0]?.fingerprint === OPERATION_CATALOG_FINGERPRINT) return;
    if (
      ![
        "retained-terminal-streams",
        "indexed-observation-ordinals-v1",
        "action-obligations-v1",
        "stream-taxonomy-continuations-v1",
        "stream-taxonomy-content-v1",
      ]
        .includes(marker.rows[0]?.fingerprint ?? "")
    ) {
      throw operationCatalogError(
        schema,
        "has an unsupported schema fingerprint",
        "copilotz_operation_catalog_schema_unsupported",
      );
    }
    if (marker.rows[0]?.fingerprint === "retained-terminal-streams") {
      await transaction.query(`ALTER TABLE ${tables.operations}
      ADD COLUMN next_event_ordinal BIGINT NOT NULL DEFAULT 1,
      ADD COLUMN observation_keys TEXT[] NOT NULL DEFAULT ARRAY[]::text[]`);
      await transaction.query(
        `ALTER TABLE ${tables.operationEvents} ADD COLUMN event_ordinal BIGINT`,
      );
      await transaction.query(`WITH numbered AS (
      SELECT event_id, row_number() OVER (PARTITION BY namespace, operation_id ORDER BY event_position, event_id) AS ordinal
      FROM ${tables.operationEvents}
    ) UPDATE ${tables.operationEvents} AS event SET event_ordinal = numbered.ordinal
      FROM numbered WHERE event.event_id = numbered.event_id`);
      await transaction.query(
        `ALTER TABLE ${tables.operationEvents} ALTER COLUMN event_ordinal SET NOT NULL`,
      );
      await transaction.query(
        `UPDATE ${tables.operations} AS operation SET next_event_ordinal = 1 + COALESCE((
      SELECT max(event_ordinal) FROM ${tables.operationEvents} AS event
      WHERE event.namespace = operation.namespace AND event.operation_id = operation.operation_id
    ), 0)`,
      );
      await provisionSelectionTables(transaction, tables);
      const resolve = options.resolveObservationKeys ??
        ((input: OperationCatalogBackfillInput) =>
          observationKeys(input.metadata));
      // Temporary bindings are transaction-local and disappear on commit or rollback.
      // Metadata payloads are never copied into a second permanent event table.
      const staging = 'pg_temp."copilotz_catalog_backfill_bindings"';
      await transaction.query(
        `CREATE TEMP TABLE "copilotz_catalog_backfill_bindings" (
      namespace TEXT NOT NULL, selection_key TEXT NOT NULL, operation_id TEXT NOT NULL,
      PRIMARY KEY (namespace, selection_key, operation_id)
    ) ON COMMIT DROP`,
      );
      let afterOperationId = "";
      while (true) {
        const operations = await transaction.query<
          Pick<
            OperationRow,
            "operation_id" | "namespace" | "root_event_id" | "metadata"
          >
        >(
          `SELECT operation.operation_id, operation.namespace, operation.root_event_id,
           ${
            projectMetadata("operation", "$2")
          } AS metadata FROM ${tables.operations} AS operation
         WHERE operation.operation_id > $1 ORDER BY operation.operation_id LIMIT 500`,
          metadataKeys === undefined
            ? [afterOperationId]
            : [afterOperationId, metadataKeys],
        );
        if (!operations.rows.length) break;
        const batch = new Map(
          operations.rows.map((operation) => [operation.operation_id, {
            operation,
            metadata: snapshotStreamMetadata(operation.metadata),
            keys: new Set<string>(),
          }]),
        );
        const addKeys = async (
          operationId: string,
          eventId: string,
          metadata: Readonly<Record<string, unknown>>,
        ) => {
          const entry = batch.get(operationId)!;
          const resolved = await resolve({
            namespace: entry.operation.namespace,
            operationId,
            eventId,
            metadata,
            operationMetadata: entry.metadata,
          });
          for (const key of observationKeys({ observationKeys: resolved })) {
            entry.keys.add(key);
          }
        };
        for (const entry of batch.values()) {
          await addKeys(
            entry.operation.operation_id,
            entry.operation.root_event_id,
            entry.metadata,
          );
        }
        let afterEventPosition = "0";
        let afterEventId = "";
        while (true) {
          const events = await transaction.query<{
            operation_id: string;
            event_id: string;
            event_position: string;
            metadata: unknown;
          }>(
            `SELECT indexed.operation_id, indexed.event_id, indexed.event_position,
            ${projectMetadata("event", "$4")} AS metadata
          FROM ${tables.operationEvents} AS indexed
          JOIN ${tables.events} AS event ON event.id = indexed.event_id AND event.namespace = indexed.namespace
          WHERE indexed.operation_id = ANY($1::text[])
            AND (indexed.event_position, indexed.event_id) > ($2::bigint, $3::text)
          ORDER BY indexed.event_position, indexed.event_id LIMIT 1000`,
            metadataKeys === undefined
              ? [[...batch.keys()], afterEventPosition, afterEventId]
              : [
                [...batch.keys()],
                afterEventPosition,
                afterEventId,
                metadataKeys,
              ],
          );
          for (const event of events.rows) {
            await addKeys(
              event.operation_id,
              event.event_id,
              snapshotStreamMetadata(event.metadata),
            );
          }
          if (events.rows.length < 1000) break;
          afterEventPosition = String(events.rows.at(-1)!.event_position);
          afterEventId = events.rows.at(-1)!.event_id;
        }
        const resolved = [...batch.values()].map((entry) => ({
          namespace: entry.operation.namespace,
          operation_id: entry.operation.operation_id,
          observation_keys: [...entry.keys].sort(),
        }));
        await transaction.query(
          `UPDATE ${tables.operations} AS operation
        SET observation_keys = resolved.observation_keys
        FROM jsonb_to_recordset($1::jsonb) AS resolved(namespace TEXT, operation_id TEXT, observation_keys TEXT[])
        WHERE operation.namespace = resolved.namespace AND operation.operation_id = resolved.operation_id`,
          [JSON.stringify(resolved)],
        );
        await transaction.query(
          `INSERT INTO ${staging} (namespace, selection_key, operation_id)
        SELECT resolved.namespace, key, resolved.operation_id
        FROM jsonb_to_recordset($1::jsonb) AS resolved(namespace TEXT, operation_id TEXT, observation_keys TEXT[]),
          LATERAL unnest(resolved.observation_keys) AS key`,
          [JSON.stringify(resolved)],
        );
        afterOperationId = operations.rows.at(-1)!.operation_id;
      }
      await transaction.query(`WITH heads AS (
      INSERT INTO ${tables.selectionHeads} AS head (namespace, selection_key, change_ordinal)
      SELECT namespace, selection_key, count(*) FROM ${staging}
      GROUP BY namespace, selection_key ORDER BY namespace, selection_key
      ON CONFLICT (namespace, selection_key) DO UPDATE
        SET change_ordinal = head.change_ordinal + EXCLUDED.change_ordinal
      RETURNING namespace, selection_key, change_ordinal
    ), numbered AS (
      SELECT namespace, selection_key, operation_id,
        row_number() OVER (PARTITION BY namespace, selection_key ORDER BY operation_id) AS ordinal,
        count(*) OVER (PARTITION BY namespace, selection_key) AS allocation_count
      FROM ${staging}
    ) INSERT INTO ${tables.selectionOperations} (namespace, selection_key, operation_id, change_ordinal)
      SELECT numbered.namespace, numbered.selection_key, numbered.operation_id,
        heads.change_ordinal - numbered.allocation_count + numbered.ordinal
      FROM numbered JOIN heads USING (namespace, selection_key)
      ON CONFLICT (namespace, selection_key, operation_id) DO UPDATE SET change_ordinal = EXCLUDED.change_ordinal`);
    }
    await transaction.query(`ALTER TABLE ${tables.operations}
      ADD COLUMN IF NOT EXISTS parent_operation_id TEXT,
      ADD COLUMN IF NOT EXISTS parent_action_run_id TEXT,
      ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
      DROP CONSTRAINT IF EXISTS copilotz_operations_root_event_id_key`);
    await transaction.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "copilotz_operations_public_root_idx"
      ON ${tables.operations} (root_event_id) WHERE visibility = 'public'`,
    );
    for (const statement of lifecycleIndexStatements(tables)) {
      await transaction.query(statement);
    }
    await transaction.query(`ALTER TABLE ${tables.operationStreams}
      DROP CONSTRAINT IF EXISTS copilotz_operation_streams_terminal_check,
      DROP CONSTRAINT IF EXISTS copilotz_operation_streams_outcome_check,
      DROP CONSTRAINT IF EXISTS copilotz_operation_streams_availability_check,
      DROP CONSTRAINT IF EXISTS copilotz_operation_streams_capture_check,
      ADD COLUMN IF NOT EXISTS reason TEXT,
      ADD COLUMN IF NOT EXISTS availability_reason TEXT,
      ADD COLUMN IF NOT EXISTS cleanup_state TEXT`);
    // The old variants encode causes, not additional logical outcomes.
    await transaction.query(`UPDATE ${tables.operationStreams} SET
      reason = CASE outcome WHEN 'superseded' THEN 'superseded'
        WHEN 'abandoned' THEN 'abandoned' ELSE reason END,
      outcome = CASE outcome WHEN 'superseded' THEN 'cancelled'
        WHEN 'abandoned' THEN 'failed' ELSE outcome END,
      cleanup_state = CASE WHEN availability = 'purge_pending' THEN 'pending'
        ELSE cleanup_state END,
      availability_reason = CASE availability WHEN 'missing' THEN 'missing'
        WHEN 'purged' THEN COALESCE(availability_reason, 'deleted') ELSE NULL END,
      availability = CASE availability WHEN 'purge_pending' THEN 'retained'
        WHEN 'missing' THEN 'purged' ELSE availability END`);
    // Unavailable historical lanes retain logical terminal metadata without inventing bytes.
    await transaction.query(
      `INSERT INTO ${createCoreTableNames(schema).content_logical_bodies}
      (body_id,namespace,current_copy,writer_id,generation,revocation,protected_until,committed_offset,terminal)
      SELECT body_id,namespace,body_id,'offline-migration',1,'revoked',NOW(),committed_offset,
        jsonb_strip_nulls(jsonb_build_object('length',committed_offset,'outcome',outcome,
          'reason',reason,'digest',CASE WHEN outcome='completed' THEN digest END))
      FROM ${tables.operationStreams} WHERE availability='purged' AND state='terminal'
      ON CONFLICT(body_id) DO NOTHING`,
    );
    const missingAuthority = await transaction.query(
      `SELECT 1 FROM ${tables.operationStreams} s WHERE NOT EXISTS (
        SELECT 1 FROM ${createCoreTableNames(schema).content_logical_bodies} b
        WHERE b.body_id=s.body_id AND b.namespace=s.namespace AND b.committed_offset=s.committed_offset
          AND (s.state<>'terminal' OR (b.terminal->>'outcome'=s.outcome
            AND (b.terminal->>'length')::bigint=s.committed_offset
            AND (s.outcome<>'completed' OR b.terminal->>'digest'=s.digest)))
      ) LIMIT 1`,
    );
    if (missingAuthority.rows.length) {
      throw new Error(
        "Migrate stream content into the logical catalog before dropping its old projection.",
      );
    }
    await transaction.query(`ALTER TABLE ${tables.operationStreams}
      DROP COLUMN IF EXISTS capture,
      DROP COLUMN IF EXISTS committed_offset,
      DROP COLUMN IF EXISTS digest,
      DROP CONSTRAINT IF EXISTS copilotz_operation_streams_cleanup_check,
      ADD CONSTRAINT copilotz_operation_streams_outcome_check
        CHECK (outcome IN ('completed','failed','cancelled')),
      ADD CONSTRAINT copilotz_operation_streams_availability_check
        CHECK (availability IN ('retained','purged')),
      ADD CONSTRAINT copilotz_operation_streams_cleanup_check CHECK (cleanup_state = 'pending'),
      ADD CONSTRAINT copilotz_operation_streams_terminal_check CHECK (${STREAM_TERMINAL_CHECK})`);
    await transaction.query(
      `ALTER TABLE ${tables.metadata} DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`,
    );
    await transaction.query(
      `UPDATE ${tables.metadata} SET fingerprint = $1 WHERE singleton = TRUE`,
      [OPERATION_CATALOG_FINGERPRINT],
    );
    await transaction.query(
      `ALTER TABLE ${tables.metadata} ADD CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check CHECK (fingerprint = '${OPERATION_CATALOG_FINGERPRINT}')`,
    );
  });
  return await validateOperationCatalog(session, schema);
}

/** Read-only validation used while selecting an already provisioned scope. */
export async function validateOperationCatalog(
  session: SqlSession,
  databaseSchema = "public",
): Promise<OperationCatalogTables> {
  const schema = validateEventSchemaName(databaseSchema);
  const tables = createOperationCatalogTables(schema);
  const required = [
    ["metadata", tables.metadata],
    ["operations", tables.operations],
    ["operation events", tables.operationEvents],
    ["operation streams", tables.operationStreams],
    ["selection heads", tables.selectionHeads],
    ["selection operations", tables.selectionOperations],
  ] as const;
  const registered = await session.query<
    { name: string; table_name: string | null }
  >(
    "SELECT name, to_regclass(name)::text AS table_name FROM unnest($1::text[]) AS name",
    [required.map(([, table]) => table)],
  );
  const presentTables = new Set(
    registered.rows.filter((row) => row.table_name).map((row) => row.name),
  );
  for (const [label, table] of required) {
    if (!presentTables.has(table)) {
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
          (table_name = 'copilotz_operations' AND column_name IN ('next_stream_ordinal', 'next_event_ordinal', 'observation_keys', 'cancellation_requested_at', 'cancellation_reason', 'visibility', 'parent_operation_id', 'parent_action_run_id'))
          OR (table_name = 'copilotz_operation_events' AND column_name = 'event_ordinal')
          OR
          (table_name = 'copilotz_operation_streams'
            AND column_name IN (
              'replay_key','stream_ordinal','semantic_stream_id','outcome',
              'availability','reason','availability_reason','cleanup_state','terminal_at'
            ))
        )`,
    [schema],
  );
  const present = new Set(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  if (
    !present.has("copilotz_operations.next_stream_ordinal") ||
    !present.has("copilotz_operations.next_event_ordinal") ||
    !present.has("copilotz_operations.observation_keys") ||
    !present.has("copilotz_operations.cancellation_requested_at") ||
    !present.has("copilotz_operations.visibility") ||
    !present.has("copilotz_operations.parent_operation_id") ||
    !present.has("copilotz_operations.parent_action_run_id") ||
    !present.has("copilotz_operations.cancellation_reason") ||
    !present.has("copilotz_operation_events.event_ordinal") ||
    !present.has("copilotz_operation_streams.replay_key") ||
    !present.has("copilotz_operation_streams.stream_ordinal") ||
    !present.has("copilotz_operation_streams.semantic_stream_id") ||
    !present.has("copilotz_operation_streams.outcome") ||
    !present.has("copilotz_operation_streams.availability") ||
    !present.has("copilotz_operation_streams.reason") ||
    !present.has("copilotz_operation_streams.availability_reason") ||
    !present.has("copilotz_operation_streams.cleanup_state") ||
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
    /** Commit notification only: the caller must not wait on the current writer. */
    onStreamTerminal?: (
      operation: Readonly<{ namespace: string; operationId: string }>,
    ) => void;
    onSettled?(
      transaction: SqlExecutor,
      input: { namespace: string; operationId: string },
    ): Promise<() => Promise<void>>;
    /** Drains request-local/remote relay frames before a zero-settlement terminal inference. */
    beforeTerminal?: (
      operation: Readonly<{ namespace: string; operationId: string }>,
    ) => Promise<void>;
  }> = {},
): OperationCatalog {
  const runCommand = createSchemaCommandRunner(session, databaseSchema);
  const tables = createOperationCatalogTables(databaseSchema);
  // CTEs that index one event. A root event creates its operation in the same
  // statement, which the other CTEs' snapshot cannot see, so "the operation
  // exists" also accepts the row created here. Detached deliveries get an
  // internal operation: identical lifecycle rules, independent completion,
  // and no membership in public observation selections.
  const indexEventCtes = (
    input: Omit<OperationEventIndexInput, "position">,
    param: (value: unknown) => string,
    event: Readonly<
      { position: string; requires?: string; deliveries?: string }
    >,
  ): string => {
    const namespace = param(
      requiredText(input.namespace, "Operation namespace"),
    );
    const operationId = requiredText(input.operationId, "Operation id");
    const eventId = requiredText(input.eventId, "Operation event id");
    const root = operationId === eventId;
    const operation = param(operationId);
    const eventRef = param(eventId);
    const createdAt = `${param(input.createdAt)}::timestamptz`;
    const keys = `${param(observationKeys(input.metadata ?? {}))}::text[]`;
    const requirements = event.requires ? ` AND ${event.requires}` : "";
    const created = root
      ? `created_operation AS (
           INSERT INTO ${tables.operations} (
             operation_id, namespace, root_event_id, correlation_id, metadata,
             observation_keys, next_event_ordinal, state, accepted_at, updated_at
           ) SELECT ${operation},${namespace},${eventRef},${
        param(input.correlationId)
      },
             ${
        param(JSON.stringify(snapshotStreamMetadata(input.metadata ?? {})))
      }::jsonb,
             ${keys},2,'accepted',${createdAt},${createdAt}
             ${event.requires ? `WHERE ${event.requires}` : ""}
           ON CONFLICT (operation_id) DO NOTHING
           RETURNING operation_id, visibility, observation_keys, 1::bigint AS event_ordinal
         ), `
      : "";
    // UPDATE locks the current operation tuple before allocating a local ordinal.
    // PostgreSQL re-evaluates its SET expressions against a concurrent updater's
    // committed tuple, including newly associated observation keys.
    const internal = event.deliveries
      ? `created_internal_operations AS (
      INSERT INTO ${tables.operations} (
        operation_id, namespace, root_event_id, correlation_id, metadata,
        observation_keys, visibility, next_event_ordinal, state, accepted_at, updated_at,
        completed_at, cancellation_requested_at
      ) SELECT delivery.settlement_scope_id, ${namespace}, ${eventRef}, ${
        param(input.correlationId)
      }, '{}'::jsonb,
        ARRAY[]::text[], 'internal', 1,
        CASE WHEN delivery.status = 'cancelled' THEN 'cancelled' ELSE 'accepted' END,
        ${createdAt}, ${createdAt},
        CASE WHEN delivery.status = 'cancelled' THEN ${createdAt} ELSE NULL END,
        CASE WHEN delivery.status = 'cancelled' THEN ${createdAt} ELSE NULL END
      FROM ${event.deliveries} AS delivery WHERE delivery.settlement_scope_id <> ${operation}
      ON CONFLICT (operation_id) DO NOTHING
    ), `
      : "";
    return `${internal}${created}existing_operation AS (
        UPDATE ${tables.operations} AS operation
           SET next_event_ordinal = next_event_ordinal + 1,
               observation_keys = CASE WHEN visibility = 'internal' THEN ARRAY[]::text[] ELSE ARRAY(SELECT DISTINCT key FROM unnest(operation.observation_keys || ${keys}) AS key ORDER BY key) END,
               state = CASE WHEN state = 'accepted' AND ${
      param(!root)
    }::boolean THEN 'running' ELSE state END,
               updated_at = GREATEST(updated_at, ${createdAt})
         WHERE namespace = ${namespace} AND operation_id = ${operation}
           AND NOT EXISTS (SELECT 1 FROM ${tables.operationEvents} WHERE event_id = ${eventRef})
           ${root ? "AND NOT EXISTS (SELECT 1 FROM created_operation)" : ""}
           ${requirements}
         RETURNING operation_id, visibility, observation_keys, next_event_ordinal - 1 AS event_ordinal
      ), allocated_operation AS (
        SELECT * FROM existing_operation ${
      root ? "UNION ALL SELECT * FROM created_operation" : ""
    }
      ), indexed_event AS (
         INSERT INTO ${tables.operationEvents} (
           namespace, operation_id, event_id, event_position, event_ordinal, created_at
         ) SELECT ${namespace},${operation},${eventRef},${event.position},event_ordinal,${createdAt}
           FROM allocated_operation
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id
      ), changed_selection_heads AS (
        INSERT INTO ${tables.selectionHeads} AS head (namespace, selection_key, change_ordinal)
        SELECT ${namespace}, key, 1 FROM allocated_operation,
          LATERAL unnest(observation_keys) AS key
        WHERE EXISTS (SELECT 1 FROM indexed_event)
        ORDER BY key
        ON CONFLICT (namespace, selection_key) DO UPDATE
          SET change_ordinal = head.change_ordinal + 1
        RETURNING namespace, selection_key, change_ordinal
      ), updated_selections AS (
        INSERT INTO ${tables.selectionOperations} (namespace, selection_key, operation_id, change_ordinal)
        SELECT namespace, selection_key, ${operation}, change_ordinal FROM changed_selection_heads
        ON CONFLICT (namespace, selection_key, operation_id) DO UPDATE
          SET change_ordinal = EXCLUDED.change_ordinal
        RETURNING selection_key
      )`;
  };
  let pushSnapshot:
    | (() => Readonly<
      {
        headSeq: string;
        positions: readonly import("../events/push.ts").OwnerPushPosition[];
      }
    >)
    | undefined;
  async function publishStreamTerminal(
    input: StreamCoordinates & { bodyId: string; terminal: ContentTerminal },
    { transaction, commandTime }: CommandContext,
  ): Promise<boolean> {
    const result = await transaction.query(
      `UPDATE ${tables.operationStreams}
       SET state='terminal',outcome=$4,reason=$5,availability='retained',
         asset_id=CASE WHEN state='terminal' THEN asset_id END,
         asset_retention=CASE WHEN state='terminal' THEN asset_retention ELSE 'observation' END,
         terminal_at=COALESCE(terminal_at,$7::timestamptz),updated_at=$7::timestamptz
       WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3 AND body_id=$6
         AND availability='retained' AND cleanup_state IS NULL
         AND (state='open' OR (state='terminating' AND ($4<>'completed' OR outcome='completed'))
           OR (state='terminal' AND outcome=$4)) RETURNING stream_id`,
      [
        input.namespace,
        input.operationId,
        input.streamId,
        input.terminal.outcome,
        input.terminal.reason ?? null,
        input.bodyId,
        commandTime,
      ],
    );
    if (!result.rows.length) return false;
    await publishOperationChange(
      session,
      transaction,
      databaseSchema,
      input.namespace,
      input.operationId,
      { kind: "stream", streamId: input.streamId },
    );
    if (options.onStreamTerminal) {
      await writeOwnerDeadline(transaction, databaseSchema, {
        source: "reconciliation",
        key: reconciliationAlarmKey("schema", {
          kind: "operation",
          namespace: input.namespace,
          id: input.operationId,
        }),
        namespace: input.namespace,
        dueAt: commandTime,
        payload: { operationId: input.operationId },
      });
    }
    afterSqlCommit(transaction, () => options.onStreamTerminal?.(input));
    return true;
  }

  async function requireStreamMembership(
    transaction: SqlExecutor,
    input: StreamCoordinates & { content: { bodyId: string } },
    transition: "checkpoint" | "seal" | "failure",
  ) {
    const row = (await transaction.query<{
      body_id: string;
      state: string;
      outcome: StreamTerminalOutcome | null;
      reason: string | null;
      availability: string;
      cleanup_state: string | null;
    }>(
      `SELECT body_id,state,outcome,reason,availability,cleanup_state
      FROM ${tables.operationStreams} AS stream
      WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3
        AND EXISTS (SELECT 1 FROM ${
        createCoreTableNames(databaseSchema).content_logical_bodies
      } AS body
          WHERE body.body_id=stream.body_id AND body.namespace=stream.namespace)`,
      [input.namespace, input.operationId, input.streamId],
    )).rows[0];
    const admissible = row?.state === "open" || transition !== "checkpoint" && (
          transition === "seal"
            ? (row?.state === "terminating" || row?.state === "terminal") &&
              row.outcome === "completed"
            : row?.state === "terminating" ||
              row?.state === "terminal" && row.outcome !== "completed"
        );
    if (
      !row || row.body_id !== input.content.bodyId || !admissible ||
      row.availability !== "retained" || row.cleanup_state !== null
    ) {
      throw new ContentStreamOwnershipLostError(input.streamId);
    }
    return row;
  }

  const streamSelection =
    `SELECT stream.*, COALESCE(body.committed_offset,0) AS committed_offset,
    body.terminal->>'digest' AS digest
    FROM ${tables.operationStreams} stream LEFT JOIN ${
      createCoreTableNames(databaseSchema).content_logical_bodies
    } body
      ON body.body_id=stream.body_id AND body.namespace=stream.namespace`;
  const reconciliations = new Map<string, Promise<number>>();
  const catalog: OperationCatalog = {
    pushState(input) {
      const snapshot = pushSnapshot?.();
      return {
        headSeq: snapshot?.headSeq ?? "0",
        payloadPositions: (snapshot?.positions ?? []).filter((position) =>
          position.namespace === input.namespace &&
          input.operationIds.includes(position.operationId) &&
          (!input.streamIds || input.streamIds.includes(position.streamId))
        ).map(({ streamId, committedOffset }) => ({
          streamId,
          committedOffset,
        })),
      };
    },
    databaseSchema: validateEventSchemaName(databaseSchema),
    async onChange(listener, options = {}) {
      if (typeof listener !== "function") {
        throw new TypeError("Operation change listener must be a function.");
      }
      const namespace = options.namespace === undefined
        ? undefined
        : requiredText(options.namespace, "Operation namespace");
      const subscription = await attachOwnerPush(
        session,
        databaseSchema,
        (frame) => {
          if (frame.kind === "change") {
            const change = frame.change;
            if (namespace === undefined || namespace === change.namespace) {
              listener(change.operationId, {
                ...change,
                headSeq: frame.headSeq,
              });
            } else {listener("", {
                namespace: namespace ?? "",
                selectionKeys: [],
                kind: "checkpoint",
                headSeq: frame.headSeq,
              });}
          } else {listener("", {
              namespace: namespace ?? "",
              selectionKeys: [],
              kind: frame.kind,
              headSeq: frame.headSeq,
              ...(frame.kind === "heartbeat"
                ? { positions: frame.positions }
                : frame.kind === "reset"
                ? { reason: frame.reason }
                : {}),
            });}
        },
        { namespace },
      );
      pushSnapshot = subscription.snapshot;
      try {
        listener("", {
          namespace: namespace ?? "",
          selectionKeys: [],
          kind: "checkpoint",
          headSeq: subscription.cursor,
        });
      } catch (error) {
        subscription.close();
        throw error;
      }
      return subscription.close;
    },
    async watch(operationIdInput, options = {}) {
      const operationId = requiredText(operationIdInput, "Operation id");
      const kind = options.kind;
      if (
        kind !== undefined &&
        !["event", "operation", "stream", "stream-offset", "retirement"]
          .includes(kind)
      ) {
        throw new TypeError("Unknown operation watch hint kind.");
      }
      const namespace = options.namespace === undefined
        ? undefined
        : requiredText(options.namespace, "Operation namespace");
      let pending = 0;
      let closed = false;
      let resolveWaiting: ((notified: boolean) => void) | undefined;
      const listener: OperationChangeListener = (
        changedOperationId,
        detail,
      ) => {
        if (
          closed || changedOperationId !== operationId ||
          (namespace !== undefined && namespace !== detail.namespace) ||
          (kind !== undefined && detail.kind !== undefined &&
            kind !== detail.kind)
        ) return;
        pending = 1;
        resolveWaiting?.(true);
      };
      const remove = await catalog.onChange((id, detail) => {
        const repair = detail.kind === "reset" || detail.kind === "heartbeat";
        if (repair) {
          pending = 1;
          resolveWaiting?.(true);
        } else listener(id, detail);
      }, { namespace });
      return ({
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
          remove();
          resolveWaiting?.(false);
          resolveWaiting = undefined;
        },
      } as const);
    },
    admitEventSql(input, param) {
      const namespace = param(
        requiredText(input.namespace, "Operation namespace"),
      );
      const operation = param(requiredText(input.operationId, "Operation id"));
      const target = `namespace = ${namespace} AND operation_id = ${operation}`;
      return {
        ctes: [`admitted_operation AS MATERIALIZED (
          SELECT operation_id, cancellation_requested_at FROM ${tables.operations}
          WHERE ${target} AND state IN ('accepted','running')
            AND (cancellation_requested_at IS NULL OR ${
          input.cancellationTerminal === true ? "TRUE" : "FALSE"
        })
        )`],
        // Ordinary direct mutations may start outside an operation. A
        // deferred handoff requires a managed scope, including internal ones.
        cancelled:
          "EXISTS (SELECT 1 FROM admitted_operation WHERE cancellation_requested_at IS NOT NULL)",
        gate: `(${
          input.requireScope !== true
            ? `NOT EXISTS (SELECT 1 FROM ${tables.operations} WHERE ${target}) OR `
            : ""
        }EXISTS (SELECT 1 FROM admitted_operation))`,
      };
    },
    async indexEvent(transaction, input) {
      assertSchemaCommandTransaction(transaction, databaseSchema);
      if (!/^(0|[1-9][0-9]*)$/.test(input.position)) {
        throw new TypeError("Operation event position is invalid.");
      }
      const params: unknown[] = [];
      const param = (value: unknown) => `$${params.push(value)}`;
      const ctes = indexEventCtes(input, param, {
        position: `${param(input.position)}::bigint`,
      });
      const indexed = await transaction.query(
        `WITH ${ctes} SELECT * FROM indexed_event`,
        params,
      );
      if (indexed.rows.length) {
        await publishOperationChange(
          session,
          transaction,
          databaseSchema,
          input.namespace,
          input.operationId,
          { kind: "event" },
        );
      }
    },
    indexEventSql(input, param) {
      return indexEventCtes(input, param, {
        position: "(SELECT position FROM inserted_event)",
        requires: "EXISTS (SELECT 1 FROM inserted_event)",
        deliveries: "inserted_deliveries",
      });
    },
    async getSelectionHeads(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      if (!Array.isArray(input.selectionKeys)) {
        throw new TypeError("Selection keys must be an array.");
      }
      const keys = [
        ...new Set(
          input.selectionKeys.map((key) =>
            requiredText(key, "Observation key")
          ),
        ),
      ];
      if (!keys.length) return [];
      const result = await session.query<
        { selection_key: string; change_ordinal: string | bigint }
      >(
        `SELECT selection_key, change_ordinal FROM ${tables.selectionHeads}
          WHERE namespace = $1 AND selection_key = ANY($2::text[])`,
        [namespace, keys],
      );
      return result.rows.map((row) => ({
        selectionKey: row.selection_key,
        changeOrdinal: String(row.change_ordinal),
      }));
    },
    async listSelectionChanges(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const key = requiredText(input.selectionKey, "Observation key");
      const params: unknown[] = [namespace, key];
      const conditions = [
        "association.namespace = $1",
        "association.selection_key = $2",
      ];
      if (input.afterChangeOrdinal !== undefined) {
        params.push(
          eventPosition(input.afterChangeOrdinal, "Selection change ordinal"),
        );
        conditions.push(
          `association.change_ordinal > $${params.length}::bigint`,
        );
      }
      if (input.operationIds !== undefined) {
        if (!Array.isArray(input.operationIds)) {
          throw new TypeError("Operation ids must be an array.");
        }
        const ids = [
          ...new Set(
            input.operationIds.map((id) => requiredText(id, "Operation id")),
          ),
        ];
        if (!ids.length) return [];
        params.push(ids);
        conditions.push(
          `association.operation_id = ANY($${params.length}::text[])`,
        );
      }
      if (input.states !== undefined) {
        if (!Array.isArray(input.states)) {
          throw new TypeError("Operation states must be an array.");
        }
        if (input.states.length) {
          params.push([...new Set(input.states.map(operationState))]);
          conditions.push(`operation.state = ANY($${params.length}::text[])`);
        }
      }
      params.push(boundedLimit(input.limit));
      const result = await session.query<
        OperationRow & {
          selection_key: string;
          change_ordinal: string | bigint;
        }
      >(
        `SELECT operation.*, association.selection_key, association.change_ordinal
          FROM ${tables.selectionOperations} AS association
          JOIN ${tables.operations} AS operation ON operation.namespace = association.namespace
            AND operation.operation_id = association.operation_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY association.change_ordinal, association.operation_id LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => ({
        ...mapOperation(row),
        selectionKey: row.selection_key,
        changeOrdinal: String(row.change_ordinal),
      }));
    },
    async listOperationEventIds(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const operationId = requiredText(input.operationId, "Operation id");
      const params: unknown[] = [namespace, operationId];
      const after = input.afterEventOrdinal === undefined
        ? undefined
        : eventPosition(input.afterEventOrdinal, "Operation event ordinal");
      const condition = after === undefined
        ? ""
        : ` AND event_ordinal > $${params.push(after)}::bigint`;
      params.push(boundedLimit(input.limit));
      const result = await session.query<
        { event_id: string; event_ordinal: string | bigint }
      >(
        `SELECT event_id, event_ordinal FROM ${tables.operationEvents}
          WHERE namespace = $1 AND operation_id = $2${condition}
          ORDER BY event_ordinal LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        eventOrdinal: String(row.event_ordinal),
      }));
    },
    async resultSequence(namespace, operationId) {
      const result = await session.query<{ seq: string | number }>(
        `SELECT COALESCE(MAX(seq),0) AS seq FROM ${
          createCoreTableNames(databaseSchema).events
        }
         WHERE namespace=$1 AND (id IN (SELECT event_id FROM ${tables.operationEvents} WHERE namespace=$1 AND operation_id=$2)
           OR (type='operation.catalog.changed' AND correlation_id=$2))`,
        [namespace, operationId],
      );
      return String(result.rows[0].seq);
    },
    async get(namespaceInput, operationIdInput, transaction) {
      const namespace = requiredText(namespaceInput, "Operation namespace");
      const operationId = requiredText(operationIdInput, "Operation id");
      const result = await (transaction ?? session).query<OperationRow>(
        `SELECT * FROM ${tables.operations}
          WHERE namespace = $1 AND operation_id = $2 LIMIT 1`,
        [namespace, operationId],
      );
      return result.rows[0] ? mapOperation(result.rows[0]) : null;
    },
    async list(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const limit = boundedLimit(input.limit);
      const conditions = [
        "operation.namespace = $1",
        "operation.visibility = 'public'",
      ];
      const params: unknown[] = [namespace];
      let operationIds: readonly string[] | undefined;
      if (input.operationIds !== undefined) {
        if (!Array.isArray(input.operationIds)) {
          throw new TypeError("Operation ids must be an array.");
        }
        operationIds = [
          ...new Set(
            input.operationIds.map((id) => requiredText(id, "Operation id")),
          ),
        ];
      }
      if (operationIds) {
        params.push([
          ...operationIds,
        ]);
        conditions.push(
          `operation.operation_id = ANY($${params.length}::text[])`,
        );
      }
      if (input.states !== undefined && !Array.isArray(input.states)) {
        throw new TypeError("Operation states must be an array.");
      }
      if (input.states?.length) {
        params.push([
          ...new Set(input.states.map((state) => operationState(state))),
        ]);
        conditions.push(`operation.state = ANY($${params.length}::text[])`);
      }
      if (input.metadata !== undefined) {
        const metadata = metadataObject(input.metadata, "Operation metadata");
        if (Object.keys(metadata).length) {
          params.push(JSON.stringify(metadata));
          conditions.push(`operation.metadata @> $${params.length}::jsonb`);
        }
      }
      const association = prepareAssociation(input.association);
      const afterPosition = input.afterPosition === undefined
        ? undefined
        : eventPosition(input.afterPosition);
      if (operationIds?.length === 0) return [];
      if (afterPosition !== undefined) {
        // Keep progress eligibility per operation; a hashed alternative can
        // scan the historical event index just to construct the candidate set.
        params.push(afterPosition);
        conditions.push(`(
          operation.state IN ('accepted','running')
          OR EXISTS (
            SELECT 1 FROM ${tables.operationEvents} AS progress
             WHERE progress.namespace = operation.namespace
               AND progress.operation_id = operation.operation_id
               AND progress.event_position > $${params.length}::bigint
             OFFSET 0
          )
        )`);
      }
      let query: string;
      if (association && afterPosition !== undefined && afterPosition !== "0") {
        const membership: string[] = [];
        const associated: string[] = [];
        let operationMetadataCondition: string | undefined;
        if (association.operationMetadata) {
          params.push(association.operationMetadata);
          operationMetadataCondition =
            `operation.metadata @> $${params.length}::jsonb`;
          membership.push(operationMetadataCondition);
          associated.push(`SELECT operation.namespace, operation.operation_id
            FROM candidate AS operation
            WHERE ${operationMetadataCondition}
              AND (SELECT broad FROM strategy)`);
        }
        if (association.eventMetadata) {
          params.push(association.eventMetadata);
          const eventMetadataCondition =
            `event.metadata @> $${params.length}::jsonb`;
          membership.push(`EXISTS (
            SELECT 1 FROM ${tables.operationEvents} AS indexed
            JOIN ${tables.events} AS event
              ON event.id = indexed.event_id
             AND event.namespace = indexed.namespace
            WHERE indexed.namespace = operation.namespace
              AND indexed.operation_id = operation.operation_id
              AND ${eventMetadataCondition}
            OFFSET 0
          )`);
          associated.push(`SELECT indexed.namespace, indexed.operation_id
            FROM candidate AS operation
            JOIN ${tables.operationEvents} AS indexed
              ON indexed.namespace = operation.namespace
             AND indexed.operation_id = operation.operation_id
            JOIN ${tables.events} AS event
              ON event.id = indexed.event_id
             AND event.namespace = indexed.namespace
            WHERE ${eventMetadataCondition}${
            operationMetadataCondition
              ? ` AND NOT (${operationMetadataCondition})`
              : ""
          }
              AND (SELECT broad FROM strategy)`);
        }
        // Eligibility always precedes membership. OFFSET 0 keeps the few-
        // candidate EXISTS probes correlated instead of hashing all history.
        const candidateQuery = `WITH candidate AS MATERIALIZED (
          SELECT operation.* FROM ${tables.operations} AS operation
          WHERE ${conditions.join(" AND ")}
        )`;
        if (association.eventMetadata) {
          // Old replay watermarks can leave most operations eligible. Cap
          // per-operation probes even for large pages, then use metadata-index
          // joins for broader candidates. Both paths share one snapshot; the
          // strategy gates the unused association path before its scans run.
          query = `${candidateQuery}, strategy AS MATERIALIZED (
            SELECT COUNT(*) > ${MAX_CORRELATED_ASSOCIATION_CANDIDATES} AS broad FROM candidate
          ), associated AS MATERIALIZED (
            ${associated.join("\n            UNION\n            ")}
          ) SELECT operation.* FROM candidate AS operation
            WHERE CASE WHEN (SELECT broad FROM strategy) THEN EXISTS (
              SELECT 1 FROM associated
              WHERE associated.namespace = operation.namespace
                AND associated.operation_id = operation.operation_id
            ) ELSE (${membership.join(" OR ")}) END`;
        } else {
          query =
            `${candidateQuery} SELECT operation.* FROM candidate AS operation
            WHERE (${membership.join(" OR ")})`;
        }
      } else {
        // Broad initial/replay lists benefit from metadata indexes across the
        // catalog instead of probing each eligible operation's event history.
        let associationQuery = "";
        if (association) {
          const branches: string[] = [];
          if (association.operationMetadata) {
            params.push(association.operationMetadata);
            branches.push(
              `SELECT operation.namespace, operation.operation_id
                 FROM ${tables.operations} AS operation
                WHERE operation.namespace = $1${
                operationIds
                  ? ` AND operation.operation_id = ANY($2::text[])`
                  : ""
              } AND operation.metadata @> $${params.length}::jsonb`,
            );
          }
          if (association.eventMetadata) {
            params.push(association.eventMetadata);
            const ids = operationIds
              ? " AND indexed.operation_id = ANY($2::text[])"
              : "";
            branches.push(
              `SELECT indexed.namespace, indexed.operation_id
                 FROM ${tables.operationEvents} AS indexed
                 JOIN ${tables.events} AS event
                   ON event.id = indexed.event_id
                  AND event.namespace = indexed.namespace
                WHERE indexed.namespace = $1${ids}
                  AND event.metadata @> $${params.length}::jsonb`,
            );
          }
          associationQuery = `WITH associated AS MATERIALIZED (
            ${branches.join("\n          UNION\n          ")}
          ) `;
          conditions.push(
            `EXISTS (
               SELECT 1 FROM associated
                WHERE associated.namespace = operation.namespace
                  AND associated.operation_id = operation.operation_id
             )`,
          );
        }
        query =
          `${associationQuery}SELECT operation.* FROM ${tables.operations} AS operation
          WHERE ${conditions.join(" AND ")}`;
      }
      params.push(limit);
      const result = await session.query<OperationRow>(
        `${query}
          ORDER BY operation.updated_at DESC, operation.operation_id DESC LIMIT $${params.length}`,
        params,
      );
      return (result.rows.map(mapOperation));
    },
    async maxEventPosition(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const params: unknown[] = [namespace];
      const eventMetadata = input.eventMetadata === undefined
        ? undefined
        : metadataObject(input.eventMetadata, "Event metadata");
      const metadataFilter = eventMetadata && Object.keys(eventMetadata).length
        ? ` AND metadata @> $${
          params.push(JSON.stringify(eventMetadata))
        }::jsonb`
        : "";
      const watermarkQuery = metadataFilter
        ? `WITH matching AS MATERIALIZED (
             -- Filter metadata before MAX so it cannot walk unrelated history
             -- through the namespace/position index.
             SELECT position FROM ${tables.events}
              WHERE namespace = $1${metadataFilter}
           )
           SELECT MAX(position) AS position FROM matching`
        : `SELECT MAX(position) AS position FROM ${tables.events}
          WHERE namespace = $1`;
      const result = await session.query<{
        position: string | number | bigint | null;
      }>(
        watermarkQuery,
        params,
      );
      const position = result.rows[0]?.position;
      return position === null || position === undefined
        ? undefined
        : String(position);
    },
    async requestCancellation(transaction, namespace, operationId, reason) {
      assertSchemaCommandTransaction(transaction, databaseSchema);
      const { commandTime } = schemaCommandContext(transaction, databaseSchema);
      await transaction.query(
        `UPDATE ${tables.operations} SET cancellation_requested_at = COALESCE(cancellation_requested_at, $4::timestamptz),
          cancellation_reason = COALESCE(cancellation_reason, $3), updated_at = $4::timestamptz
         WHERE namespace = $1 AND operation_id = $2 AND state IN ('accepted','running')`,
        [namespace, operationId, reason, commandTime],
      );
      const changed = await transaction.query<{ stream_id: string }>(
        `UPDATE ${tables.operationStreams}
         SET state = 'terminating', outcome = 'cancelled', reason = $3, updated_at = $4::timestamptz
         WHERE namespace = $1 AND operation_id = $2 AND state = 'open' RETURNING stream_id`,
        [namespace, operationId, reason.trim() || "cancelled", commandTime],
      );
      await publishOperationChange(
        session,
        transaction,
        databaseSchema,
        namespace,
        operationId,
      );
      for (const row of changed.rows) {
        await publishOperationChange(
          session,
          transaction,
          databaseSchema,
          namespace,
          operationId,
          { kind: "stream", streamId: row.stream_id },
        );
      }
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
      return (result.rows.map((row) => ({
        eventId: String(row.event_id),
        position: String(row.event_position),
      } as const)));
    },
    async findEventId(input) {
      const namespace = requiredText(input.namespace, "Operation namespace");
      const operationId = requiredText(input.operationId, "Operation id");
      const subjectId = requiredText(input.subjectId, "Event subject id");
      const typeSuffix = requiredText(input.typeSuffix, "Event type suffix");
      const params: unknown[] = [namespace, operationId, subjectId, typeSuffix];
      const scopedMatch = `indexed.namespace = $1 AND indexed.operation_id = $2
          AND event.namespace = indexed.namespace
          AND event.subject_id = $3
          AND right(event.type, length($4::text)) = $4`;
      // LIMIT in the correlated lookup keeps the fallback driven by this
      // operation's index, rather than scanning namespace-wide event history.
      const fallback = (preferred: boolean) =>
        `SELECT indexed.event_id
          FROM ${tables.operationEvents} AS indexed
          JOIN LATERAL (
            SELECT event.id FROM ${tables.events} AS event
             WHERE event.id = indexed.event_id AND event.namespace = $1
               AND event.subject_id = $3
               AND right(event.type, length($4::text)) = $4
             LIMIT 1
          ) AS matching ON TRUE
         WHERE indexed.namespace = $1 AND indexed.operation_id = $2
           ${preferred ? "AND NOT EXISTS (SELECT 1 FROM preferred)" : ""}
         ORDER BY indexed.event_position LIMIT 1`;
      const deduplicationId = input.deduplicationId === undefined
        ? undefined
        : requiredText(input.deduplicationId, "Event deduplication id");
      const query = deduplicationId === undefined ? fallback(false) : `
        WITH preferred AS MATERIALIZED (
          SELECT indexed.event_id
            FROM ${tables.events} AS event
            JOIN ${tables.operationEvents} AS indexed
              ON indexed.event_id = event.id
           WHERE ${scopedMatch} AND event.deduplication_id = $5
           LIMIT 1
        )
        SELECT event_id FROM preferred
        UNION ALL
        SELECT event_id FROM (${fallback(true)}) AS fallback
        LIMIT 1`;
      if (deduplicationId !== undefined) params.push(deduplicationId);
      const result = await session.query<{ event_id: string }>(query, params);
      return result.rows[0]?.event_id;
    },
    async openStream(input) {
      return await runCommand(
        "catalog.openStream",
        input,
        async (input, { transaction, commandTime }) => {
          const inTransaction: SqlSession["transaction"] = (run) =>
            Promise.resolve(run(transaction));

          const descriptor = snapshotStreamMetadata(input.descriptor);
          if (!isStreamOutputDescriptor(descriptor)) {
            throw new TypeError("Operation stream descriptor is invalid.");
          }
          const namespace = requiredText(
            input.namespace,
            "Operation namespace",
          );
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
          const retired = await transaction.query(
            `SELECT 1 FROM ${
              quoteEventIdentifier(databaseSchema)
            }."owner_body_retirements" WHERE body_id=$1 LIMIT 1`,
            [bodyId],
          );
          if (retired.rows.length) {
            throw new Error(
              "Operation body has entered irreversible retirement.",
            );
          }
          const replayKey = await inTransaction(async (transaction) => {
            const operation = await transaction.query<{
              next_stream_ordinal: string | number | bigint;
            }>(
              `SELECT next_stream_ordinal FROM ${tables.operations}
            WHERE namespace = $1 AND operation_id = $2
              AND state IN ('accepted','running') AND cancellation_requested_at IS NULL
            LIMIT 1`,
              [namespace, operationId],
            );
            if (!operation.rows[0]) return undefined;
            if (input.deliveryLease) {
              const owner = await transaction.query(
                `SELECT id FROM ${
                  quoteEventIdentifier(databaseSchema)
                }."event_deliveries"
             WHERE id = $1 AND status = 'leased' AND lease_owner = $2
               AND (lease_expires_at IS NULL OR lease_expires_at > $3::timestamptz)
               AND owner_epoch = (SELECT epoch FROM ${
                  quoteEventIdentifier(databaseSchema)
                }."owner_epochs" WHERE owner='schema')`,
                [
                  input.deliveryLease.deliveryId,
                  input.deliveryLease.owner,
                  commandTime,
                ],
              );
              if (!owner.rows.length) return undefined;
            }
            // A durable delivery retry must never append a restarted provider's
            // bytes to the previous execution. Opening the new physical lane
            // atomically closes any still-open incarnation of the same semantic
            // lane. The catalog records terminal intent before maintenance fences
            // and freezes that published Body prefix.
            const superseded = await transaction.query<{ stream_id: string }>(
              `UPDATE ${tables.operationStreams}
              SET state = 'terminating', outcome = 'cancelled',
                  reason = 'superseded', availability = 'retained',
                  updated_at = NOW()
            WHERE namespace = $1 AND operation_id = $2
              AND semantic_stream_id = $3 AND stream_id <> $4
              AND state = 'open' RETURNING stream_id`,
              [namespace, operationId, semanticStreamId, streamId],
            );
            for (const row of superseded.rows) {
              await publishOperationChange(
                session,
                transaction,
                databaseSchema,
                namespace,
                operationId,
                { kind: "stream", streamId: row.stream_id },
              );
            }
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
                [
                  namespace,
                  operationId,
                  streamId,
                  JSON.stringify(descriptor),
                ],
              );
              return ({
                replayKey: String(existing.rows[0].replay_key),
                streamOrdinal: String(existing.rows[0].stream_ordinal),
              } as const);
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
             availability, asset_retention,
             created_at, updated_at
           ) VALUES (
             $1,$2,$3::bigint,$4,$5,$6,$7::jsonb,'open',
             'retained','observation',NOW(),NOW()
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
            return ({
              replayKey: String(inserted.rows[0].replay_key),
              streamOrdinal: ordinal,
            } as const);
          });
          if (replayKey === undefined) return undefined;
          await publishOperationChange(
            session,
            transaction,
            databaseSchema,
            namespace,
            operationId,
            { kind: "stream", streamId },
          );
          return replayKey;
        },
      );
    },
    async acceptStreamCheckpoint(input) {
      return await runCommand(
        "catalog.acceptStreamCheckpoint",
        input,
        async (input, context) => {
          await requireStreamMembership(
            context.transaction,
            input,
            "checkpoint",
          );
          const accepted = await createContentCatalog(
            context.transaction,
            databaseSchema,
          ).checkpoint(input.content);
          await publishOperationChange(
            session,
            context.transaction,
            databaseSchema,
            input.namespace,
            input.operationId,
            {
              kind: "stream-offset",
              streamId: input.streamId,
              committedOffset: accepted,
            },
          );
          return accepted;
        },
      );
    },
    async acceptStreamSealIntent(input) {
      return await runCommand(
        "catalog.acceptStreamSealIntent",
        input,
        async (input, context) => {
          const membership = await requireStreamMembership(
            context.transaction,
            input,
            "seal",
          );
          const intent = await createContentCatalog(
            context.transaction,
            databaseSchema,
          ).sealIntent(input.content);
          // A retry of the accepted intent must not publish another lifecycle
          // change or turn an accepted terminal back into a terminating stream.
          if (
            membership.state === "terminal" ||
            membership.state === "terminating" && membership.reason === null
          ) {
            return intent;
          }
          const terminalizing = await context.transaction.query(
            `UPDATE ${tables.operationStreams}
             SET state='terminating', outcome='completed', reason=NULL,
                 availability='retained', updated_at=$4::timestamptz
             WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3
               AND (state='open' OR (state='terminating' AND outcome='completed' AND reason IS NULL))
             RETURNING stream_id`,
            [
              input.namespace,
              input.operationId,
              input.streamId,
              context.commandTime,
            ],
          );
          if (!terminalizing.rows.length) {
            throw new ContentStreamOwnershipLostError(input.streamId);
          }
          if (
            input.content.expectedOffset !== undefined &&
            input.content.expectedOffset !== input.content.length
          ) {
            await publishOperationChange(
              session,
              context.transaction,
              databaseSchema,
              input.namespace,
              input.operationId,
              {
                kind: "stream-offset",
                streamId: input.streamId,
                committedOffset: input.content.length,
              },
            );
          }
          await publishOperationChange(
            session,
            context.transaction,
            databaseSchema,
            input.namespace,
            input.operationId,
            { kind: "stream", streamId: input.streamId },
          );
          return intent;
        },
      );
    },
    async acceptStreamSeal(input) {
      return await runCommand(
        "catalog.acceptStreamSeal",
        input,
        async (input, context) => {
          await requireStreamMembership(context.transaction, input, "seal");
          const accepted = await createContentCatalog(
            context.transaction,
            databaseSchema,
          ).sealAccepted(input.content);
          if (
            !await publishStreamTerminal({
              ...input,
              bodyId: input.content.bodyId,
              terminal: accepted,
            }, context)
          ) {
            throw new ContentStreamOwnershipLostError(input.streamId);
          }
          return accepted;
        },
      );
    },
    async acceptStreamFailure(input) {
      return await runCommand(
        "catalog.acceptStreamFailure",
        input,
        async (input, context) => {
          const membership = await requireStreamMembership(
            context.transaction,
            input,
            "failure",
          );
          const priorFailure = (membership.state === "terminating" ||
            membership.state === "terminal") &&
            membership.outcome !== "completed";
          const accepted = await createContentCatalog(
            context.transaction,
            databaseSchema,
          ).recordFailure({
            ...input.content,
            ...(priorFailure
              ? {
                outcome: membership.outcome as "failed" | "cancelled",
                reason: membership.reason ?? undefined,
              }
              : {}),
          });
          if (
            accepted.outcome === "completed" ||
            !await publishStreamTerminal({
              ...input,
              bodyId: input.content.bodyId,
              terminal: accepted,
            }, context)
          ) {
            throw new ContentStreamOwnershipLostError(input.streamId);
          }
          return accepted;
        },
      );
    },
    async sealStream(input) {
      if (input.body.state !== "ready") {
        throw new TypeError("Completed streams require a sealed Body.");
      }
      return await runCommand(
        "catalog.sealStream",
        input,
        async (input, context) => {
          const body = await createContentCatalog(
            context.transaction,
            databaseSchema,
          ).read(input.body.bodyId);
          if (
            body?.namespace !== input.namespace ||
            body.terminal?.outcome !== "completed" ||
            body.terminal.length !== input.body.byteLength ||
            body.terminal.digest !== input.body.digest
          ) return false;
          return await publishStreamTerminal({
            ...input,
            bodyId: body.bodyId,
            terminal: body.terminal,
          }, context);
        },
      );
    },
    async beginStreamTerminalization(input) {
      return await runCommand(
        "catalog.beginStreamTerminalization",
        input,
        async (input, { transaction }) => {
          const outcome = input.outcome === "completed"
            ? "completed"
            : failedOutcome(input.outcome);
          const reason = streamReason(input.reason);
          const result = await transaction.query<{ stream_id: string }>(
            `UPDATE ${tables.operationStreams}
           SET state = 'terminating', outcome = $4, reason = $5,
               availability = 'retained', updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND (
             state = 'open'
             OR (state = 'terminating' AND outcome = $4 AND reason IS NOT DISTINCT FROM $5)
           )
         RETURNING stream_id`,
            [
              input.namespace,
              input.operationId,
              input.streamId,
              outcome,
              reason,
            ],
          );
          if (result.rows.length > 0) {
            await publishOperationChange(
              session,
              transaction,
              databaseSchema,
              input.namespace,
              input.operationId,
              { kind: "stream", streamId: input.streamId },
            );
          }
          return result.rows.length > 0;
        },
      );
    },
    async terminateStream(input) {
      failedOutcome(input.outcome);
      streamReason(input.reason);
      return await runCommand(
        "catalog.terminateStream",
        input,
        async (input, context) => {
          const body = await createContentCatalog(
            context.transaction,
            databaseSchema,
          ).read(input.body.bodyId);
          if (
            body?.namespace !== input.namespace || !body.terminal ||
            body.terminal.outcome === "completed" ||
            body.terminal.length !== input.body.byteLength
          ) return false;
          return await publishStreamTerminal({
            ...input,
            bodyId: body.bodyId,
            terminal: body.terminal,
          }, context);
        },
      );
    },
    async markStreamUnavailable(input) {
      return await runCommand(
        "catalog.markStreamUnavailable",
        input,
        async (input, { transaction, commandTime }) => {
          const stream = (await transaction.query<{ body_id: string }>(
            `SELECT body_id FROM ${tables.operationStreams} WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3`,
            [input.namespace, input.operationId, input.streamId],
          )).rows[0];
          const terminal = stream
            ? (await createContentCatalog(transaction, databaseSchema).read(
              stream.body_id,
            ))?.terminal
            : undefined;
          if (
            input.outcome === "completed" && terminal?.outcome !== "completed"
          ) {
            throw new TypeError(
              "Completed availability loss requires an accepted catalog seal.",
            );
          }
          const outcome = terminal?.outcome ??
            failedOutcome(
              input.outcome as Exclude<StreamTerminalOutcome, "completed">,
            );
          const reason = streamReason(terminal?.reason ?? input.reason);
          const result = await transaction.query<{ stream_id: string }>(
            `UPDATE ${tables.operationStreams}
           SET state = 'terminal',
               outcome = CASE
                 WHEN state = 'terminal' OR (state = 'terminating' AND outcome <> 'completed') THEN outcome ELSE $4
               END,
               reason = CASE
                 WHEN state = 'terminal' OR (state = 'terminating' AND outcome <> 'completed') THEN reason ELSE $5
               END,
               availability = 'purged', availability_reason = $6, cleanup_state = NULL,
               asset_retention = COALESCE(asset_retention, 'observation'),
               terminal_at = COALESCE(terminal_at, $7::timestamptz), updated_at = $7::timestamptz
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND availability = 'retained'
         RETURNING stream_id`,
            [
              input.namespace,
              input.operationId,
              input.streamId,
              outcome,
              reason,
              requiredText(
                input.availabilityReason,
                "Stream availability reason",
              ),
              commandTime,
            ],
          );
          if (result.rows.length > 0) {
            await publishOperationChange(
              session,
              transaction,
              databaseSchema,
              input.namespace,
              input.operationId,
              { kind: "stream", streamId: input.streamId },
            );
          }
          if (result.rows.length > 0) {
            if (options.onStreamTerminal) {
              await writeOwnerDeadline(transaction, databaseSchema, {
                source: "reconciliation",
                key: reconciliationAlarmKey("schema", {
                  kind: "operation",
                  namespace: input.namespace,
                  id: input.operationId,
                }),
                namespace: input.namespace,
                dueAt: commandTime,
                payload: { operationId: input.operationId },
              });
            }
            afterSqlCommit(
              transaction,
              () => options.onStreamTerminal?.(input),
            );
          }
          return result.rows.length > 0;
        },
      );
    },
    async discardStream(input) {
      return await runCommand(
        "catalog.discardStream",
        input,
        async (input, { transaction, commandTime }) => {
          const result = await transaction.query<{ stream_id: string }>(
            `DELETE FROM ${tables.operationStreams}
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state = 'open' AND NOT EXISTS (SELECT 1 FROM ${
              createCoreTableNames(databaseSchema).content_logical_bodies
            } b WHERE b.body_id=${tables.operationStreams}.body_id AND b.committed_offset>0)
          RETURNING stream_id`,
            [input.namespace, input.operationId, input.streamId],
          );
          if (result.rows.length > 0) {
            await publishOperationChange(
              session,
              transaction,
              databaseSchema,
              input.namespace,
              input.operationId,
              { kind: "stream", streamId: input.streamId },
            );
          }
          if (result.rows.length > 0) {
            if (options.onStreamTerminal) {
              await writeOwnerDeadline(transaction, databaseSchema, {
                source: "reconciliation",
                key: reconciliationAlarmKey("schema", {
                  kind: "operation",
                  namespace: input.namespace,
                  id: input.operationId,
                }),
                namespace: input.namespace,
                dueAt: commandTime,
                payload: { operationId: input.operationId },
              });
            }
            afterSqlCommit(
              transaction,
              () => options.onStreamTerminal?.(input),
            );
          }
          return result.rows.length > 0;
        },
      );
    },
    async retainStream(input) {
      return await runCommand(
        "catalog.retainStream",
        input,
        async (input, { transaction }) => {
          const assetId = input.retention === "canonical"
            ? requiredText(input.assetId, "Operation stream asset id")
            : undefined;
          await transaction.query(
            `UPDATE ${tables.operationStreams}
           SET asset_id = $4, asset_retention = $5, cleanup_state = NULL, updated_at = NOW()
         WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
           AND state = 'terminal' AND outcome = 'completed' AND availability = 'retained'`,
            [
              input.namespace,
              input.operationId,
              input.streamId,
              assetId ?? null,
              input.retention,
            ],
          );
          await publishOperationChange(
            session,
            transaction,
            databaseSchema,
            input.namespace,
            input.operationId,
            { kind: "stream", streamId: input.streamId },
          );
        },
      );
    },
    async listStreams(input) {
      const after = input.afterStreamOrdinal?.trim();
      if (after !== undefined && !/^(0|[1-9][0-9]*)$/.test(after)) {
        throw new TypeError(
          "Operation stream ordinal must be a non-negative integer.",
        );
      }
      const result = await session.query<StreamRow>(
        `SELECT * FROM (${streamSelection}) AS stream
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
      return (result.rows.map(mapStream));
    },
    async getStream(namespace, operationId, streamId) {
      const result = await session.query<StreamRow>(
        `SELECT * FROM (${streamSelection}) AS stream
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
        `SELECT * FROM (${streamSelection}) AS stream
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
      const watch = await catalog.watch(stream.operationId, { namespace });
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
              AND availability = 'retained'
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
           FROM (${streamSelection}) AS stream
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
      return (result.rows.map((row) => ({
        ...mapStream(row),
        operationState: row.operation_state,
      } as const)));
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
        `SELECT stream.* FROM (${streamSelection}) AS stream
          JOIN ${tables.operations} AS operation
            ON operation.namespace = stream.namespace
           AND operation.operation_id = stream.operation_id
          WHERE stream.asset_retention = 'observation'
            AND stream.state = 'terminal'
            AND stream.availability = 'retained'
            AND operation.state IN ('completed','failed','cancelled')
            AND operation.completed_at IS NOT NULL
            AND operation.completed_at <= $1::timestamptz
          ORDER BY operation.completed_at, stream.namespace,
                   stream.operation_id, stream.stream_id LIMIT $2`,
        [completedCutoff, boundedLimit(input.limit)],
      );
      return (result.rows.map(mapStream));
    },
    async failDeliveryStreams(transaction, input) {
      assertSchemaCommandTransaction(transaction, databaseSchema);
      await transaction.query(
        `UPDATE ${tables.operationStreams}
        SET state = 'terminating', outcome = $3, updated_at = NOW()
        WHERE operation_id = $1 AND state = 'open'
          AND descriptor -> 'metadata' ->> 'sourceDeliveryId' = $2`,
        [input.operationId, input.deliveryId, input.outcome],
      );
    },
    async reconcile(input = {}, transaction, outcome) {
      if (transaction) {
        assertSchemaCommandTransaction(transaction, databaseSchema);
      }
      const key = !transaction && input.namespace && input.operationId
        ? JSON.stringify([input.namespace, input.operationId])
        : undefined;
      const active = key && reconciliations.get(key);
      if (active) return await active;
      const run = async () => {
        const deliveries = `${
          quoteEventIdentifier(databaseSchema)
        }."event_deliveries"`;
        const actions = `${
          quoteEventIdentifier(databaseSchema)
        }."open_actions"`;
        const drained = `NOT EXISTS (
        SELECT 1 FROM ${actions} AS action
        WHERE action.namespace = operation.namespace AND action.scope_id = operation.operation_id
      ) AND NOT EXISTS (
        SELECT 1 FROM ${tables.operationStreams} AS stream
        WHERE stream.namespace = operation.namespace AND stream.operation_id = operation.operation_id
          AND stream.state IN ('open','terminating')
      ) AND NOT EXISTS (
        SELECT 1 FROM ${deliveries} AS delivery
        JOIN ${tables.events} AS event ON event.id = delivery.event_id
        WHERE delivery.settlement_scope_id = operation.operation_id AND event.namespace = operation.namespace
          AND delivery.status IN ('pending','leased','retry_wait')
      )`;
        const terminalizable = await (transaction ?? session).query<
          { operation_id: string; namespace: string }
        >(
          `SELECT operation.operation_id, operation.namespace FROM ${tables.operations} AS operation
         WHERE operation.state IN ('accepted','running')
           AND ($2::text IS NULL OR operation.namespace = $2)
           AND ($3::text IS NULL OR operation.operation_id = $3)
           AND ${drained}
         ORDER BY operation.updated_at, operation.operation_id LIMIT $1`,
          [
            boundedLimit(input.limit),
            input.namespace ?? null,
            input.operationId ?? null,
          ],
        );
        for (const operation of terminalizable.rows) {
          if (!transaction) {
            await options.beforeTerminal?.({
              namespace: operation.namespace,
              operationId: operation.operation_id,
            });
          }
        }
        if (!terminalizable.rows.length) return 0;
        const ids = terminalizable.rows.map((operation) =>
          operation.operation_id
        );
        const publications: (() => Promise<void>)[] = [];
        const result =
          await (transaction
            ? createSchemaCommandRunner(transaction, databaseSchema)
            : runCommand)(
              "catalog.reconcile",
              { ids },
              async (_input, { transaction, commandTime }) => {
                // Output draining ran outside the command loop. Reread readiness
                // inside this serialized command so newly admitted work prevents settlement.
                const settled = await transaction.query<
                  { operation_id: string; namespace: string }
                >(
                  `WITH drained AS MATERIALIZED (
            SELECT operation.operation_id, operation.namespace,
              CASE WHEN operation.cancellation_requested_at IS NOT NULL THEN 'cancelled'
                WHEN EXISTS (
                  SELECT 1 FROM ${deliveries} AS delivery
                  JOIN ${tables.events} AS event ON event.id = delivery.event_id
                  WHERE delivery.settlement_scope_id = operation.operation_id
                    AND event.namespace = operation.namespace AND delivery.status IN ('dead_letter','cancelled')
                ) THEN 'failed' ELSE COALESCE($2::text, 'completed') END AS outcome
            FROM ${tables.operations} AS operation
            WHERE operation.operation_id = ANY($1::text[])
              AND operation.state IN ('accepted','running') AND ${drained}
          ), settled AS (UPDATE ${tables.operations} AS operation
            SET state = drained.outcome, updated_at = $3::timestamptz,
              completed_at = COALESCE(operation.completed_at, $3::timestamptz)
            FROM drained WHERE operation.operation_id = drained.operation_id
            RETURNING operation.operation_id, operation.namespace
          ), removed_deadlines AS (
            DELETE FROM ${
                    createCoreTableNames(databaseSchema).owner_deadlines
                  } AS deadline
            USING settled, unnest($1::text[], $5::text[]) AS keys(operation_id, key)
            WHERE deadline.owner='schema' AND deadline.source='reconciliation'
              AND deadline.key=keys.key AND settled.operation_id=keys.operation_id
          ), retained_content AS (
            UPDATE "${databaseSchema}"."pending_content" AS content
            SET expires_at=GREATEST(expires_at,$3::timestamptz+($4::bigint*interval '1 millisecond'))
            FROM settled WHERE content.namespace=settled.namespace AND content.producer=settled.operation_id
          ) SELECT * FROM settled`,
                  [
                    ids,
                    outcome ?? null,
                    commandTime,
                    CONTENT_REPLAY_RETENTION_MS,
                    terminalizable.rows.map((row) =>
                      reconciliationAlarmKey("schema", {
                        kind: "operation",
                        namespace: row.namespace,
                        id: row.operation_id,
                      })
                    ),
                  ],
                );
                if (settled.rows.length) {
                  invalidateOwnerAlarm(transaction, databaseSchema);
                }
                for (const row of settled.rows) {
                  await publishOperationChange(
                    session,
                    transaction,
                    databaseSchema,
                    row.namespace,
                    row.operation_id,
                  );
                  const flush = await options.onSettled?.(transaction, {
                    namespace: row.namespace,
                    operationId: row.operation_id,
                  });
                  if (flush) publications.push(flush);
                }
                return settled;
              },
            );
        for (const flush of publications) {
          if (transaction) {
            schemaCommandContext(transaction, databaseSchema).afterCommit(
              flush,
            );
          } else await flush();
        }
        return result.rows.length;
      };
      const task = run();
      if (key) reconciliations.set(key, task);
      try {
        return await task;
      } finally {
        if (key && reconciliations.get(key) === task) {
          reconciliations.delete(key);
        }
      }
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
        const result = await runCommand(
          "catalog.prune",
          candidate,
          async (_input, { transaction }) => {
            // Canonical Asset storage remains authoritative after replay grace;
            // deleting this metadata must never touch its Body. Expiring
            // observation rows remain until their Body CAS retirement succeeds.
            const removedStreams = await transaction.query<
              { stream_id: string }
            >(
              `DELETE FROM ${tables.operationStreams}
              WHERE namespace = $1 AND operation_id = $2
                AND state = 'terminal'
                AND (
                  asset_retention = 'canonical'
                  OR (
                    availability = 'purged'
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
              return ({
                streams: removedStreams.rows.length,
                events: 0,
                operations: 0,
              } as const);
            }
            const removedEvents = await transaction.query<{ event_id: string }>(
              `DELETE FROM ${tables.operationEvents}
              WHERE namespace = $1 AND operation_id = $2 RETURNING event_id`,
              [candidate.namespace, candidate.operation_id],
            );
            await publishOperationChange(
              session,
              transaction,
              databaseSchema,
              candidate.namespace,
              candidate.operation_id,
              { kind: "retirement" },
            );
            await transaction.query(
              `UPDATE ${tables.selectionHeads} AS head SET change_ordinal=change_ordinal+1
               WHERE namespace=$1 AND selection_key IN (SELECT selection_key FROM ${tables.selectionOperations}
               WHERE namespace=$1 AND operation_id=$2)`,
              [candidate.namespace, candidate.operation_id],
            );
            await transaction.query(
              `DELETE FROM ${tables.selectionOperations}
            WHERE namespace = $1 AND operation_id = $2`,
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
            return ({
              streams: removedStreams.rows.length,
              events: removedEvents.rows.length,
              operations: removedOperation.rows.length,
            } as const);
          },
        );
        streams += result.streams;
        events += result.events;
        operations += result.operations;
      }
      return ({ streams, events, operations } as const);
    },
    async pruneStream(input) {
      return await runCommand(
        "catalog.pruneStream",
        input,
        async (input, { transaction }) => {
          const result = await transaction.query<{ stream_id: string }>(
            `UPDATE ${tables.operationStreams}
            SET availability = 'purged', availability_reason = $4, cleanup_state = NULL, updated_at = NOW()
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state = 'terminal' AND availability = 'retained' AND cleanup_state = 'pending'
          RETURNING stream_id`,
            [
              input.namespace,
              input.operationId,
              input.streamId,
              input.availabilityReason ?? "deleted",
            ],
          );
          if (result.rows.length > 0) {
            await publishOperationChange(
              session,
              transaction,
              databaseSchema,
              input.namespace,
              input.operationId,
              { kind: "stream", streamId: input.streamId },
            );
          }
          return result.rows.length > 0;
        },
      );
    },
    async beginStreamCleanup(input) {
      return await runCommand(
        "catalog.beginStreamCleanup",
        input,
        async (input, { transaction }) => {
          const result = await transaction.query<{ stream_id: string }>(
            `UPDATE ${tables.operationStreams}
            SET cleanup_state = 'pending', updated_at = NOW()
          WHERE namespace = $1 AND operation_id = $2 AND stream_id = $3
            AND state = 'terminal' AND asset_retention = 'observation'
            AND availability = 'retained'
          RETURNING stream_id`,
            [input.namespace, input.operationId, input.streamId],
          );
          if (result.rows.length > 0) {
            await publishOperationChange(
              session,
              transaction,
              databaseSchema,
              input.namespace,
              input.operationId,
              { kind: "stream", streamId: input.streamId },
            );
          }
          return result.rows.length > 0;
        },
      );
    },
  };
  return catalog;
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
