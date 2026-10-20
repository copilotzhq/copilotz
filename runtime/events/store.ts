import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { ActionError, standardActionError } from "../actions/errors.ts";
import {
  ownerIngressEvidence,
  type OwnerIngressProof,
} from "../application/ingress/authority.ts";
import { canonicalJson as encodeCanonicalJson } from "../data-only-json.ts";
import { ActionOwnershipLost } from "../actions/ownership.ts";
import { assertOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import {
  invalidateOwnerAlarm,
  reconciliationAlarmKey,
  writeOwnerDeadline,
} from "../engine/alarms.ts";
import {
  assertSchemaCommandTransaction,
  bindSchemaOwner,
  createSchemaCommandRunner,
  createSchemaExecutionAuthority,
  schemaCommandContext,
} from "../engine/commands.ts";
import { stageOwnerChange } from "./push.ts";
import { afterSqlCommit } from "./session.ts";
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
  owner_ingress:
    | import("../actions/protected-action-types.ts").ProtectedActionIngress
    | null;
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
  /** The statement creates or changes catalog content deadlines. */
  invalidatesContent?: boolean;
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
  collectionChange?: import("./push.ts").OwnerChange["collectionChange"];
  onCommitted?(result: CommitEventMutationResult<T>): void | Promise<void>;
  /** Private admission facts; never accepted from an Event draft. */
  ingress?: OwnerIngressProof;
  /** Owner-local admission can claim its own delivery before publishing it. */
  initialLocalClaim?: Readonly<{ consumerId: string; owner: string }>;
  /** Trusted remote admission, bound to an accepted worker session. */
  initialRemoteClaim?: Readonly<
    {
      consumerId: string;
      owner: string;
      leaseMs: number;
      assertCurrent(): void;
    }
  >;
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
  /** Owner-verified normalization of derived metadata for exact credential replay. */
  replayMetadata?(
    event: DurableEvent,
    context: EventMutationContext,
  ): Promise<Readonly<Record<string, unknown>>>;
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
  publication?: Promise<import("./coordinator.ts").EventDispatchReport>;
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
   * event is indexed by its own insert statement. Includes `updated_selections`,
   * returning each selection_key written by the index.
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
  /** Bounded accepted-session batch; caller binds current transport authority. */
  heartbeatDeliveries(
    attempts: readonly DeliveryAttemptHeartbeat[],
    accept?: (attempt: DeliveryAttemptHeartbeat, epoch: number) => boolean,
  ): Promise<readonly Pick<DeliveryAttemptHeartbeat, "id" | "owner">[]>;
  readRemoteClaim(
    id: string,
    owner: string,
    consume?: boolean,
  ): Promise<EventDelivery | null>;
  readLocalClaim(
    id: string,
    owner: string,
    consume?: boolean,
  ): Promise<EventDelivery | null>;
  /** Settles a leased delivery and returns the row it settled into. */
  succeedDelivery(
    id: string,
    owner: string,
    transaction?: SqlExecutor,
  ): Promise<EventDelivery | null>;
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

const canonicalJson = (value: unknown): string =>
  encodeCanonicalJson(value, { order: "locale", objectOrder: true });

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
    ...(row.owner_ingress ? { ownerIngress: row.owner_ingress } : {}),
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

function serializeError(
  error: unknown,
  retryable?: boolean,
): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const safe = error instanceof ActionError
      ? standardActionError(error)
      : isOwnerAuthorizationRefusal(error) &&
          code === "action_authorization_refused"
      ? standardActionError({ code: "forbidden", status: 403 })
      : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" && code.trim() ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(safe
        ? {
          callerSafe: true,
          code: safe.code,
          name: safe.name,
          status: safe.status,
          message: safe.message,
        }
        : {}),
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
  const { session } = options;
  const databaseSchema = options.schema ?? "public";
  const tables = createCoreTableNames(databaseSchema);
  const acquireOwner = bindSchemaOwner(session, databaseSchema);
  const localInstance = crypto.randomUUID();
  const unstartedClaims = new Map<string, string>();
  let observingClaims = false;
  const command = createSchemaCommandRunner(
    session,
    databaseSchema,
    acquireOwner,
  );
  const syncDeliveryAlarms = async (
    transaction: SqlExecutor,
    ids: readonly string[],
  ) => {
    if (!ids.length) return;
    invalidateOwnerAlarm(transaction, databaseSchema);
    afterSqlCommit(transaction, () => {
      for (const id of ids) unstartedClaims.delete(id);
    });
    await transaction.query(
      `WITH due AS (
        SELECT d.id,e.namespace,
          CASE WHEN d.status='leased' THEN d.lease_expires_at ELSE d.available_at END AS due_at
        FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
        WHERE d.id=ANY($1::text[]) AND ((d.status IN ('pending','retry_wait') AND d.attempts<d.max_attempts)
          OR (d.status='leased' AND d.lease_expires_at IS NOT NULL))
      ), removed AS (
        DELETE FROM ${tables.owner_deadlines} WHERE owner='schema' AND source='deliveries'
          AND key=ANY($1::text[]) AND key NOT IN (SELECT id FROM due)
      )
      INSERT INTO ${tables.owner_deadlines} (owner,source,key,namespace,due_at,payload)
      SELECT 'schema','deliveries',id,namespace,due_at,jsonb_build_object('deliveryId',id) FROM due
      ON CONFLICT (owner,source,key) DO UPDATE SET due_at=EXCLUDED.due_at,namespace=EXCLUDED.namespace,payload=EXCLUDED.payload,revision=EXCLUDED.revision`,
      [ids],
    );
  };
  const runCommand = command;
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
    encoded: EncodedDraft,
  ): Promise<CommitEventMutationResult<T>> => {
    const context = { transaction: executor, tables };
    const metadata = options.replayMetadata
      ? await options.replayMetadata(event, context)
      : undefined;
    assertDuplicateMatches(
      event,
      options.draft,
      metadata
        ? {
          ...encoded,
          metadata: encodeJson(metadata, "metadata"),
        }
        : encoded,
    );
    const value = options.recoverDuplicate
      ? await options.recoverDuplicate(event, context)
      : undefined;
    const settlementScopeId = options.draft.settlementScopeId?.trim() ||
      event.id;
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
    const ingress = ownerIngressEvidence(mutation.ingress);
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
    const initialClaim = mutation.initialLocalClaim ??
      mutation.initialRemoteClaim;

    const body = mutation.body
      ? { id: mutation.body.id, ...await encodeEventBody(mutation.body.json) }
      : undefined;

    // The event, deliveries, body, operation index and projection share the
    // transaction. An existing body is verified before that transaction can
    // commit, and a duplicate event returns its original durable result.
    let insertedSelectionKeys: string[] | undefined;
    const insertEvent = async (executor: SqlExecutor) => {
      const { commandTime } = schemaCommandContext(executor, databaseSchema);
      const authority = initialClaim ? await acquireOwner() : undefined;
      const initialClaimOwner = authority
        ? `${authority.holderId}:${authority.epoch}:${localInstance}:${
          initialClaim!.owner
        }`
        : null;
      mutation.initialRemoteClaim?.assertCurrent();
      const params: unknown[] = [];
      const param = (value: unknown) => `$${params.push(value)}`;
      const commandTimeSql = `${param(commandTime)}::timestamptz`;
      const statement = mutation.statement?.(param, tables, { commandTime });
      if (statement?.invalidatesContent) {
        invalidateOwnerAlarm(executor, databaseSchema, "content");
      }
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
        `${param(JSON.stringify(ingress ?? null))}::jsonb`,
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
             metadata, owner_ingress, causation_id, correlation_id, deduplication_id, created_at
           ) SELECT owner_sequence.last_seq, ${values} FROM owner_sequence
           RETURNING *
         )`,
        `inserted_deliveries AS (
           INSERT INTO ${tables.event_deliveries} (
             id, event_id, consumer_id, settlement_scope_id, action_scope_id,
             status, attempts, max_attempts, owner_epoch, lease_owner, lease_expires_at,
             available_at, created_at, updated_at, settled_at
           )
           SELECT delivery.id, inserted_event.id, delivery.consumer_id,
                  delivery.scope_id, delivery.action_scope_id, CASE WHEN ${cancelled} THEN 'cancelled' WHEN delivery.consumer_id=${
          param(initialClaim?.consumerId ?? null)
        } THEN 'leased' ELSE 'pending' END, CASE WHEN NOT ${cancelled} AND delivery.consumer_id=${
          param(initialClaim?.consumerId ?? null)
        } THEN 1 ELSE 0 END, ${
          param(maxAttempts)
        }, (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'), CASE WHEN NOT ${cancelled} AND delivery.consumer_id=${
          param(initialClaim?.consumerId ?? null)
        } THEN ${
          param(initialClaimOwner)
        } ELSE NULL END, CASE WHEN NOT ${cancelled} AND delivery.consumer_id=${
          param(mutation.initialRemoteClaim?.consumerId ?? null)
        } THEN ${commandTimeSql} + ${
          param(mutation.initialRemoteClaim?.leaseMs ?? 0)
        } * INTERVAL '1 millisecond' ELSE NULL END, ${commandTimeSql}, ${commandTimeSql}, ${commandTimeSql}, CASE WHEN ${cancelled} THEN ${commandTimeSql} ELSE NULL END
           FROM inserted_event, unnest(
             ${param(deliveryRows.map((row) => row.id))}::text[],
             ${param(deliveryRows.map((row) => row.consumerId))}::text[],
             ${param(deliveryRows.map((row) => row.scopeId))}::text[],
             ${param(deliveryRows.map((row) => row.actionScopeId))}::text[]
           ) AS delivery(id, consumer_id, scope_id, action_scope_id)
           RETURNING *
         )`,
      ];
      ctes.push(`inserted_delivery_deadlines AS (
        INSERT INTO ${tables.owner_deadlines} (owner,source,key,namespace,due_at,payload)
        SELECT 'schema','deliveries',id,${
        param(draft.namespace)
      },COALESCE(lease_expires_at,available_at),
          jsonb_build_object('deliveryId',id)
        FROM inserted_deliveries WHERE (status='pending' AND attempts<max_attempts) OR (status='leased' AND lease_expires_at IS NOT NULL)
      )`);
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
          selection_keys?: string[];
          body_written?: boolean;
          statement_report?: unknown;
        }
      >(
        `WITH ${ctes.join(", ")}
         SELECT inserted_event.*, COALESCE(
           (SELECT jsonb_agg(to_jsonb(inserted_deliveries)) FROM inserted_deliveries),
           '[]'::jsonb
         ) AS deliveries${
          indexOperationEventSql
            ? `,
           ARRAY(SELECT selection_key FROM (
             SELECT selection_key FROM "${databaseSchema}"."copilotz_operation_selections"
               WHERE namespace=${param(draft.namespace)} AND operation_id=${
              param(settlementScopeId)
            }
             UNION SELECT selection_key FROM updated_selections
           ) AS selections ORDER BY selection_key) AS selection_keys`
            : ""
        }${
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
        selection_keys,
        body_written,
        statement_report: report,
        ...eventRow
      } = row ?? {};
      const outcome = statement
        ? (wasInserted: boolean) => statement.resolve(report, wasInserted)
        : undefined;
      if (!row || eventRow.id == null) return { outcome } as const;
      insertedSelectionKeys = selection_keys;
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
      const operationMetadata = draft.metadata?.operationMetadata as
        | Record<string, unknown>
        | undefined;
      if (
        (indexOperationEvent || indexOperationEventSql) &&
        typeof operationMetadata?.httpAdmissionKey === "string"
      ) {
        // The HTTP preflight is only a hint. The owner serializes the cap with
        // root admission, including inline completions and compatible replay.
        const group = {
          operationMetadata: {
            httpAdmissionKey: operationMetadata.httpAdmissionKey,
            ...(operationMetadata.actorId !== undefined
              ? { actorId: operationMetadata.actorId }
              : {}),
          },
        };
        const capacity = await executor.query<{ allowed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${tables.events} WHERE namespace=$1 AND deduplication_id=$3)
            OR EXISTS (SELECT 1 FROM "${databaseSchema}"."copilotz_operations" WHERE namespace=$1 AND operation_id=$4)
            OR (SELECT count(*) FROM "${databaseSchema}"."copilotz_operations" WHERE namespace=$1 AND metadata @> $2::jsonb AND state IN ('accepted','running')) < 32 AS allowed`,
          [
            draft.namespace,
            JSON.stringify(group),
            draft.deduplicationId ?? null,
            settlementScopeId,
          ],
        );
        if (!capacity.rows[0]?.allowed) {
          throw Object.assign(
            new Error("Conversation has 32 active operations."),
            { status: 409, code: "operation_replay_capacity_exceeded" },
          );
        }
      }
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
          return await duplicateResult(executor, existing, normalized, encoded);
        }
        outcome?.(false);
        throw new Error(`Event '${eventId}' was not inserted.`);
      }
      if (
        draft.subject?.type === "asset" ||
        draft.subject?.type === "protected_value"
      ) {
        invalidateOwnerAlarm(executor, databaseSchema, "content");
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
      const result = await runOn(transaction);
      if (
        !result.deduplicated &&
        result.deliveries.some((delivery) =>
          (delivery.status === "pending" &&
            delivery.attempts < delivery.maxAttempts) ||
          (delivery.status === "leased" && !!delivery.leaseExpiresAt)
        )
      ) {
        invalidateOwnerAlarm(transaction, databaseSchema);
      }
      if (!result.deduplicated && initialClaim) {
        const authority = await acquireOwner();
        for (const delivery of result.deliveries) {
          if (delivery.status !== "leased" || !delivery.leaseOwner) continue;
          const attempt = delivery.leaseOwner;
          afterSqlCommit(transaction, () => {
            if (authority.signal.aborted) return;
            unstartedClaims.set(delivery.id, attempt);
            if (!observingClaims) {
              observingClaims = true;
              authority.signal.addEventListener(
                "abort",
                () => unstartedClaims.clear(),
                { once: true },
              );
            }
          });
        }
      }
      if (mutation.onCommitted) {
        schemaCommandContext(transaction, databaseSchema).afterCommit(() =>
          mutation.onCommitted!(result)
        );
      }
      if (!result.deduplicated) {
        const selectionKeys = insertedSelectionKeys && !mutation.mutate
          ? insertedSelectionKeys
          : (indexOperationEvent || indexOperationEventSql)
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
          collectionChange: mutation.collectionChange,
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
    return await runCommand(
      "events.append",
      { eventId },
      (_request, context) => commitOn(context.transaction),
    );
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

  const readAdmissionClaim = async (
    id: string,
    owner: string,
    remote: boolean,
    consume: boolean,
  ): Promise<EventDelivery | null> => {
    if (owner.includes(":remote:") !== remote) return null;
    const authority = await acquireOwner();
    authority.signal.throwIfAborted();
    if (
      !owner.startsWith(
        `${authority.holderId}:${authority.epoch}:${localInstance}:`,
      )
    ) return null;
    // Only the admitting store can consume a committed preclaim, once. Reserve
    // synchronously before the read so concurrent dispatches cannot start twice.
    if (consume) {
      if (unstartedClaims.get(id) !== owner) return null;
      unstartedClaims.delete(id);
    }
    const result = await session.query<DeliveryRow>(
      `SELECT * FROM ${tables.event_deliveries} WHERE id=$1 AND status='leased' AND lease_owner=$2 AND ${
        remote
          ? "lease_expires_at > clock_timestamp()"
          : "lease_expires_at IS NULL"
      } AND owner_epoch=$3 AND EXISTS (SELECT 1 FROM ${tables.owner_epochs} WHERE owner='schema' AND epoch=$3 AND holder=$4)`,
      [id, owner, authority.epoch, authority.holderId],
    );
    authority.signal.throwIfAborted();
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
        const result = await context.transaction.query<DeliveryRow>(
          `UPDATE ${tables.event_deliveries}
       SET status = 'leased', attempts = attempts + 1, owner_epoch = (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'),
           lease_owner = $2,
           lease_expires_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE $4::timestamptz + ($3 * INTERVAL '1 millisecond') END,
           updated_at = $4::timestamptz, settled_at = NULL
       WHERE id = $1 AND owner_epoch <= $5::bigint AND attempts < max_attempts
         AND (
           (status IN ('pending', 'retry_wait') AND available_at <= $4::timestamptz)
           OR (status = 'leased' AND (lease_expires_at <= $4::timestamptz OR owner_epoch < (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema')))
         )
       RETURNING *`,
          [...params, context.commandTime, context.caller.epoch],
        );
        await syncDeliveryAlarms(
          context.transaction,
          result.rows.map((row) => row.id),
        );
        return result;
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
    transaction?: SqlExecutor,
  ): Promise<Output> => {
    const publications: Array<() => Promise<void>> = [];
    const result =
      await (transaction
        ? createSchemaCommandRunner(transaction, databaseSchema)
        : runCommand)(
          kind,
          input,
          (command, context) =>
            handler(command, context.transaction, async (update) => {
              const settled = await update(context.transaction);
              if (settled) {
                await syncDeliveryAlarms(context.transaction, [settled.id]);
              }
              if (
                settled &&
                ["succeeded", "cancelled", "dead_letter"].includes(
                  settled.status,
                )
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
                  await writeOwnerDeadline(
                    context.transaction,
                    databaseSchema,
                    {
                      source: "reconciliation",
                      key: reconciliationAlarmKey("schema", {
                        kind: "operation",
                        namespace,
                        id: settled.settlementScopeId,
                      }),
                      namespace,
                      dueAt: context.commandTime,
                      payload: { operationId: settled.settlementScopeId },
                    },
                  );
                }
              }
              return settled;
            }),
        );
    for (const publish of publications) {
      if (transaction) {
        schemaCommandContext(transaction, databaseSchema).afterCommit(publish);
      } else await publish();
    }
    return result;
  };

  const settleDelivery = async (
    id: string,
    status: Extract<DeliveryStatus, "succeeded" | "cancelled">,
    owner?: string,
    transaction?: SqlExecutor,
  ): Promise<EventDelivery | null> => {
    return await deliveryCommand(
      "delivery.settle",
      { id, status, owner },
      async (_input, transaction, settle) => {
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
         WHERE id = $1 AND owner_epoch <= (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema') AND ${allowed} ${ownerFilter} RETURNING *`,
            params,
          );
          return result.rows[0]
            ? mapDelivery(result.rows[0], databaseSchema)
            : null;
        });
      },
      transaction,
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
        OR (d.status = 'leased' AND (d.lease_expires_at <= NOW() OR d.owner_epoch < (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))))`,
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

  return {
    executionAuthority: createSchemaExecutionAuthority(acquireOwner),
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
    async heartbeatDeliveries(attempts, accept) {
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
            if (
              attempt.ownerEpoch !== context.caller.epoch ||
              accept && !accept(attempt, context.caller.epoch)
            ) continue;
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
          const result = await context.transaction.query<
            { id: string; owner: string }
          >(
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
          await syncDeliveryAlarms(
            context.transaction,
            result.rows.map((row) => row.id),
          );
          return result;
        },
      );
      return result.rows;
    },
    readRemoteClaim: (id, owner, consume = false) =>
      readAdmissionClaim(id, owner, true, consume),
    readLocalClaim: (id, owner, consume = false) =>
      readAdmissionClaim(id, owner, false, consume),
    succeedDelivery(id, owner, transaction) {
      return settleDelivery(id, "succeeded", owner, transaction);
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
         WHERE d.status = 'leased' AND (d.lease_expires_at <= NOW() OR d.owner_epoch < (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))
           AND d.attempts >= d.max_attempts
           AND ($1::text IS NULL OR e.namespace = $1)
         ORDER BY d.lease_expires_at, d.id LIMIT $2`,
        [recovery.namespace ?? null, boundedInteger(recovery.limit, 100, 1)],
      );
      const recovered: EventDelivery[] = [];
      for (const row of candidates.rows) {
        const delivery = await deliveryCommand("delivery.exhaust", {
          id: row.id,
        }, async (_input, transaction, settle) => {
          const { commandTime } = schemaCommandContext(
            transaction,
            databaseSchema,
          );
          return await settle(async (transaction) => {
            const result = await transaction.query<DeliveryRow>(
              `UPDATE ${tables.event_deliveries}
             SET status = 'dead_letter', lease_owner = NULL, lease_expires_at = NULL,
               last_error = $2::jsonb, updated_at = $3::timestamptz, settled_at = $3::timestamptz
             WHERE id = $1 AND owner_epoch <= (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema') AND status = 'leased' AND (lease_expires_at <= $3::timestamptz OR owner_epoch < (SELECT epoch FROM ${tables.owner_epochs} WHERE owner='schema'))
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
        orphaned_action: boolean;
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
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
           EXISTS (
             SELECT 1 FROM ${tables.open_actions} action
             WHERE action.namespace = $1 AND action.scope_id = $2
               AND action.state = 'invoked'
               AND action.owner_delivery_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM ${tables.event_deliveries} owner_delivery
                 WHERE owner_delivery.id = action.owner_delivery_id
               )
           ) AS orphaned_action
         FROM scoped`,
        params,
      );
      const row = result.rows[0];
      // This read refuses an unavailable result; it never settles the retained
      // Action or grants a replacement worker authority to repeat its effects.
      if (row?.orphaned_action) {
        throw Object.assign(new Error("Operation result is unavailable."), {
          code: "operation_result_unavailable",
          status: 409,
        });
      }
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
