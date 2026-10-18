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
  quoteEventIdentifier,
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

type EventRow = Record<string, unknown> & {
  id: string;
  position: string | number | bigint;
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
  consumers: readonly DurableConsumerObligation[];
  maxAttempts?: number;
  /** Runtime-owned lifecycle admission, never derived from event metadata. */
  admission?: Readonly<{ openActionGroup?: boolean; cancellation?: boolean }>;
  /** Join an already-open SQL transaction instead of opening a nested one. */
  transaction?: SqlExecutor;
  /** An event body written by the event's own statement. */
  body?: Readonly<{ id: string; json: unknown }>;
  /**
   * Writes and checks that commit in the event's own statement. They keep a
   * mutation a single autocommitted statement.
   */
  statement?(
    param: (value: unknown) => string,
    tables: EventMutationContext["tables"],
  ): EventStatement<T>;
  /**
   * Writes that commit with the event. Without them (and without a joined
   * transaction) the event commits as one autocommitted statement.
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

/** Internal command-local authority; never sourced from event metadata.
 * Delivery lease owners must be unique host-issued dispatchAttemptIds, never
 * reusable worker IDs. The command's authorize hook must revalidate the current
 * assignment, including on receipt replay. Token reuse is not safe recovery. */
export type OwnerEventCommitContext = Readonly<{
  transaction: SqlExecutor;
  ownerId: string;
  epoch: number;
  holderId: string;
  commandTime: string;
  /** Internal owner-controlled attempt, never inferred from transport or a NULL lease.
   * Exact delivery/token authority is valid only under this command's epoch fence. */
  ownerAttempt?: Readonly<{ deliveryId: string; attemptId: string }>;
  /** Required before delivery mutations; insertion-only callers may omit it. */
  afterCommit?(callback: () => void | Promise<void>): void;
}>;

/** Internal exact lost-attempt transition. The owner recovery command must first
 * prove prior-epoch assignment/claim authority and effect-safe disposition. This
 * data selects one row; it does not establish that a lost attempt is replay-safe. */
export type OwnerLostDeliveryTransition = Readonly<{
  namespace: string;
  id: string;
  eventId: string;
  consumerId: string;
  settlementScopeId: string;
  actionScopeId?: string;
  leaseOwner: string;
  leaseExpiresAt: string | null;
  attempts: number;
  maxAttempts: number;
  disposition: "retry" | "exhausted" | "cancelled";
}>;

export type CreateEventStoreOptions = {
  ownerCommit?: OwnerEventCommitContext;
  session: SqlSession;
  schema?: string;
  createId?: () => string;
  now?: () => Date;
  random?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  /** Acquired before delivery rows, matching event admission's lock order. */
  lockSettlementScope?(
    transaction: SqlExecutor,
    operationId: string,
  ): Promise<void>;
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
  /** Read-only catalog format preflight, before duplicate recovery callbacks. */
  assertOperationCatalog?(executor: SqlExecutor): Promise<void>;
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
  /** Confirms that an event committed in a joined transaction is durable. */
  confirmCommitted?(eventId: string): void;
  getEventByDeduplicationId(
    namespace: string,
    deduplicationId: string,
  ): Promise<DurableEvent | null>;
  listEvents(options: {
    namespace: string;
    metadata?: Readonly<Record<string, unknown>>;
    correlationId?: string;
    afterPosition?: string;
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
  /** Owner-only exact prior-attempt transition; never grants execution authority. */
  recoverLostDelivery(
    transition: OwnerLostDeliveryTransition,
  ): Promise<EventDelivery | null>;
  nextRecoveryDelayMs(): Promise<number | null>;
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
    ...(row.owner_id == null ? {} : { ownerId: String(row.owner_id) }),
    ...(row.seq == null ? {} : { seq: String(row.seq) }),
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

/** Creates the immutable-event and durable-delivery persistence boundary. */
export function createEventStore(
  options: CreateEventStoreOptions,
): EventStore {
  const owner = options.ownerCommit ? { ...options.ownerCommit } : undefined;
  const ownerAttempt = owner?.ownerAttempt
    ? { ...owner.ownerAttempt }
    : undefined;
  if (
    owner?.ownerAttempt !== undefined && (
      !ownerAttempt || Object.keys(ownerAttempt).length !== 2 ||
      [ownerAttempt.deliveryId, ownerAttempt.attemptId].some((value) =>
        typeof value !== "string" || !value.trim() || value !== value.trim() ||
        value.length > 1024
      )
    )
  ) throw new TypeError("Invalid owner-controlled delivery attempt.");
  const ownerUnsupported = (operation: string): never => {
    throw createEventStoreError(
      "event_transaction_unavailable",
      `Owner command event store does not support ${operation}.`,
    );
  };
  // Even consumers of store.session stay inside the command capability. There
  // is no ambient transaction fallback or nested transaction publication.
  const session: SqlSession = owner
    ? {
      query: (sql, params) => owner.transaction.query(sql, params),
      transaction: () => ownerUnsupported("nested transactions"),
    }
    : options.session;
  const databaseSchema = options.schema ?? "public";
  const tables = createCoreTableNames(databaseSchema);
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const defaultLeaseMs = boundedInteger(options.leaseMs, 120_000, 0);
  const defaultMaxAttempts = boundedInteger(options.maxAttempts, 3, 1);
  const retryBaseMs = boundedInteger(options.retryBaseMs, 250, 0);
  const retryCapMs = boundedInteger(options.retryCapMs, 30_000, 0);
  const lockSettlementScope = options.lockSettlementScope;
  const settleActionOwners = options.settleActionOwners;
  const assertOperationCatalog = options.assertOperationCatalog;
  const indexOperationEvent = options.indexOperationEvent;
  const indexOperationEventSql = options.indexOperationEventSql;
  const commandTimestamp = (params: unknown[]): string =>
    owner ? `$${params.push(owner.commandTime)}::timestamptz` : "NOW()";
  const ownerDeliveryExecutor = async (
    requirePublication = true,
  ): Promise<SqlExecutor> => {
    if (!owner) return session;
    if (requirePublication && typeof owner.afterCommit !== "function") {
      return ownerUnsupported("delivery mutations without afterCommit");
    }
    const fence = await owner.transaction.query(
      `SELECT owner FROM ${quoteEventIdentifier(databaseSchema)}."owner_epochs"
       WHERE owner = $1 AND epoch = $2 AND holder = $3 FOR UPDATE`,
      [owner.ownerId, owner.epoch, owner.holderId],
    );
    if (!fence.rows.length) {
      throw Object.assign(new Error("Owner delivery authority was lost."), {
        name: "ActionOwnershipLost",
        code: "ActionOwnershipLost",
      });
    }
    return owner.transaction;
  };
  const deliveryMutationExecutor = (
    attempt: string | undefined,
    deliveryId?: string,
  ): Promise<SqlExecutor> => {
    if (owner && !ownerAttempt) {
      return ownerUnsupported("delivery mutation without exact owner attempt");
    }
    if (
      ownerAttempt &&
      (deliveryId !== ownerAttempt.deliveryId ||
        attempt !== ownerAttempt.attemptId)
    ) {
      return ownerUnsupported("a different owner delivery attempt");
    }
    if (owner && (typeof attempt !== "string" || !attempt.trim())) {
      return ownerUnsupported("delivery mutations without an attempt token");
    }
    return ownerDeliveryExecutor();
  };

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
    await assertOperationCatalog?.(executor);
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

  const loadDuplicate = async (
    executor: SqlExecutor,
    namespace: string,
    deduplicationId: string,
  ): Promise<DurableEvent | null> => {
    const result = await executor.query<EventRow>(
      `SELECT * FROM ${tables.events}
       WHERE namespace = $1 AND deduplication_id = $2 LIMIT 1`,
      [namespace, deduplicationId],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  };

  const commitMutation = async <T>(
    mutation: CommitEventMutationOptions<T>,
  ): Promise<CommitEventMutationResult<T>> => {
    if (owner && mutation.transaction !== owner.transaction) {
      throw new Error(
        "Owner event writes must join their command transaction.",
      );
    }
    validateDraft(mutation.draft);
    const draft = {
      ...mutation.draft,
      type: mutation.draft.type.trim(),
      namespace: mutation.draft.namespace.trim(),
      deduplicationId: mutation.draft.deduplicationId?.trim() || undefined,
      deliveryLease: mutation.draft.deliveryLease
        ? { ...mutation.draft.deliveryLease }
        : undefined,
    };
    if (owner && !ownerAttempt && draft.deliveryLease) {
      return ownerUnsupported(
        "delivery-bound append without exact owner attempt",
      );
    }
    if (ownerAttempt) {
      if (
        draft.deliveryLease?.deliveryId !== ownerAttempt.deliveryId ||
        draft.deliveryLease?.owner !== ownerAttempt.attemptId
      ) {
        throw Object.assign(
          new Error("Event mutation requires its exact owner attempt."),
          {
            name: "ActionOwnershipLost",
            code: "ActionOwnershipLost",
          },
        );
      }
      const executor = await ownerDeliveryExecutor(false);
      const current = await executor.query(
        `SELECT id FROM ${tables.event_deliveries}
         WHERE id=$1 AND status='leased' AND lease_owner=$2
           AND lease_expires_at IS NULL FOR UPDATE`,
        [ownerAttempt.deliveryId, ownerAttempt.attemptId],
      );
      if (!current.rows.length) {
        throw Object.assign(new Error("Local event authority was lost."), {
          name: "ActionOwnershipLost",
          code: "ActionOwnershipLost",
        });
      }
    }
    const encoded = encodeDraft(draft);
    const consumers = uniqueConsumers(mutation.consumers);
    const eventId = createId();
    const settlementScopeId = draft.settlementScopeId?.trim() || eventId;
    const correlationId = draft.correlationId ?? eventId;
    const createdAt =
      (owner
        ? new Date(owner.commandTime)
        : draft.createdAt
        ? new Date(draft.createdAt)
        : now())
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

    // One statement inserts the event, its deliveries, body, operation index,
    // and the mutation's own writes, which its gate admits along with the
    // event. The dedup unique index arbitrates retries: a duplicate inserts
    // nothing and is then read back. `tolerant` lets an existing body row
    // through for verification; outside a transaction it must fail the
    // statement instead, so that nothing commits.
    const insertEvent = async (executor: SqlExecutor, tolerant: boolean) => {
      const params: unknown[] = [];
      const param = (value: unknown) => `$${params.push(value)}`;
      const statement = mutation.statement?.(param, tables);
      const admission = options.admitOperationEventSql?.({
        namespace: draft.namespace,
        operationId: settlementScopeId,
        requireScope: mutation.admission?.openActionGroup === true,
        cancellationTerminal: mutation.admission?.cancellation === true,
      }, param);
      const cancelled = mutation.admission?.cancellation === true
        ? "TRUE"
        : admission?.cancelled ?? "FALSE";
      const group = draft.actionScopeId?.trim();
      const openingGroup = mutation.admission?.openActionGroup === true;
      const groupCtes = group && !openingGroup
        ? [`admitted_action_group AS MATERIALIZED (
        SELECT action_run_id FROM ${tables.open_actions}
        WHERE namespace = ${param(draft.namespace)} AND action_run_id = ${
          param(group)
        }
          AND scope_id = ${param(settlementScopeId)}
          AND state = 'deferred' AND EXISTS (SELECT 1 FROM event_operation_admission)
        FOR UPDATE
      )`]
        : [];
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
      const commandTimestamp = owner
        ? `${param(owner.commandTime)}::timestamptz`
        : "NOW()";
      const sequenceGate = owner
        ? `EXISTS (SELECT 1 FROM owner_event_sequence)`
        : "TRUE";
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
        ...(owner
          ? [
            param(owner.ownerId),
            "(SELECT last_seq FROM owner_event_sequence)",
          ]
          : []),
      ].join(", ");
      const ctes = [
        ...admission?.ctes ?? [],
        `event_operation_admission AS MATERIALIZED (SELECT 1 WHERE ${
          admission?.gate ?? "TRUE"
        })`,
        ...groupCtes,
        `event_group_admission AS MATERIALIZED (SELECT 1 FROM event_operation_admission ${
          group && !openingGroup
            ? `WHERE EXISTS (SELECT 1 FROM admitted_action_group) OR ${cancelled}`
            : ""
        })`,
        ...(lease
          ? [`event_delivery_admission AS MATERIALIZED (
          SELECT id FROM ${tables.event_deliveries}
          WHERE id = ${param(lease.deliveryId)} AND status = 'leased'
            AND lease_owner = ${param(lease.owner)} AND ${
            ownerAttempt
              ? "lease_expires_at IS NULL"
              : `lease_expires_at > ${commandTimestamp}`
          }
            AND EXISTS (SELECT 1 FROM event_group_admission) FOR UPDATE
        )`]
          : []),
        `event_admission AS MATERIALIZED (SELECT 1 FROM ${
          lease ? "event_delivery_admission" : "event_group_admission"
        })`,
        ...statement?.ctes ?? [],
        ...(owner
          ? [`owner_event_sequence AS (
          UPDATE ${quoteEventIdentifier(databaseSchema)}."owner_epochs"
          SET last_seq = last_seq + 1
          WHERE owner = ${param(owner.ownerId)} AND epoch = ${
            param(owner.epoch)
          }
            AND holder = ${param(owner.holderId)} AND (${insertGate || "TRUE"})
            AND NOT EXISTS (
              SELECT 1 FROM ${tables.events}
              WHERE namespace = ${param(draft.namespace)}
                AND deduplication_id = ${param(draft.deduplicationId ?? null)}
            )
          RETURNING last_seq
        )`]
          : []),
        `inserted_event AS (
           INSERT INTO ${tables.events} (
             id, schema_version, type, namespace,
             subject_type, subject_id, payload, delta,
             metadata, causation_id, correlation_id, deduplication_id, created_at${
          owner ? ", owner_id, seq" : ""
        }
           ) ${
          insertGate
            ? `SELECT ${values} WHERE (${insertGate}) AND ${sequenceGate}`
            : `VALUES (${values})`
        }
           ON CONFLICT (namespace, deduplication_id)
             WHERE deduplication_id IS NOT NULL DO NOTHING
           RETURNING *
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
        }, ${commandTimestamp}, ${commandTimestamp}, ${commandTimestamp}, CASE WHEN ${cancelled} THEN ${commandTimestamp} ELSE NULL END
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
                  ${param(body.digest)}, ${commandTimestamp}
           FROM inserted_event
           ${
          tolerant ? "ON CONFLICT (namespace, event_body_id) DO NOTHING" : ""
        }
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
      tolerant: boolean,
    ): Promise<CommitEventMutationResult<T>> => {
      const { inserted, outcome } = await insertEvent(executor, tolerant);
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
    // A joined transaction may still roll back, so its event is only held
    // until the caller confirms the commit.
    if (mutation.transaction) {
      const result = await runOn(mutation.transaction, true);
      if (!result.deduplicated) {
        boundedSet(pendingEvents, result.event.id, remembered(result.event));
      }
      return result;
    }
    const committed = async () => {
      if (mutation.mutate) {
        return await session.transaction((transaction) =>
          runOn(transaction, true)
        );
      }
      try {
        return await runOn(session, false);
      } catch (error) {
        // An existing body row failed the statement; nothing committed.
        if (!isUniqueViolation(error)) throw error;
        return await session.transaction((transaction) =>
          runOn(transaction, true)
        );
      }
    };
    const result = await committed();
    if (!result.deduplicated) {
      boundedSet(recentEvents, result.event.id, remembered(result.event));
    }
    return result;
  };

  // Events and event bodies are immutable, so a bounded copy of the events
  // this store just committed spares their local consumers a re-read.
  type RecentEvent = Readonly<{
    event: DurableEvent;
    body?: { id: string; json: unknown };
  }>;
  const recentEvents = new Map<string, RecentEvent>();
  const pendingEvents = new Map<string, RecentEvent>();
  const boundedSet = (
    map: Map<string, RecentEvent>,
    id: string,
    value: RecentEvent,
  ): void => {
    map.set(id, value);
    if (map.size > RECENT_EVENT_LIMIT) map.delete(map.keys().next().value!);
  };
  const confirmCommitted = (eventId: string): void => {
    const pending = pendingEvents.get(eventId);
    if (!pending) return;
    pendingEvents.delete(eventId);
    boundedSet(recentEvents, eventId, pending);
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
    const recent = owner ? undefined : recentEvents.get(id)?.event;
    if (recent) return structuredClone(recent);
    const result = await session.query<EventRow>(
      `SELECT * FROM ${tables.events} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  };

  const getDelivery = async (id: string): Promise<EventDelivery | null> => {
    const result = await session.query<DeliveryRow>(
      `SELECT * FROM ${tables.event_deliveries} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  const claimDelivery = async (claim: {
    id: string;
    owner: string;
    leaseMs?: number;
  }): Promise<EventDelivery | null> => {
    const executor = await deliveryMutationExecutor(claim.owner, claim.id);
    if (ownerAttempt && claim.leaseMs !== undefined) {
      return ownerUnsupported("per-job lease duration");
    }
    const leaseMs = ownerAttempt
      ? undefined
      : boundedInteger(claim.leaseMs, defaultLeaseMs, 0);
    const params: unknown[] = ownerAttempt
      ? [claim.id, claim.owner]
      : [claim.id, claim.owner, leaseMs];
    const timestamp = commandTimestamp(params);
    const result = await executor.query<DeliveryRow>(
      `UPDATE ${tables.event_deliveries}
       SET status = 'leased', attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = ${
        ownerAttempt ? "NULL" : `${timestamp} + ($3 * INTERVAL '1 millisecond')`
      },
           updated_at = ${timestamp}, settled_at = NULL
       WHERE id = $1 AND attempts < max_attempts
         AND (
           (status IN ('pending', 'retry_wait') AND available_at <= ${timestamp})
           ${
        ownerAttempt
          ? ""
          : `OR (status = 'leased' AND lease_expires_at <= ${timestamp})`
      }
         )
       RETURNING *`,
      params,
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  const commitDeliverySettlement = async (
    current: EventDelivery,
    update: (transaction: SqlExecutor) => Promise<EventDelivery | null>,
    schedulePublication = owner?.afterCommit,
  ): Promise<EventDelivery | null> => {
    if (owner) {
      await lockSettlementScope?.(
        owner.transaction,
        current.settlementScopeId,
      );
      const result = await update(owner.transaction);
      if (
        result &&
        ["succeeded", "cancelled", "dead_letter"].includes(result.status)
      ) {
        const publish = await settleActionOwners?.(
          owner.transaction,
          result,
        );
        if (publish) schedulePublication!(publish);
      }
      return result;
    }
    if (!settleActionOwners) return await update(session);
    let afterCommit: (() => Promise<void>) | undefined;
    const settled = await session.transaction(async (transaction) => {
      await lockSettlementScope?.(
        transaction,
        current.settlementScopeId,
      );
      const result = await update(transaction);
      if (
        result &&
        ["succeeded", "cancelled", "dead_letter"].includes(result.status)
      ) {
        afterCommit = await settleActionOwners(transaction, result) ??
          undefined;
      }
      return result;
    });
    await afterCommit?.();
    return settled;
  };

  const settleDelivery = async (
    id: string,
    status: Extract<DeliveryStatus, "succeeded" | "cancelled">,
    leaseOwner?: string,
  ): Promise<EventDelivery | null> => {
    if (owner && !leaseOwner) {
      return ownerUnsupported("delivery settlement without an attempt token");
    }
    await deliveryMutationExecutor(leaseOwner, id);
    const current = await getDelivery(id);
    if (!current) return null;
    const params: unknown[] = [id, status];
    const timestamp = commandTimestamp(params);
    const ownerFilter = leaseOwner
      ? `AND lease_owner = $${params.push(leaseOwner)} AND ${
        ownerAttempt
          ? "lease_expires_at IS NULL"
          : `lease_expires_at > ${timestamp}`
      }`
      : "";
    const allowed = status === "succeeded" || ownerAttempt
      ? "status = 'leased'"
      : "status IN ('pending', 'leased', 'retry_wait')";
    return await commitDeliverySettlement(current, async (transaction) => {
      const result = await transaction.query<DeliveryRow>(
        `UPDATE ${tables.event_deliveries}
         SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ${timestamp}, settled_at = ${timestamp}
         WHERE id = $1 AND ${allowed} ${ownerFilter} RETURNING *`,
        params,
      );
      return result.rows[0]
        ? mapDelivery(result.rows[0], databaseSchema)
        : null;
    });
  };

  const listRecoverable = async (
    listOptions: {
      namespace?: string;
      consumerIds?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<readonly EventDelivery[]> => {
    const params: unknown[] = [];
    const timestamp = commandTimestamp(params);
    const conditions = [
      `((d.status IN ('pending', 'retry_wait') AND d.available_at <= ${timestamp})
        OR (d.status = 'leased' AND d.lease_expires_at <= ${timestamp}))`,
      "d.attempts < d.max_attempts",
    ];
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
    if (owner) return ownerUnsupported("owner claimNext");
    const executor = await deliveryMutationExecutor(claim.owner);
    const leaseMs = boundedInteger(claim.leaseMs, defaultLeaseMs, 0);
    const params: unknown[] = [claim.owner, leaseMs];
    const timestamp = commandTimestamp(params);
    const conditions = [
      `((d.status IN ('pending', 'retry_wait') AND d.available_at <= ${timestamp})
        OR (d.status = 'leased' AND d.lease_expires_at <= ${timestamp}))`,
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

    const result = await executor.query<DeliveryRow>(
      `WITH candidate AS (
        SELECT d.id FROM ${tables.event_deliveries} d
        JOIN ${tables.events} e ON e.id = d.event_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY d.available_at, d.created_at, d.id
        FOR UPDATE OF d SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${tables.event_deliveries} AS d
      SET status = 'leased', attempts = d.attempts + 1,
          lease_owner = $1,
          lease_expires_at = ${timestamp} + ($2 * INTERVAL '1 millisecond'),
          updated_at = ${timestamp}, settled_at = NULL
      FROM candidate
      WHERE d.id = candidate.id
      RETURNING d.*`,
      params,
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  return {
    databaseSchema,
    session,
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
    confirmCommitted,
    getEventByDeduplicationId(namespace, deduplicationId) {
      return loadDuplicate(session, namespace, deduplicationId);
    },
    async listEvents(listOptions, executor = session) {
      if (owner && executor !== session && executor !== owner.transaction) {
        return ownerUnsupported("reads outside the command transaction");
      }
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
      if (owner) return ownerUnsupported("owner heartbeat");
      const executor = await deliveryMutationExecutor(heartbeat.owner);
      const leaseMs = boundedInteger(
        heartbeat.leaseMs,
        defaultLeaseMs,
        0,
      );
      const params: unknown[] = [heartbeat.id, heartbeat.owner, leaseMs];
      const timestamp = commandTimestamp(params);
      const result = await executor.query<{ id: string }>(
        `UPDATE ${tables.event_deliveries}
         SET lease_expires_at = ${timestamp} + ($3 * INTERVAL '1 millisecond'),
             updated_at = ${timestamp}
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2
           AND lease_expires_at > ${timestamp}
         RETURNING id`,
        params,
      );
      return result.rows.length === 1;
    },
    succeedDelivery(id, owner) {
      return settleDelivery(id, "succeeded", owner);
    },
    cancelDelivery(id, owner) {
      return settleDelivery(id, "cancelled", owner);
    },
    async failDelivery(failure) {
      await deliveryMutationExecutor(failure.owner, failure.id);
      const current = await getDelivery(failure.id);
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
      const params: unknown[] = [
        failure.id,
        failure.owner,
        backoffMs,
        JSON.stringify(serializeError(failure.error, retryable)),
        retryable,
      ];
      const timestamp = commandTimestamp(params);
      return await commitDeliverySettlement(current, async (transaction) => {
        const result = await transaction.query<DeliveryRow>(
          `UPDATE ${tables.event_deliveries}
         SET status = CASE WHEN $5 = FALSE OR attempts >= max_attempts
                           THEN 'dead_letter' ELSE 'retry_wait' END,
             available_at = CASE WHEN $5 = FALSE OR attempts >= max_attempts
               THEN available_at
               ELSE ${timestamp} + ($3 * INTERVAL '1 millisecond') END,
             lease_owner = NULL, lease_expires_at = NULL,
             last_error = $4::jsonb, updated_at = ${timestamp},
             settled_at = CASE WHEN $5 = FALSE OR attempts >= max_attempts
               THEN ${timestamp} ELSE NULL END
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2
           AND ${
            ownerAttempt
              ? "lease_expires_at IS NULL"
              : `lease_expires_at > ${timestamp}`
          }
         RETURNING *`,
          params,
        );
        return result.rows[0]
          ? mapDelivery(result.rows[0], databaseSchema)
          : null;
      });
    },
    listRecoverable,
    async recoverExpiredDeliveries(recovery = {}) {
      if (owner) {
        return ownerUnsupported("expiry recovery in the owner path");
      }
      // Only the remaining non-owner legacy executor performs timed recovery.
      const executor = session;
      const limit = boundedInteger(recovery.limit, 100, 1);
      const params: unknown[] = [
        recovery.namespace ?? null,
        limit,
      ];
      const timestamp = commandTimestamp(params);
      const candidates = await executor.query<DeliveryRow>(
        `SELECT d.* FROM ${tables.event_deliveries} AS d
         JOIN ${tables.events} AS e ON e.id = d.event_id
         WHERE d.status = 'leased' AND d.lease_expires_at <= ${timestamp}
           AND d.attempts >= d.max_attempts
           AND ($1::text IS NULL OR e.namespace = $1)
         ORDER BY d.lease_expires_at, d.id LIMIT $2`,
        params,
      );
      const recovered: EventDelivery[] = [];
      for (const row of candidates.rows) {
        const delivery = await commitDeliverySettlement(
          mapDelivery(row, databaseSchema),
          async (transaction) => {
            const params: unknown[] = [
              row.id,
              JSON.stringify({
                name: "DeliveryLeaseExpired",
                message: "The delivery lease expired after its final attempt.",
              }),
            ];
            const timestamp = commandTimestamp(params);
            const result = await transaction.query<DeliveryRow>(
              `UPDATE ${tables.event_deliveries}
             SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
               last_error = $2::jsonb, updated_at = ${timestamp}, settled_at = ${timestamp}
             WHERE id = $1 AND status = 'leased' AND lease_expires_at <= ${timestamp}
               AND attempts >= max_attempts RETURNING *`,
              params,
            );
            return result.rows[0]
              ? mapDelivery(result.rows[0], databaseSchema)
              : null;
          },
        );
        if (delivery) recovered.push(delivery);
      }
      return recovered;
    },
    async recoverLostDelivery(input) {
      // This method is deliberately unavailable to legacy stores and to a live
      // attempt capability. A worker receives neither SQL nor this method.
      if (!owner || ownerAttempt) {
        return ownerUnsupported("lost-attempt recovery without owner control");
      }
      const transition = { ...input };
      const required = [
        "namespace",
        "id",
        "eventId",
        "consumerId",
        "settlementScopeId",
        "leaseOwner",
        "leaseExpiresAt",
        "attempts",
        "maxAttempts",
        "disposition",
      ];
      const expected = transition.actionScopeId === undefined
        ? required
        : [...required, "actionScopeId"];
      if (
        Object.keys(transition).sort().join(",") !==
          expected.sort().join(",") ||
        [
          transition.namespace,
          transition.id,
          transition.eventId,
          transition.consumerId,
          transition.settlementScopeId,
          transition.leaseOwner,
          transition.actionScopeId ?? "scope",
        ]
          .some((value) =>
            typeof value !== "string" || !value.trim() ||
            value !== value.trim() || value.length > 1024
          ) ||
        (transition.leaseExpiresAt !== null && (
          typeof transition.leaseExpiresAt !== "string" ||
          transition.leaseExpiresAt.length > 128 ||
          !Number.isFinite(Date.parse(transition.leaseExpiresAt))
        )) ||
        !Number.isSafeInteger(transition.attempts) || transition.attempts < 1 ||
        !Number.isSafeInteger(transition.maxAttempts) ||
        transition.maxAttempts < 1 ||
        !["retry", "exhausted", "cancelled"].includes(transition.disposition)
      ) throw new TypeError("Invalid lost delivery transition.");
      if (
        typeof lockSettlementScope !== "function" ||
        (transition.disposition !== "retry" &&
          typeof settleActionOwners !== "function")
      ) {
        return ownerUnsupported(
          "lost-attempt recovery without canonical settlement hooks",
        );
      }
      await ownerDeliveryExecutor();
      const current = await getDelivery(transition.id);
      if (!current) return null;
      return await commitDeliverySettlement(current, async (transaction) => {
        const params: unknown[] = [
          transition.id,
          transition.eventId,
          transition.consumerId,
          transition.settlementScopeId,
          transition.actionScopeId ?? null,
          transition.leaseOwner,
          transition.leaseExpiresAt,
          transition.attempts,
          transition.maxAttempts,
          transition.namespace,
          owner.ownerId,
        ];
        const timestamp = commandTimestamp(params);
        const retry = transition.disposition === "retry";
        const status = retry
          ? "retry_wait"
          : transition.disposition === "cancelled"
          ? "cancelled"
          : "dead_letter";
        const attemptCondition = retry
          ? "attempts < max_attempts"
          : transition.disposition === "exhausted"
          ? "attempts >= max_attempts"
          : "TRUE";
        const error = transition.disposition === "exhausted"
          ? `$${
            params.push(JSON.stringify({
              name: transition.leaseExpiresAt === null
                ? "AttemptLost"
                : "DeliveryLeaseExpired",
              message: transition.leaseExpiresAt === null
                ? "The delivery attempt was lost after its final attempt."
                : "The delivery lease was lost after its final attempt.",
            }))
          }::jsonb`
          : "";
        // Do not fabricate expiry or backoff. In particular, availability,
        // attempts and max_attempts are unchanged; only the next genuine claim
        // consumes an attempt. The old lease may still have time remaining.
        const result = await transaction.query<DeliveryRow>(
          `UPDATE ${tables.event_deliveries} AS d
           SET status = '${status}', lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ${timestamp}, settled_at = ${
            retry ? "NULL" : timestamp
          }
             ${error ? `,last_error = ${error}` : ""}
           WHERE d.id=$1 AND d.event_id=$2 AND d.consumer_id=$3
             AND d.settlement_scope_id=$4 AND d.action_scope_id IS NOT DISTINCT FROM $5::text
             AND d.status='leased' AND d.lease_owner=$6
             AND d.lease_expires_at IS NOT DISTINCT FROM $7::timestamptz
             AND d.attempts=$8 AND d.max_attempts=$9 AND ${attemptCondition}
             AND EXISTS(SELECT 1 FROM ${tables.events} e WHERE e.id=d.event_id
               AND e.namespace=$10 AND e.owner_id=$11)
           RETURNING d.*`,
          params,
        );
        return result.rows[0]
          ? mapDelivery(result.rows[0], databaseSchema)
          : null;
      });
    },
    async nextRecoveryDelayMs() {
      const params: unknown[] = [];
      const timestamp = commandTimestamp(params);
      // Keep an empty queue's NULL so recovery can stop; clamp due work below.
      const result = await session.query<{
        delay_ms: string | number | null;
      }>(
        `SELECT EXTRACT(EPOCH FROM (
           MIN(CASE WHEN status = 'leased' THEN lease_expires_at ELSE available_at END)
           - ${timestamp}
         )) * 1000 AS delay_ms
         FROM ${tables.event_deliveries}
         WHERE status = 'leased'
            OR (status IN ('pending', 'retry_wait') AND attempts < max_attempts)`,
        params,
      );
      const value = result.rows[0]?.delay_ms;
      return value == null ? null : Math.max(0, Number(value));
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
      if (owner) return ownerUnsupported("scope cancellation");
      let afterCommit: (() => Promise<void>) | undefined;
      const result = await session.transaction(async (transaction) => {
        await lockSettlementScope?.(transaction, settlementScopeId);
        const cancelled = await transaction.query<{ id: string }>(
          `UPDATE ${tables.event_deliveries} AS delivery
           SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             last_error = $3::jsonb, updated_at = NOW(), settled_at = NOW()
           FROM ${tables.events} AS event
           WHERE delivery.event_id = event.id AND event.namespace = $1
             AND delivery.settlement_scope_id = $2 AND delivery.status IN ('pending','leased','retry_wait')
           RETURNING delivery.id`,
          [
            namespace,
            settlementScopeId,
            JSON.stringify({ reason: reason ?? "cancelled" }),
          ],
        );
        afterCommit = await options.onScopeCancellation?.(transaction, {
          namespace,
          operationId: settlementScopeId,
          reason: reason ?? "cancelled",
        }) ?? undefined;
        return cancelled.rows.length;
      });
      await afterCommit?.();
      return result;
    },
    async compactDeliveries(compactOptions = {}) {
      if (owner) return ownerUnsupported("delivery compaction");
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
      return await session.transaction(async (transaction) => {
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
             FOR UPDATE OF delivery SKIP LOCKED
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
      });
    },
  };
}

export { serializeError };
