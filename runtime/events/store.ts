import { ActionOwnershipLost } from "../actions/ownership.ts";
import { assertOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import {
  reconciliationAlarmKey,
  writeOwnerDeadline,
} from "../engine/alarms.ts";
import {
  assertSchemaCommandTransaction,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import { stageOwnerChange } from "./push.ts";
import { afterSqlCommit, sqlCommitGate } from "./session.ts";
import { ulid } from "../../dependencies/ulid.ts";
import { canonicalizeContentRefs } from "../content/input.ts";
import { assertJsonValue } from "../json.ts";
import { errorRetryability } from "../failure.ts";
import { createEventStoreError } from "./errors.ts";
import {
  encodeEventBody,
  EVENT_BODY_SCHEMA_VERSION,
  writeEventBody,
} from "./body-store.ts";
import {
  type CoreTableName,
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
} from "./schema.ts";
import type { SqlExecutor, SqlSession } from "./session.ts";
import type {
  DeliveryScopeSettlement,
  DeliveryStatus,
  DurableConsumerObligation,
  DurableEvent,
  DurableEventDraft,
  EventDelivery,
  EventSubject,
} from "./types.ts";

/** Claimed attempt identity, supplied only by owner execution registration. */
export type DeliveryAttemptHeartbeat = Readonly<{
  id: string;
  owner: string;
  ownerEpoch: number;
  namespace: string;
  eventId: string;
  operationId: string;
  leaseMs: number;
}>;

type EventRow = Record<string, unknown> & {
  id: string;
  position: string | number | bigint;
  seq: string | number | bigint;
  schema_version: number;
  type: string;
  namespace: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  delta: unknown;
  metadata: unknown;
  causation_id: string | null;
  correlation_id: string;
  deduplication_id: string | null;
  created_at: string | Date;
};

type DeliveryRow = Record<string, unknown> & {
  id: string;
  event_id: string;
  consumer_id: string;
  settlement_scope_id: string;
  action_scope_id: string | null;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  available_at: string | Date;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  last_error: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  settled_at: string | Date | null;
};

type EncodedJson = {
  text: string;
  value: unknown;
};

type EncodedDraft = {
  payload: EncodedJson;
  delta: EncodedJson;
  metadata: EncodedJson;
};

export type EventMutationContext = {
  transaction: SqlExecutor;
  tables: Readonly<Record<CoreTableName, string>>;
};

/** SQL composed into the statement that inserts an event. */
export type EventStatement<T> = Readonly<{
  /** CTEs evaluated before the event insert. */
  ctes: readonly string[];
  /** The event is inserted only when this condition holds. */
  gate: string;
  /** Writes applied only with the inserted event, given its CTE name. */
  effects(source: string): readonly string[];
  /** A jsonb expression over `ctes` that explains the gate. */
  report: string;
  /** The value of an inserted event; throws why a refused one was not. */
  resolve(report: unknown, inserted: boolean): T;
}>;

export type CommitEventMutationOptions<T> = {
  draft: DurableEventDraft;
  /** Stable runtime-owned root event identity. */
  eventId?: string;
  consumers: readonly DurableConsumerObligation[];
  maxAttempts?: number;
  /** Runtime-owned lifecycle admission, never derived from event metadata. */
  admission?: Readonly<{ cancellation?: boolean }>;
  /** Join the active transaction supplied to an owner command handler. */
  transaction?: SqlExecutor;
  /** An event body written by the event's own statement. */
  body?: Readonly<{ id: string; json: unknown }>;
  /**
   * Writes and checks composed into the event insert, inside its transaction.
   * The context supplies the command clock captured after the owner fence.
   */
  statement?(
    param: (value: unknown) => string,
    tables: EventMutationContext["tables"],
    context: Readonly<{ commandTime: string }>,
  ): EventStatement<T>;
  /**
   * Additional writes that share the event's transaction.
   */
  mutate?(context: EventMutationContext): Promise<T>;
  recoverDuplicate?: (
    event: DurableEvent,
    context: EventMutationContext,
  ) => Promise<T>;
};

export type CommitEventMutationResult<T> = Readonly<{
  value: T | undefined;
  event: DurableEvent;
  deliveries: readonly EventDelivery[];
  settlementScopeId: string;
  actionScopeId?: string;
  deduplicated: boolean;
}>;

export type CreateEventStoreOptions = {
  session: SqlSession;
  schema?: string;
  createId?: () => string;
  now?: () => Date;
  random?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  onScopeCancellation?(
    transaction: SqlExecutor,
    input: Readonly<{ namespace: string; operationId: string; reason: string }>,
  ): Promise<(() => Promise<void>) | void>;
  /** Commit generic Action terminals and fan-out with delivery settlement. */
  settleActionOwners?(
    transaction: SqlExecutor,
    delivery: EventDelivery,
  ): Promise<(() => Promise<void>) | void>;
  /** Locks a scope before admitting work, in the event's own SQL statement. */
  admitOperationEventSql?: (
    input: Readonly<
      {
        namespace: string;
        operationId: string;
        requireScope?: boolean;
        cancellationTerminal?: boolean;
      }
    >,
    param: (value: unknown) => string,
  ) => Readonly<{ ctes: readonly string[]; gate: string; cancelled?: string }>;
  /** Additive operational index written in the same transaction as the Event. */
  indexOperationEvent?: (
    transaction: SqlExecutor,
    input: Readonly<{
      namespace: string;
      operationId: string;
      eventId: string;
      position: string;
      correlationId: string;
      createdAt: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>,
  ) => Promise<void>;
  /**
   * The same index as CTEs over a sibling `inserted_event` CTE, so a new
   * event is indexed by its own insert statement.
   */
  indexOperationEventSql?: (
    input: Readonly<{
      namespace: string;
      operationId: string;
      eventId: string;
      correlationId: string;
      createdAt: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>,
    param: (value: unknown) => string,
  ) => string;
};

/** Internal completion counts; successful history is deliberately not counted. */
export type DeliveryScopeOutstanding = Pick<
  DeliveryScopeSettlement,
  "unsettled" | "deadLetters" | "cancelled"
>;

export type EventStore = {
  executionAuthority(): Promise<
    Readonly<{ epoch: number; signal: AbortSignal }>
  >;
  databaseSchema: string;
  session: SqlSession;
  tables: Readonly<Record<CoreTableName, string>>;
  commitMutation<T>(
    options: CommitEventMutationOptions<T>,
  ): Promise<CommitEventMutationResult<T>>;
  append(
    draft: DurableEventDraft,
    consumerIds?: readonly string[],
    options?: { maxAttempts?: number },
  ): Promise<CommitEventMutationResult<void>>;
  getEvent(id: string): Promise<DurableEvent | null>;
  /** The body of an event this store just committed, if it still holds it. */
  recentEventBody?(
    eventId: string,
    eventBodyId: string,
  ): Readonly<{ json: unknown }> | undefined;
  getEventByDeduplicationId(
    namespace: string,
    deduplicationId: string,
  ): Promise<DurableEvent | null>;
  listEvents(options: {
    namespace: string;
    metadata?: Readonly<Record<string, unknown>>;
    correlationId?: string;
    afterPosition?: string;
    afterSeq?: string;
    /** Result order. `afterPosition` remains an ascending position bound. */
    order?: "asc" | "desc";
    limit?: number;
  }, executor?: SqlExecutor): Promise<readonly DurableEvent[]>;
  getDelivery(id: string): Promise<EventDelivery | null>;
  listDeliveries(options?: {
    ids?: readonly string[];
    namespace?: string;
    eventId?: string;
    consumerId?: string;
    settlementScopeId?: string;
    status?: DeliveryStatus;
    limit?: number;
  }): Promise<readonly EventDelivery[]>;
  claimDelivery(options: {
    id: string;
    owner: string;
    leaseMs?: number;
    /** Trusted owner placement, never a worker-supplied capability option. */
    localExecution?: boolean;
  }): Promise<EventDelivery | null>;
  claimNext(options: {
    owner: string;
    namespace?: string;
    consumerIds?: readonly string[];
    leaseMs?: number;
  }): Promise<EventDelivery | null>;
  heartbeatDelivery(options: {
    id: string;
    owner: string;
    leaseMs?: number;
  }): Promise<boolean>;
  /** Bounded accepted-session batch; caller binds current transport authority. */
  heartbeatDeliveries(
    attempts: readonly DeliveryAttemptHeartbeat[],
  ): Promise<readonly Pick<DeliveryAttemptHeartbeat, "id" | "owner">[]>;
  /** Settles a leased delivery and returns the row it settled into. */
  succeedDelivery(id: string, owner: string): Promise<EventDelivery | null>;
  cancelDelivery(id: string, owner?: string): Promise<EventDelivery | null>;
  failDelivery(options: {
    id: string;
    owner: string;
    error: unknown;
    backoffMs?: number;
    /** False terminalizes the delivery immediately instead of retrying it. */
    retryable?: boolean;
  }): Promise<EventDelivery | null>;
  listRecoverable(options?: {
    namespace?: string;
    consumerIds?: readonly string[];
    limit?: number;
  }): Promise<readonly EventDelivery[]>;
  /** Explicit recovery write; status and scheduling queries never expire leases. */
  recoverExpiredDeliveries(
    options?: { namespace?: string; limit?: number },
  ): Promise<readonly EventDelivery[]>;
  /** Defers placement of a still-unclaimed delivery using the owner's alarm. */
  deferDeliveryPlacement(id: string, delayMs: number): Promise<void>;
  scopeSettlement(
    namespace: string,
    settlementScopeId: string,
  ): Promise<DeliveryScopeSettlement>;
  scopeOutstanding(
    namespace: string,
    settlementScopeId: string,
  ): Promise<DeliveryScopeOutstanding>;
  cancelScope(
    namespace: string,
    settlementScopeId: string,
    reason?: string,
  ): Promise<number>;
  compactDeliveries(options?: {
    retentionMs?: number | null;
    now?: Date;
    limit?: number;
  }): Promise<{ deliveries: number }>;
};

const DEFAULT_COMPACTION_LIMIT = 100;
const MAX_COMPACTION_LIMIT = 1_000;
const RECENT_EVENT_LIMIT = 256;

function iso(value: string | Date | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function parseJsonRows(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
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

function encodeJson(value: unknown, field: string): EncodedJson {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    if (text === undefined) {
      throw new TypeError(`${field} is not JSON serializable.`);
    }
    return { text, value: JSON.parse(text) };
  } catch (cause) {
    throw createEventStoreError(
      "event_invalid",
      `Event ${field} must be JSON serializable.`,
      cause,
    );
  }
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function mapEvent(row: EventRow): DurableEvent {
  const event: DurableEvent = {
    durable: true,
    id: String(row.id),
    position: String(row.position),
    seq: String(row.seq),
    schemaVersion: Number(row.schema_version),
    type: String(row.type),
    namespace: String(row.namespace),
    ...(row.subject_type && row.subject_id
      ? {
        subject: {
          type: String(row.subject_type),
          id: String(row.subject_id),
        },
      }
      : {}),
    payload: row.payload,
    ...(row.delta == null ? {} : { delta: row.delta }),
    metadata: record(row.metadata),
    ...(row.causation_id ? { causationId: String(row.causation_id) } : {}),
    correlationId: String(row.correlation_id),
    ...(row.deduplication_id
      ? { deduplicationId: String(row.deduplication_id) }
      : {}),
    createdAt: iso(row.created_at)!,
  };
  return event;
}

function mapDelivery(row: DeliveryRow, databaseSchema: string): EventDelivery {
  const lastError = row.last_error == null ? undefined : record(row.last_error);
  return ({
    databaseSchema,
    id: String(row.id),
    eventId: String(row.event_id),
    consumerId: String(row.consumer_id),
    settlementScopeId: String(row.settlement_scope_id),
    ...(row.action_scope_id
      ? { actionScopeId: String(row.action_scope_id) }
      : {}),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at)!,
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: iso(row.lease_expires_at) }
      : {}),
    ...(lastError ? { lastError } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    ...(row.settled_at ? { settledAt: iso(row.settled_at) } : {}),
  });
}

function validateDraft(draft: DurableEventDraft): void {
  if (!draft.type?.trim()) {
    throw createEventStoreError(
      "event_invalid",
      "A durable event requires a non-empty type.",
    );
  }
  if (!draft.namespace?.trim()) {
    throw createEventStoreError(
      "event_invalid",
      "A durable event requires a non-empty namespace.",
    );
  }
  if (
    draft.subject && (!draft.subject.type.trim() || !draft.subject.id.trim())
  ) {
    throw createEventStoreError(
      "event_invalid",
      "An event subject requires non-empty type and ID values.",
    );
  }
  if (draft.createdAt && Number.isNaN(new Date(draft.createdAt).getTime())) {
    throw createEventStoreError(
      "event_invalid",
      "An event createdAt value must be a valid timestamp.",
    );
  }
}

function encodeDraft(draft: DurableEventDraft): EncodedDraft {
  return {
    payload: encodeJson(canonicalizeContentRefs(draft.payload), "payload"),
    delta: encodeJson(canonicalizeContentRefs(draft.delta), "delta"),
    metadata: encodeJson(
      canonicalizeContentRefs(draft.metadata ?? {}),
      "metadata",
    ),
  };
}

function sameSubject(
  left: EventSubject | undefined,
  right: EventSubject | undefined,
): boolean {
  return left?.type === right?.type && left?.id === right?.id;
}

function assertDuplicateMatches(
  event: DurableEvent,
  draft: DurableEventDraft,
  encoded: EncodedDraft,
): void {
  const mismatch = event.type !== draft.type.trim() ||
    event.namespace !== draft.namespace.trim() ||
    !sameSubject(event.subject, draft.subject) ||
    event.causationId !== draft.causationId ||
    (draft.correlationId !== undefined &&
      event.correlationId !== draft.correlationId) ||
    canonicalJson(event.payload) !== canonicalJson(encoded.payload.value) ||
    canonicalJson(event.delta ?? null) !== canonicalJson(encoded.delta.value) ||
    canonicalJson(event.metadata) !== canonicalJson(encoded.metadata.value);

  if (mismatch) {
    throw createEventStoreError(
      "event_deduplication_conflict",
      `Event deduplication ID '${draft.deduplicationId}' was reused with a different semantic event.`,
    );
  }
}

function uniqueConsumerIds(values: readonly string[]): string[] {
  const consumers = new Set<string>();
  for (const value of values) {
    const consumer = value.trim();
    if (!consumer) {
      throw createEventStoreError(
        "event_invalid",
        "Durable consumer IDs must be non-empty strings.",
      );
    }
    consumers.add(consumer);
  }
  return [...consumers];
}

function uniqueConsumers(
  values: readonly DurableConsumerObligation[],
): DurableConsumerObligation[] {
  const consumers = new Map<string, DurableConsumerObligation>();
  for (const value of values) {
    const consumerId = value.consumerId.trim();
    if (!consumerId) {
      throw createEventStoreError(
        "event_invalid",
        "Durable consumer IDs must be non-empty strings.",
      );
    }
    if (value.settlement !== "inherit" && value.settlement !== "detached") {
      throw createEventStoreError(
        "event_invalid",
        `Durable consumer '${consumerId}' has an invalid settlement mode.`,
      );
    }
    const existing = consumers.get(consumerId);
    if (existing && existing.settlement !== value.settlement) {
      throw createEventStoreError(
        "event_invalid",
        `Durable consumer '${consumerId}' has conflicting settlement modes.`,
      );
    }
    consumers.set(
      consumerId,
      {
        consumerId,
        settlement: value.settlement,
      } as const,
    );
  }
  return [...consumers.values()];
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

// Errors relayed by a database session may keep only their message.
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  return value.code === "23505" ||
    (typeof value.message === "string" &&
      value.message.includes("violates unique constraint")) ||
    (value.cause !== undefined && isUniqueViolation(value.cause));
}

function serializeError(
  error: unknown,
  retryable?: boolean,
): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" && code.trim() ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(retryable === undefined ? {} : { retryable }),
    };
  }
  return {
    name: "Error",
    message: String(error),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function filtersForConsumers(
  alias: string,
  consumerIds: readonly string[] | undefined,
  params: unknown[],
): string | undefined {
  if (!consumerIds?.length) return undefined;
  const consumers = uniqueConsumerIds(consumerIds);
  const placeholders = consumers.map((consumer) => {
    params.push(consumer);
    return `$${params.length}`;
  });
  return `${alias}.consumer_id IN (${placeholders.join(", ")})`;
}

const eventCommitGates = new WeakMap<DurableEvent, () => void>();

/** Publication requires the actual outer commit, never a caller's assertion. */
export function assertEventCommitted(event: DurableEvent): void {
  const gate = eventCommitGates.get(event);
  if (!gate) throw new Error("Event has no transaction commit evidence.");
  gate();
}

/** Creates the immutable-event and durable-delivery persistence boundary. */
export function createEventStore(
  options: CreateEventStoreOptions,
): EventStore {
  const { session } = options;
  const databaseSchema = options.schema ?? "public";
  const tables = createCoreTableNames(databaseSchema);
  const command = createSchemaCommandRunner(session, databaseSchema);
  const syncDeliveryAlarms = async (
    transaction: SqlExecutor,
    ids: readonly string[],
  ) => {
    if (!ids.length) return;
    await transaction.query(
      `DELETE FROM ${tables.owner_deadlines}
      WHERE owner='schema' AND source='deliveries' AND key=ANY($1::text[])`,
      [ids],
    );
    await transaction.query(
      `INSERT INTO ${tables.owner_deadlines} (owner,source,key,namespace,due_at,payload)
      SELECT 'schema','deliveries',d.id,e.namespace,
        CASE WHEN d.status='leased' THEN d.lease_expires_at ELSE d.available_at END,
        jsonb_build_object('deliveryId',d.id)
      FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
      WHERE d.id=ANY($1::text[]) AND ((d.status IN ('pending','retry_wait') AND d.attempts<d.max_attempts)
        OR (d.status='leased' AND d.lease_expires_at IS NOT NULL))
      ON CONFLICT (owner,source,key) DO UPDATE SET due_at=EXCLUDED.due_at,namespace=EXCLUDED.namespace,payload=EXCLUDED.payload,revision=EXCLUDED.revision`,
      [ids],
    );
  };
  const assertDeliveryEpoch = async (
    transaction: SqlExecutor,
    id: string,
    epoch: number,
  ): Promise<void> => {
    const future = await transaction.query(
      `SELECT id FROM ${tables.event_deliveries}
       WHERE id=$1 AND owner_epoch > $2::bigint LIMIT 1`,
      [id, epoch],
    );
    if (future.rows.length) {
      throw Object.assign(
        new Error(
          "Retained delivery authority is ahead of the current owner epoch.",
        ),
        { code: "delivery_future_epoch" },
      );
    }
  };

  const runCommand: typeof command = (kind, input, execute) =>
    command(kind, input, async (request, context) => {
      const result = await execute(request, context);
      if (kind.startsWith("delivery.")) {
        const id = (input as { id?: string }).id;
        const rows = (result as { rows?: Array<{ id?: string }> } | null)?.rows;
        const ids = id
          ? [id]
          : rows?.flatMap((row) => row.id ? [row.id] : []) ?? [];
        await syncDeliveryAlarms(context.transaction, ids);
      }
      return result;
    });
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const defaultLeaseMs = boundedInteger(options.leaseMs, 120_000, 0);
  const defaultMaxAttempts = boundedInteger(options.maxAttempts, 3, 1);
  const retryBaseMs = boundedInteger(options.retryBaseMs, 250, 0);
  const retryCapMs = boundedInteger(options.retryCapMs, 30_000, 0);
  const indexOperationEvent = options.indexOperationEvent;
  const indexOperationEventSql = options.indexOperationEventSql;

  const deliveriesForEvent = async (
    executor: SqlExecutor,
    eventId: string,
  ): Promise<readonly EventDelivery[]> => {
    const result = await executor.query<DeliveryRow>(
      `SELECT * FROM ${tables.event_deliveries}
       WHERE event_id = $1 ORDER BY created_at, id`,
      [eventId],
    );
    return result.rows.map((row) => mapDelivery(row, databaseSchema));
  };

  const duplicateResult = async <T>(
    executor: SqlExecutor,
    event: DurableEvent,
    options: CommitEventMutationOptions<T>,
  ): Promise<CommitEventMutationResult<T>> => {
    const encoded = encodeDraft(options.draft);
    assertDuplicateMatches(event, options.draft, encoded);
    const context = { transaction: executor, tables };
    const value = options.recoverDuplicate
      ? await options.recoverDuplicate(event, context)
      : undefined;
    const settlementScopeId = options.draft.settlementScopeId?.trim() ||
      event.id;
    await indexOperationEvent?.(executor, {
      namespace: event.namespace,
      operationId: settlementScopeId,
      eventId: event.id,
      position: event.position,
      correlationId: event.correlationId,
      createdAt: event.createdAt,
      metadata: event.metadata,
    });
    return ({
      value,
      event,
      deliveries: await deliveriesForEvent(executor, event.id),
      settlementScopeId,
      actionScopeId: options.draft.actionScopeId,
      deduplicated: true,
    } as const);
  };

  const loadDuplicate = (
    executor: SqlExecutor,
    namespace: string,
    deduplicationId: string,
  ) =>
    readEventByDeduplicationIdOn(executor, tables, namespace, deduplicationId);

  const commitMutation = async <T>(
    mutation: CommitEventMutationOptions<T>,
  ): Promise<CommitEventMutationResult<T>> => {
    validateDraft(mutation.draft);
    const draft = {
      ...mutation.draft,
      type: mutation.draft.type.trim(),
      namespace: mutation.draft.namespace.trim(),
      deduplicationId: mutation.draft.deduplicationId?.trim() || undefined,
    };
    const encoded = encodeDraft(draft);
    const consumers = uniqueConsumers(mutation.consumers);
    const eventId = mutation.eventId ?? createId();
    const settlementScopeId = draft.settlementScopeId?.trim() || eventId;
    const correlationId = draft.correlationId ?? eventId;
    const createdAt = (draft.createdAt ? new Date(draft.createdAt) : now())
      .toISOString();
    const maxAttempts = boundedInteger(
      mutation.maxAttempts,
      defaultMaxAttempts,
      1,
    );
    const normalized = { ...mutation, draft };

    const body = mutation.body
      ? { id: mutation.body.id, ...await encodeEventBody(mutation.body.json) }
      : undefined;

    // The event, deliveries, body, operation index and projection share the
    // transaction. An existing body is verified before that transaction can
    // commit, and a duplicate event returns its original durable result.
    const insertEvent = async (executor: SqlExecutor) => {
      const { commandTime } = schemaCommandContext(executor, databaseSchema);
      const params: unknown[] = [];
      const param = (value: unknown) => `$${params.push(value)}`;
      const commandTimeSql = `${param(commandTime)}::timestamptz`;
      const statement = mutation.statement?.(param, tables, { commandTime });
      const admission = options.admitOperationEventSql?.({
        namespace: draft.namespace,
        operationId: settlementScopeId,
        cancellationTerminal: mutation.admission?.cancellation === true,
      }, param);
      const cancelled = mutation.admission?.cancellation === true
        ? "TRUE"
        : admission?.cancelled ?? "FALSE";
      const lease = draft.deliveryLease;
      const insertGate = [
        "EXISTS (SELECT 1 FROM event_admission)",
        statement?.gate,
      ].filter(Boolean).map(
        (gate) => `(${gate})`,
      ).join(" AND ");
      const deliveryRows = consumers.map((consumer) => ({
        id: createId(),
        consumerId: consumer.consumerId,
        actionScopeId: consumer.settlement === "detached"
          ? null
          : draft.actionScopeId ?? null,
        scopeId: consumer.settlement === "detached"
          ? `detached:${eventId}:${consumer.consumerId}`
          : settlementScopeId,
      }));
      const values = [
        param(eventId),
        param(EVENT_SCHEMA_VERSION),
        param(draft.type),
        param(draft.namespace),
        param(draft.subject?.type ?? null),
        param(draft.subject?.id ?? null),
        `${param(encoded.payload.text)}::jsonb`,
        `${param(encoded.delta.text)}::jsonb`,
        `${param(encoded.metadata.text)}::jsonb`,
        param(draft.causationId ?? null),
        param(correlationId),
        param(draft.deduplicationId ?? null),
        `${param(createdAt)}::timestamptz`,
      ].join(", ");
      const ctes = [
        ...admission?.ctes ?? [],
        `event_operation_admission AS MATERIALIZED (SELECT 1 WHERE ${
          admission?.gate ?? "TRUE"
        })`,
        ...(lease
          ? [`event_delivery_admission AS MATERIALIZED (
          SELECT id FROM ${tables.event_deliveries}
          WHERE id = ${param(lease.deliveryId)} AND status = 'leased'
            AND lease_owner = ${
            param(lease.owner)
          } AND (lease_expires_at IS NULL OR lease_expires_at > ${commandTimeSql}) AND owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')
            AND EXISTS (SELECT 1 FROM event_operation_admission)
        )`]
          : []),
        `event_admission AS MATERIALIZED (SELECT 1 FROM ${
          lease ? "event_delivery_admission" : "event_operation_admission"
        })`,
        ...statement?.ctes ?? [],
        `owner_sequence AS (
          UPDATE ${tables.owner_epochs} SET last_seq=last_seq+1
          WHERE owner='schema' AND (${insertGate})
            AND NOT EXISTS (SELECT 1 FROM ${tables.events}
              WHERE namespace=${param(draft.namespace)} AND deduplication_id=${
          param(draft.deduplicationId ?? null)
        })
          RETURNING owner,last_seq
        )`,
        `inserted_event AS (
           INSERT INTO ${tables.events} (
             seq, id, schema_version, type, namespace,
             subject_type, subject_id, payload, delta,
             metadata, causation_id, correlation_id, deduplication_id, created_at
           ) SELECT owner_sequence.last_seq, ${values} FROM owner_sequence
           RETURNING *
         )`,
        `inserted_owner_sequence AS (
          INSERT INTO ${tables.owner_event_sequences} (owner,sequence,event_id)
          SELECT owner_sequence.owner,owner_sequence.last_seq,inserted_event.id
          FROM owner_sequence, inserted_event
        )`,
        `inserted_deliveries AS (
           INSERT INTO ${tables.event_deliveries} (
             id, event_id, consumer_id, settlement_scope_id, action_scope_id,
             status, attempts, max_attempts,
             available_at, created_at, updated_at, settled_at
           )
           SELECT delivery.id, inserted_event.id, delivery.consumer_id,
                  delivery.scope_id, delivery.action_scope_id, CASE WHEN ${cancelled} THEN 'cancelled' ELSE 'pending' END, 0, ${
          param(maxAttempts)
        }, ${commandTimeSql}, ${commandTimeSql}, ${commandTimeSql}, CASE WHEN ${cancelled} THEN ${commandTimeSql} ELSE NULL END
           FROM inserted_event, unnest(
             ${param(deliveryRows.map((row) => row.id))}::text[],
             ${param(deliveryRows.map((row) => row.consumerId))}::text[],
             ${param(deliveryRows.map((row) => row.scopeId))}::text[],
             ${param(deliveryRows.map((row) => row.actionScopeId))}::text[]
           ) AS delivery(id, consumer_id, scope_id, action_scope_id)
           RETURNING *
         )`,
      ];
      if (body) {
        ctes.push(`inserted_body AS (
           INSERT INTO ${tables.event_bodies} (
             namespace, event_body_id, schema_version, body, digest, created_at
           )
           SELECT ${param(draft.namespace)}, ${param(body.id)},
                  ${param(EVENT_BODY_SCHEMA_VERSION)}, ${
          param(body.body)
        }::jsonb,
                  ${param(body.digest)}, NOW()
           FROM inserted_event
           ON CONFLICT (namespace, event_body_id) DO NOTHING
           RETURNING event_body_id
         )`);
      }
      const indexInput = {
        namespace: draft.namespace,
        operationId: settlementScopeId,
        eventId,
        correlationId,
        createdAt,
        metadata: encoded.metadata.value as Record<string, unknown>,
      } as const;
      if (indexOperationEventSql) {
        ctes.push(indexOperationEventSql(indexInput, param));
      }
      ctes.push(...statement?.effects("inserted_event") ?? []);
      // Delivery rows come back as JSON because a statement returns one row
      // shape. With a statement, the row exists even when no event was
      // inserted, to carry its report.
      const inserted = await executor.query<
        EventRow & {
          deliveries: unknown;
          body_written?: boolean;
          statement_report?: unknown;
        }
      >(
        `WITH ${ctes.join(", ")}
         SELECT inserted_event.*, COALESCE(
           (SELECT jsonb_agg(to_jsonb(inserted_deliveries)) FROM inserted_deliveries),
           '[]'::jsonb
         ) AS deliveries${
          body ? ", EXISTS (SELECT 1 FROM inserted_body) AS body_written" : ""
        }${
          statement
            ? `, ${statement.report} AS statement_report
               FROM (SELECT 1) AS statement_row
               LEFT JOIN inserted_event ON TRUE`
            : " FROM inserted_event"
        }`,
        params,
      );
      const row = inserted.rows[0];
      const {
        deliveries: deliveryJson,
        body_written,
        statement_report: report,
        ...eventRow
      } = row ?? {};
      const outcome = statement
        ? (wasInserted: boolean) => statement.resolve(report, wasInserted)
        : undefined;
      if (!row || eventRow.id == null) return { outcome } as const;
      const event = mapEvent(eventRow as EventRow);
      if (body && !body_written) {
        // Verifies the existing row against this body, or throws.
        await writeEventBody({ transaction: executor, tables }, {
          namespace: draft.namespace,
          id: body.id,
          json: mutation.body!.json,
        });
      }
      if (!indexOperationEventSql) {
        await indexOperationEvent?.(executor, {
          ...indexInput,
          position: event.position,
          createdAt: event.createdAt,
        });
      }
      const deliveryById = new Map(
        (parseJsonRows(deliveryJson) as DeliveryRow[]).map((row) => [
          String(row.id),
          row,
        ]),
      );
      const deliveries: EventDelivery[] = deliveryRows.map((row) =>
        mapDelivery(deliveryById.get(row.id)!, databaseSchema)
      );
      return ({ inserted: { event, deliveries }, outcome } as const);
    };

    const runOn = async (
      executor: SqlExecutor,
    ): Promise<CommitEventMutationResult<T>> => {
      const { inserted, outcome } = await insertEvent(executor);
      if (!inserted) {
        const existing = draft.deduplicationId
          ? await loadDuplicate(
            executor,
            draft.namespace,
            draft.deduplicationId,
          )
          : null;
        if (existing) {
          return await duplicateResult(executor, existing, normalized);
        }
        outcome?.(false);
        throw new Error(`Event '${eventId}' was not inserted.`);
      }
      const value = mutation.mutate
        ? await mutation.mutate({ transaction: executor, tables })
        : outcome?.(true);
      return ({
        value,
        event: inserted.event,
        deliveries: inserted.deliveries,
        settlementScopeId,
        actionScopeId: draft.actionScopeId,
        deduplicated: false,
      } as const);
    };

    const remembered = (event: DurableEvent) => ({
      event,
      ...(body ? { body: { id: body.id, json: JSON.parse(body.body) } } : {}),
    });
    const commitOn = async (transaction: SqlExecutor) => {
      const gate = sqlCommitGate(transaction);
      const result = await runOn(transaction);
      if (!result.deduplicated) {
        await syncDeliveryAlarms(
          transaction,
          result.deliveries.map((delivery) => delivery.id),
        );
      }
      eventCommitGates.set(result.event, gate);
      if (!result.deduplicated) {
        const selectionKeys = (indexOperationEvent || indexOperationEventSql)
          ? (await transaction.query<{ selection_key: string }>(
            `SELECT selection_key FROM "${databaseSchema}"."copilotz_operation_selections" WHERE namespace=$1 AND operation_id=$2 ORDER BY selection_key`,
            [result.event.namespace, result.settlementScopeId],
          )).rows.map((row) => row.selection_key)
          : [];
        stageOwnerChange(transaction, databaseSchema, {
          namespace: result.event.namespace,
          operationId: result.settlementScopeId,
          selectionKeys,
          kind: "event",
          seq: result.event.seq,
          event: result.event,
        });
        afterSqlCommit(transaction, () => {
          boundedSet(recentEvents, result.event.id, remembered(result.event));
        });
      }
      return result;
    };
    if (mutation.transaction) {
      assertSchemaCommandTransaction(mutation.transaction, databaseSchema);
      return await commitOn(mutation.transaction);
    }
    try {
      return await runCommand("events.append", {
        eventId,
      }, (_request, context) => commitOn(context.transaction));
    } catch (error) {
      // A concurrent insert can win after the statement's snapshot. Its
      // uniqueness failure rolls back this transaction; reread once in a new
      // transaction to return the recorded duplicate or semantic conflict.
      if (mutation.mutate || !isUniqueViolation(error)) throw error;
      return await runCommand("events.append", {
        eventId,
      }, (_request, context) => commitOn(context.transaction));
    }
  };

  // Events and event bodies are immutable, so a bounded copy of the events
  // this store just committed spares their local consumers a re-read.
  type RecentEvent = Readonly<{
    event: DurableEvent;
    body?: { id: string; json: unknown };
  }>;
  const recentEvents = new Map<string, RecentEvent>();
  const boundedSet = (
    map: Map<string, RecentEvent>,
    id: string,
    value: RecentEvent,
  ): void => {
    map.set(id, value);
    if (map.size > RECENT_EVENT_LIMIT) map.delete(map.keys().next().value!);
  };
  const recentEventBody = (
    eventId: string,
    eventBodyId: string,
  ): Readonly<{ json: unknown }> | undefined => {
    const body = recentEvents.get(eventId)?.body;
    return body?.id === eventBodyId
      ? { json: structuredClone(body.json) }
      : undefined;
  };

  const getEvent = async (id: string): Promise<DurableEvent | null> => {
    const recent = recentEvents.get(id)?.event;
    if (recent) return structuredClone(recent);
    const result = await session.query<EventRow>(
      `SELECT * FROM ${tables.events} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  };

  const getDelivery = async (
    id: string,
    executor: SqlExecutor = session,
  ): Promise<EventDelivery | null> => {
    const result = await executor.query<DeliveryRow>(
      `SELECT * FROM ${tables.event_deliveries} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  const claimDelivery = async (claim: {
    id: string;
    owner: string;
    leaseMs?: number;
    localExecution?: boolean;
  }): Promise<EventDelivery | null> => {
    const leaseMs = boundedInteger(claim.leaseMs, defaultLeaseMs, 0);
    const params: unknown[] = [
      claim.id,
      claim.owner,
      claim.localExecution === true ? null : leaseMs,
    ];
    const result = await runCommand(
      "delivery.claim",
      claim,
      async (_input, context) => {
        await assertDeliveryEpoch(
          context.transaction,
          params[0] as string,
          context.caller.epoch,
        );
        return await context.transaction.query<DeliveryRow>(
          `UPDATE ${tables.event_deliveries}
       SET status = 'leased', attempts = attempts + 1, owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'),
           lease_owner = $2,
           lease_expires_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE $4::timestamptz + ($3 * INTERVAL '1 millisecond') END,
           updated_at = $4::timestamptz, settled_at = NULL
       WHERE id = $1 AND attempts < max_attempts
         AND (
           (status IN ('pending', 'retry_wait') AND available_at <= $4::timestamptz)
           OR (status = 'leased' AND (lease_expires_at <= $4::timestamptz OR owner_epoch <> (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')))
         )
       RETURNING *`,
          [...params, context.commandTime],
        );
      },
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  type SettleDelivery = (
    update: (transaction: SqlExecutor) => Promise<EventDelivery | null>,
  ) => Promise<EventDelivery | null>;

  const deliveryCommand = async <Input, Output>(
    kind: string,
    input: Input,
    handler: (
      input: Input,
      transaction: SqlExecutor,
      settle: SettleDelivery,
    ) => Promise<Output>,
  ): Promise<Output> => {
    const publications: Array<() => Promise<void>> = [];
    const result = await runCommand(
      kind,
      input,
      (command, context) =>
        handler(command, context.transaction, async (update) => {
          const settled = await update(context.transaction);
          if (
            settled &&
            ["succeeded", "cancelled", "dead_letter"].includes(settled.status)
          ) {
            const publish = await options.settleActionOwners?.(
              context.transaction,
              settled,
            );
            if (publish) publications.push(publish);
            if (options.settleActionOwners) {
              const event = await context.transaction.query<
                { namespace: string }
              >(`SELECT namespace FROM ${tables.events} WHERE id=$1`, [
                settled.eventId,
              ]);
              const namespace = event.rows[0]?.namespace ?? null;
              await writeOwnerDeadline(context.transaction, databaseSchema, {
                source: "reconciliation",
                key: reconciliationAlarmKey("schema", {
                  kind: "operation",
                  namespace,
                  id: settled.settlementScopeId,
                }),
                namespace,
                dueAt: context.commandTime,
                payload: { operationId: settled.settlementScopeId },
              });
            }
          }
          return settled;
        }),
    );
    for (const publish of publications) await publish();
    return result;
  };

  const settleDelivery = async (
    id: string,
    status: Extract<DeliveryStatus, "succeeded" | "cancelled">,
    owner?: string,
  ): Promise<EventDelivery | null> => {
    return await deliveryCommand(
      "delivery.settle",
      { id, status, owner },
      async (_input, transaction, settle) => {
        const current = await getDelivery(id, transaction);
        if (!current) return null;
        const { commandTime } = schemaCommandContext(
          transaction,
          databaseSchema,
        );
        const params: unknown[] = [id, status, commandTime];
        const ownerFilter = owner
          ? `AND lease_owner = $${
            params.push(owner)
          } AND (lease_expires_at IS NULL OR lease_expires_at > $3::timestamptz) AND owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')`
          : "";
        const allowed = status === "succeeded"
          ? "status = 'leased'"
          : "status IN ('pending', 'leased', 'retry_wait')";
        return await settle(async (transaction) => {
          const result = await transaction.query<DeliveryRow>(
            `UPDATE ${tables.event_deliveries}
         SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = $3::timestamptz, settled_at = $3::timestamptz
         WHERE id = $1 AND ${allowed} ${ownerFilter} RETURNING *`,
            params,
          );
          return result.rows[0]
            ? mapDelivery(result.rows[0], databaseSchema)
            : null;
        });
      },
    );
  };

  // Candidate reads are hints; claim commands recheck their captured clock.
  const listRecoverable = async (
    listOptions: {
      namespace?: string;
      consumerIds?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<readonly EventDelivery[]> => {
    const conditions = [
      `((d.status IN ('pending', 'retry_wait') AND d.available_at <= NOW())
        OR (d.status = 'leased' AND (d.lease_expires_at <= NOW() OR d.owner_epoch <> (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))))`,
      "d.attempts < d.max_attempts",
    ];
    const params: unknown[] = [];
    if (listOptions.namespace) {
      params.push(listOptions.namespace);
      conditions.push(`e.namespace = $${params.length}`);
    }
    const consumerFilter = filtersForConsumers(
      "d",
      listOptions.consumerIds,
      params,
    );
    if (consumerFilter) conditions.push(consumerFilter);
    params.push(boundedInteger(listOptions.limit, 100, 1));
    const result = await session.query<DeliveryRow>(
      `SELECT d.* FROM ${tables.event_deliveries} d
       JOIN ${tables.events} e ON e.id = d.event_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.available_at, d.created_at, d.id
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => mapDelivery(row, databaseSchema));
  };

  const claimNext = async (claim: {
    owner: string;
    namespace?: string;
    consumerIds?: readonly string[];
    leaseMs?: number;
  }): Promise<EventDelivery | null> => {
    const leaseMs = boundedInteger(claim.leaseMs, defaultLeaseMs, 0);
    const result = await runCommand(
      "delivery.claimNext",
      claim,
      async (_input, context) => {
        const owner = claim.owner;
        const params: unknown[] = [context.commandTime];
        const conditions = [
          `((d.status IN ('pending', 'retry_wait') AND d.available_at <= $1::timestamptz)
        OR (d.status = 'leased' AND (d.lease_expires_at <= $1::timestamptz OR d.owner_epoch <> (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))))`,
          "d.attempts < d.max_attempts",
        ];
        if (claim.namespace) {
          params.push(claim.namespace);
          conditions.push(`e.namespace = $${params.length}`);
        }
        const consumerFilter = filtersForConsumers(
          "d",
          claim.consumerIds,
          params,
        );
        if (consumerFilter) conditions.push(consumerFilter);

        // Inspect the same ordered candidate before replacing its authority.
        // The owner fence serializes this read and its exact-PK update.
        const epochParam = `$${params.push(context.caller.epoch)}`;
        const selected = await context.transaction.query<
          { id: string; future_epoch: boolean }
        >(
          `SELECT d.id,d.owner_epoch > ${epochParam}::bigint AS future_epoch
        FROM ${tables.event_deliveries} d
        JOIN ${tables.events} e ON e.id = d.event_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY d.available_at, d.created_at, d.id
        LIMIT 1`,
          params,
        );
        const candidate = selected.rows[0];
        if (!candidate) return { rows: [] };
        if (candidate.future_epoch) {
          throw Object.assign(
            new Error(
              "Retained delivery authority is ahead of the current owner epoch.",
            ),
            { code: "delivery_future_epoch" },
          );
        }
        return await context.transaction.query<DeliveryRow>(
          `UPDATE ${tables.event_deliveries} AS d
      SET status = 'leased', attempts = d.attempts + 1, owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'),
          lease_owner = $1,
          lease_expires_at = $3::timestamptz + ($2 * INTERVAL '1 millisecond'),
          updated_at = $3::timestamptz, settled_at = NULL
      WHERE d.id = $4 AND d.owner_epoch <= $5::bigint
      RETURNING d.*`,
          [
            owner,
            leaseMs,
            context.commandTime,
            candidate.id,
            context.caller.epoch,
          ],
        );
      },
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  return {
    executionAuthority: () =>
      runCommand(
        "execution.authority",
        {},
        (_input, context) => ({
          epoch: context.caller.epoch,
          signal: context.signal,
        }),
      ),
    databaseSchema,
    session: options.session,
    tables,
    commitMutation,
    append(draft, consumerIds = [], appendOptions = {}) {
      return commitMutation({
        draft,
        consumers: consumerIds.map((consumerId) => ({
          consumerId,
          settlement: "inherit",
        })),
        maxAttempts: appendOptions.maxAttempts,
      });
    },
    getEvent,
    recentEventBody,
    getEventByDeduplicationId(namespace, deduplicationId) {
      return loadDuplicate(session, namespace, deduplicationId);
    },
    async listEvents(listOptions, executor = session) {
      const conditions = ["namespace = $1"];
      const params: unknown[] = [listOptions.namespace];
      if (listOptions.metadata) {
        assertJsonValue(listOptions.metadata, {
          label: "Event metadata filter",
          maxDepth: 16,
          maxNodes: 256,
        });
        const filter = encodeJson(listOptions.metadata, "metadata filter").text;
        if (filter.length > 16384) {
          throw new TypeError("Event metadata filter exceeds 16 KiB.");
        }
        params.push(filter);
        conditions.push(`metadata @> $${params.length}::jsonb`);
      }
      if (listOptions.correlationId) {
        params.push(listOptions.correlationId);
        conditions.push(`correlation_id = $${params.length}`);
      }
      if (listOptions.afterSeq !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(listOptions.afterSeq)) {
          throw new TypeError("Invalid owner sequence cursor.");
        }
        params.push(listOptions.afterSeq);
        conditions.push(`seq > $${params.length}::bigint`);
      }
      if (listOptions.afterPosition) {
        params.push(listOptions.afterPosition);
        conditions.push(`position > $${params.length}::bigint`);
      }
      params.push(boundedInteger(listOptions.limit, 1_000, 1));
      const order = listOptions.order === "desc" ? "DESC" : "ASC";
      const result = await executor.query<EventRow>(
        `SELECT * FROM ${tables.events}
         WHERE ${conditions.join(" AND ")}
         ORDER BY position ${order} LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(mapEvent);
    },
    getDelivery,
    async listDeliveries(listOptions = {}) {
      if (listOptions.ids?.length === 0) return [];
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (listOptions.ids) {
        params.push(listOptions.ids);
        conditions.push(`d.id = ANY($${params.length}::text[])`);
      }
      if (listOptions.namespace) {
        params.push(listOptions.namespace);
        conditions.push(`e.namespace = $${params.length}`);
      }
      if (listOptions.eventId) {
        params.push(listOptions.eventId);
        conditions.push(`d.event_id = $${params.length}`);
      }
      if (listOptions.consumerId) {
        params.push(listOptions.consumerId);
        conditions.push(`d.consumer_id = $${params.length}`);
      }
      if (listOptions.settlementScopeId) {
        params.push(listOptions.settlementScopeId);
        conditions.push(`d.settlement_scope_id = $${params.length}`);
      }
      if (listOptions.status) {
        params.push(listOptions.status);
        conditions.push(`d.status = $${params.length}`);
      }
      params.push(boundedInteger(listOptions.limit, 1_000, 1));
      const result = await session.query<DeliveryRow>(
        `SELECT d.* FROM ${tables.event_deliveries} d
         JOIN ${tables.events} e ON e.id = d.event_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY d.created_at, d.id LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => mapDelivery(row, databaseSchema));
    },
    claimDelivery,
    claimNext,
    async heartbeatDelivery(heartbeat) {
      const leaseMs = boundedInteger(
        heartbeat.leaseMs,
        defaultLeaseMs,
        0,
      );
      const result = await runCommand(
        "delivery.heartbeat",
        heartbeat,
        (_input, context) =>
          context.transaction.query<{ id: string }>(
            `UPDATE ${tables.event_deliveries}
         SET lease_expires_at = $4::timestamptz + ($3 * INTERVAL '1 millisecond'),
             updated_at = $4::timestamptz
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2
           AND lease_expires_at > $4::timestamptz AND owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')
         RETURNING id`,
            [heartbeat.id, heartbeat.owner, leaseMs, context.commandTime],
          ),
      );
      return result.rows.length === 1;
    },
    async heartbeatDeliveries(attempts) {
      if (!attempts.length || attempts.length > 256) {
        throw new RangeError("Heartbeat batch must contain 1 to 256 attempts.");
      }
      const captured = attempts.map((attempt) => ({
        ...attempt,
        leaseMs: boundedInteger(attempt.leaseMs, defaultLeaseMs, 1),
      }));
      if (
        new Set(captured.map(({ id, owner }) => JSON.stringify([id, owner])))
          .size !== captured.length
      ) throw new TypeError("Heartbeat batch repeats an attempt.");
      const result = await runCommand(
        "delivery.heartbeatBatch",
        captured,
        async (attempts, context) => {
          const live: DeliveryAttemptHeartbeat[] = [];
          for (const attempt of attempts) {
            if (attempt.ownerEpoch !== context.caller.epoch) continue;
            try {
              await assertOwnerInvocationLive(context, {
                databaseSchema,
                namespace: attempt.namespace,
                operationCatalog: options.admitOperationEventSql
                  ? { admitEventSql: options.admitOperationEventSql }
                  : undefined,
                operationId: attempt.operationId,
                eventId: attempt.eventId,
                writer: { deliveryId: attempt.id, leaseOwner: attempt.owner },
              });
              live.push(attempt);
            } catch (error) {
              if (!(error instanceof ActionOwnershipLost)) throw error;
            }
          }
          return await context.transaction.query<{ id: string; owner: string }>(
            `UPDATE ${tables.event_deliveries} AS delivery
           SET lease_expires_at=$4::timestamptz + requested.lease_ms * INTERVAL '1 millisecond', updated_at=$4::timestamptz
           FROM unnest($1::text[],$2::text[],$3::bigint[]) AS requested(id,owner,lease_ms)
           WHERE delivery.id=requested.id AND delivery.lease_owner=requested.owner
             AND delivery.status='leased' AND delivery.lease_expires_at > $4::timestamptz
             AND delivery.owner_epoch=(SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')
           RETURNING delivery.id,delivery.lease_owner AS owner`,
            [
              live.map((a) => a.id),
              live.map((a) => a.owner),
              live.map((a) => a.leaseMs),
              context.commandTime,
            ],
          );
        },
      );
      return result.rows;
    },
    succeedDelivery(id, owner) {
      return settleDelivery(id, "succeeded", owner);
    },
    cancelDelivery(id, owner) {
      return settleDelivery(id, "cancelled", owner);
    },
    async failDelivery(failure) {
      return await deliveryCommand(
        "delivery.fail",
        failure,
        async (failure, transaction, settle) => {
          const { commandTime } = schemaCommandContext(
            transaction,
            databaseSchema,
          );
          const current = await getDelivery(failure.id, transaction);
          if (
            !current || current.status !== "leased" ||
            current.leaseOwner !== failure.owner
          ) return null;
          const exponential = Math.min(
            retryCapMs,
            retryBaseMs * (2 ** Math.max(0, current.attempts - 1)),
          );
          const jitter = Math.min(1, Math.max(0, random()));
          const backoffMs = boundedInteger(
            failure.backoffMs,
            Math.floor(exponential * jitter),
            0,
          );
          const retryable = failure.retryable ??
            errorRetryability(failure.error) ?? true;
          return await settle(async (transaction) => {
            const result = await transaction.query<DeliveryRow>(
              `UPDATE ${tables.event_deliveries}
         SET status = CASE WHEN $5 = FALSE OR attempts >= max_attempts
                           THEN 'dead_letter' ELSE 'retry_wait' END,
             available_at = CASE WHEN $5 = FALSE OR attempts >= max_attempts
               THEN available_at
               ELSE $6::timestamptz + ($3 * INTERVAL '1 millisecond') END,
             lease_owner = NULL, lease_expires_at = NULL,
             last_error = $4::jsonb, updated_at = $6::timestamptz,
             settled_at = CASE WHEN $5 = FALSE OR attempts >= max_attempts
               THEN $6::timestamptz ELSE NULL END
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2
           AND (lease_expires_at IS NULL OR lease_expires_at > $6::timestamptz) AND owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')
         RETURNING *`,
              [
                failure.id,
                failure.owner,
                backoffMs,
                JSON.stringify(serializeError(failure.error, retryable)),
                retryable,
                commandTime,
              ],
            );
            return result.rows[0]
              ? mapDelivery(result.rows[0], databaseSchema)
              : null;
          });
        },
      );
    },
    listRecoverable,
    async recoverExpiredDeliveries(recovery = {}) {
      // This read is advisory; every exhaustion write rechecks inside its command.
      const candidates = await session.query<DeliveryRow>(
        `SELECT d.* FROM ${tables.event_deliveries} AS d
         JOIN ${tables.events} AS e ON e.id = d.event_id
         WHERE d.status = 'leased' AND (d.lease_expires_at <= NOW() OR d.owner_epoch <> (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))
           AND d.attempts >= d.max_attempts
           AND ($1::text IS NULL OR e.namespace = $1)
         ORDER BY d.lease_expires_at, d.id LIMIT $2`,
        [recovery.namespace ?? null, boundedInteger(recovery.limit, 100, 1)],
      );
      const recovered: EventDelivery[] = [];
      for (const row of candidates.rows) {
        const delivery = await deliveryCommand("delivery.exhaust", {
          id: row.id,
        }, async (input, transaction, settle) => {
          const { commandTime, caller } = schemaCommandContext(
            transaction,
            databaseSchema,
          );
          await assertDeliveryEpoch(transaction, input.id, caller.epoch);
          const current = await getDelivery(input.id, transaction);
          if (!current) return null;
          return await settle(async (transaction) => {
            const result = await transaction.query<DeliveryRow>(
              `UPDATE ${tables.event_deliveries}
             SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
               last_error = $2::jsonb, updated_at = $3::timestamptz, settled_at = $3::timestamptz
             WHERE id = $1 AND status = 'leased' AND (lease_expires_at <= $3::timestamptz OR owner_epoch <> (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))
               AND attempts >= max_attempts RETURNING *`,
              [
                row.id,
                JSON.stringify({
                  name: "DeliveryLeaseExpired",
                  message:
                    "The delivery lease expired after its final attempt.",
                }),
                commandTime,
              ],
            );
            return result.rows[0]
              ? mapDelivery(result.rows[0], databaseSchema)
              : null;
          });
        });
        if (delivery) recovered.push(delivery);
      }
      return recovered;
    },
    async deferDeliveryPlacement(id, delayMs) {
      await command(
        "alarm.deliveryPlacement",
        { id, delayMs },
        async (_input, context) => {
          const delivery = await getDelivery(id, context.transaction);
          if (
            !delivery || !["pending", "retry_wait"].includes(delivery.status)
          ) return;
          const event = await context.transaction.query<{ namespace: string }>(
            `SELECT namespace FROM ${tables.events} WHERE id=$1`,
            [delivery.eventId],
          );
          await writeOwnerDeadline(context.transaction, databaseSchema, {
            source: "deliveries",
            key: id,
            namespace: event.rows[0]?.namespace ?? null,
            dueAt: new Date(
              Math.max(
                Date.parse(delivery.availableAt),
                Date.parse(context.commandTime) + Math.max(1, delayMs),
              ),
            ).toISOString(),
            payload: { deliveryId: id },
          });
        },
      );
    },
    async scopeSettlement(namespace, settlementScopeId) {
      const params: unknown[] = [namespace, settlementScopeId];
      const result = await session.query<{
        unsettled: string | number;
        dead_letters: string | number;
        cancelled: string | number;
        succeeded: string | number;
      }>(
        `WITH scoped AS (
           SELECT d.status
           FROM ${tables.event_deliveries} d
           JOIN ${tables.events} e ON e.id = d.event_id
           WHERE e.namespace = $1 AND d.settlement_scope_id = $2
         )
         SELECT
           COUNT(*) FILTER (WHERE status IN ('pending', 'leased', 'retry_wait')) AS unsettled,
           COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letters,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
           COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded
         FROM scoped`,
        params,
      );
      const row = result.rows[0];
      return ({
        unsettled: Number(row?.unsettled ?? 0),
        deadLetters: Number(row?.dead_letters ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
        succeeded: Number(row?.succeeded ?? 0),
      });
    },
    async scopeOutstanding(namespace, settlementScopeId) {
      const params: unknown[] = [namespace, settlementScopeId];
      // The existing (scope, status) index can skip successful history before
      // the namespace join. A caller-supplied scope may span namespaces.
      const result = await session.query<{
        unsettled: string | number;
        dead_letters: string | number;
        cancelled: string | number;
      }>(
        `WITH scoped AS (
           SELECT d.status
           FROM ${tables.event_deliveries} d
           JOIN ${tables.events} e ON e.id = d.event_id
           WHERE e.namespace = $1 AND d.settlement_scope_id = $2
             AND d.status IN (
               'pending', 'leased', 'retry_wait', 'dead_letter', 'cancelled'
             )
         )
         SELECT
           COUNT(*) FILTER (WHERE status IN ('pending', 'leased', 'retry_wait')) AS unsettled,
           COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letters,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
         FROM scoped`,
        params,
      );
      const row = result.rows[0];
      return ({
        unsettled: Number(row?.unsettled ?? 0),
        deadLetters: Number(row?.dead_letters ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
      });
    },
    async cancelScope(namespace, settlementScopeId, reason) {
      let afterCommit!: (() => Promise<void>) | void;
      const result = await runCommand(
        "delivery.cancelScope",
        { namespace, settlementScopeId, reason },
        async (_input, { transaction, commandTime }) => {
          const cancelled = await transaction.query<{ id: string }>(
            `UPDATE ${tables.event_deliveries} AS delivery
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             last_error = $3::jsonb, updated_at = $4::timestamptz, settled_at = $4::timestamptz
           FROM ${tables.events} AS event
           WHERE delivery.event_id = event.id AND event.namespace = $1
             AND delivery.settlement_scope_id = $2 AND delivery.status IN ('pending','leased','retry_wait')
           RETURNING delivery.id`,
            [
              namespace,
              settlementScopeId,
              JSON.stringify({ reason: reason ?? "cancelled" }),
              commandTime,
            ],
          );
          await syncDeliveryAlarms(
            transaction,
            cancelled.rows.map((row) => row.id),
          );
          afterCommit = await options.onScopeCancellation?.(transaction, {
            namespace,
            operationId: settlementScopeId,
            reason: reason ?? "cancelled",
          });
          return cancelled.rows.length;
        },
      );
      await afterCommit?.();
      return result;
    },
    async compactDeliveries(compactOptions = {}) {
      if (compactOptions.retentionMs === null) {
        return { deliveries: 0 };
      }
      const retentionMs = boundedInteger(
        compactOptions.retentionMs,
        7 * 24 * 60 * 60 * 1_000,
        0,
      );
      const cutoff = new Date(
        (compactOptions.now ?? now()).getTime() - retentionMs,
      ).toISOString();
      const limit = Math.min(
        MAX_COMPACTION_LIMIT,
        boundedInteger(
          compactOptions.limit,
          DEFAULT_COMPACTION_LIMIT,
          1,
        ),
      );
      return await runCommand(
        "delivery.compact",
        { cutoff, limit },
        async (_input, { transaction }) => {
          const deliveries = await transaction.query<{ id: string }>(
            `WITH candidates AS (
             SELECT delivery.id
             FROM ${tables.events} AS event
             JOIN ${tables.event_deliveries} AS delivery
               ON delivery.event_id = event.id
             WHERE event.created_at < $1::timestamptz
               AND delivery.status IN ('succeeded', 'cancelled')
               AND NOT EXISTS (
                 SELECT 1 FROM ${tables.open_actions} AS action
                 WHERE action.action_run_id = delivery.action_scope_id
                   AND action.namespace = event.namespace
               )
               AND NOT EXISTS (
                 SELECT 1 FROM ${tables.event_deliveries} active
                 WHERE active.event_id = event.id
                   AND active.status IN (
                     'pending', 'leased', 'retry_wait', 'dead_letter'
                   )
               )
             ORDER BY event.position, delivery.created_at, delivery.id
             LIMIT $2
           )
           DELETE FROM ${tables.event_deliveries} AS delivery
           USING candidates
           WHERE delivery.id = candidates.id
           RETURNING delivery.id`,
            [cutoff, limit],
          );
          return {
            deliveries: deliveries.rows.length,
          };
        },
      );
    },
  };
}

export { serializeError };

/** Internal joined owner work reads the existing event through its current executor. */
export async function readEventByDeduplicationIdOn(
  executor: SqlExecutor,
  tables: EventStore["tables"],
  namespace: string,
  deduplicationId: string,
): Promise<DurableEvent | null> {
  const result = await executor.query<EventRow>(
    `SELECT * FROM ${tables.events} WHERE namespace = $1 AND deduplication_id = $2 LIMIT 1`,
    [namespace, deduplicationId],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}
