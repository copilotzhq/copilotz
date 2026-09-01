import { ulid } from "../../dependencies/ulid.ts";
import { errorRetryability } from "../failure.ts";
import { createEventStoreError } from "./errors.ts";
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
  EventRouting,
  EventSubject,
  EventVisibility,
} from "./types.ts";

type EventRow = Record<string, unknown> & {
  id: string;
  position: string | number | bigint;
  schema_version: number;
  type: string;
  namespace: string;
  thread_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  payload: unknown;
  delta: unknown;
  routing: unknown;
  visibility: unknown;
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
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  priority: number;
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
  routing: EncodedJson;
  visibility: EncodedJson;
  metadata: EncodedJson;
};

export type EventMutationContext = {
  transaction: SqlExecutor;
  tables: Readonly<Record<CoreTableName, string>>;
};

export type CommitEventMutationOptions<T> = {
  draft: DurableEventDraft;
  consumers: readonly DurableConsumerObligation[];
  priority?: number;
  maxAttempts?: number;
  /** Join an already-open SQL transaction instead of opening a nested one. */
  transaction?: SqlExecutor;
  mutate(context: EventMutationContext): Promise<T>;
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
};

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
    options?: { priority?: number; maxAttempts?: number },
  ): Promise<CommitEventMutationResult<void>>;
  getEvent(id: string): Promise<DurableEvent | null>;
  getEventByDeduplicationId(
    namespace: string,
    deduplicationId: string,
  ): Promise<DurableEvent | null>;
  listEvents(options: {
    namespace: string;
    threadId?: string;
    correlationId?: string;
    afterPosition?: string;
    /** Result order. `afterPosition` remains an ascending position bound. */
    order?: "asc" | "desc";
    limit?: number;
  }, executor?: SqlExecutor): Promise<readonly DurableEvent[]>;
  getDelivery(id: string): Promise<EventDelivery | null>;
  listDeliveries(options?: {
    namespace?: string;
    eventId?: string;
    consumerId?: string;
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
  succeedDelivery(id: string, owner: string): Promise<boolean>;
  cancelDelivery(id: string, owner?: string): Promise<boolean>;
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
  nextRecoveryDelayMs(): Promise<number | null>;
  scopeSettlement(
    namespace: string,
    settlementScopeId: string,
  ): Promise<DeliveryScopeSettlement>;
  cancelScope(
    namespace: string,
    settlementScopeId: string,
    reason?: string,
  ): Promise<number>;
  retryDeadLetter(id: string): Promise<boolean>;
  discardDeadLetter(id: string): Promise<boolean>;
  compactDeliveries(options?: {
    retentionMs?: number | null;
    now?: Date;
    limit?: number;
  }): Promise<{ deliveries: number }>;
};

const DEFAULT_COMPACTION_LIMIT = 100;
const MAX_COMPACTION_LIMIT = 1_000;

function iso(value: string | Date | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
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
  const routing = record(row.routing) as EventRouting;
  const visibilityValue = record(row.visibility);
  const visibility =
    (typeof visibilityValue.kind === "string"
      ? visibilityValue
      : { kind: "public" }) as EventVisibility;
  const event: DurableEvent = {
    durable: true,
    id: String(row.id),
    position: String(row.position),
    schemaVersion: Number(row.schema_version),
    type: String(row.type),
    namespace: String(row.namespace),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
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
    routing,
    visibility,
    metadata: record(row.metadata),
    ...(row.causation_id ? { causationId: String(row.causation_id) } : {}),
    correlationId: String(row.correlation_id),
    ...(row.deduplication_id
      ? { deduplicationId: String(row.deduplication_id) }
      : {}),
    createdAt: iso(row.created_at)!,
  };
  return deepFreeze(event);
}

function mapDelivery(row: DeliveryRow, databaseSchema: string): EventDelivery {
  const lastError = row.last_error == null ? undefined : record(row.last_error);
  return deepFreeze({
    databaseSchema,
    id: String(row.id),
    eventId: String(row.event_id),
    consumerId: String(row.consumer_id),
    settlementScopeId: String(row.settlement_scope_id),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
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
    payload: encodeJson(draft.payload, "payload"),
    delta: encodeJson(draft.delta, "delta"),
    routing: encodeJson(draft.routing ?? {}, "routing"),
    visibility: encodeJson(
      draft.visibility ?? { kind: "public" },
      "visibility",
    ),
    metadata: encodeJson(draft.metadata ?? {}, "metadata"),
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
    event.threadId !== draft.threadId ||
    !sameSubject(event.subject, draft.subject) ||
    event.causationId !== draft.causationId ||
    (draft.correlationId !== undefined &&
      event.correlationId !== draft.correlationId) ||
    canonicalJson(event.payload) !== canonicalJson(encoded.payload.value) ||
    canonicalJson(event.delta ?? null) !== canonicalJson(encoded.delta.value) ||
    canonicalJson(event.routing) !== canonicalJson(encoded.routing.value) ||
    canonicalJson(event.visibility) !==
      canonicalJson(encoded.visibility.value) ||
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
      Object.freeze({
        consumerId,
        settlement: value.settlement,
      }),
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

function isDeduplicationViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const namedConstraint = value.constraint === "events_namespace_dedup_idx" ||
    (typeof value.message === "string" &&
      value.message.includes("events_namespace_dedup_idx"));
  return (value.code === "23505" && namedConstraint) ||
    (value.cause !== undefined && isDeduplicationViolation(value.cause));
}

function serializeError(
  error: unknown,
  retryable?: boolean,
): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
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
  const { session } = options;
  const databaseSchema = options.schema ?? "public";
  const tables = createCoreTableNames(databaseSchema);
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const defaultLeaseMs = boundedInteger(options.leaseMs, 120_000, 0);
  const defaultMaxAttempts = boundedInteger(options.maxAttempts, 3, 1);
  const retryBaseMs = boundedInteger(options.retryBaseMs, 250, 0);
  const retryCapMs = boundedInteger(options.retryCapMs, 30_000, 0);
  const indexOperationEvent = options.indexOperationEvent;

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
    return Object.freeze({
      value,
      event,
      deliveries: await deliveriesForEvent(executor, event.id),
      settlementScopeId,
      deduplicated: true,
    });
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
    validateDraft(mutation.draft);
    const draft = {
      ...mutation.draft,
      type: mutation.draft.type.trim(),
      namespace: mutation.draft.namespace.trim(),
      deduplicationId: mutation.draft.deduplicationId?.trim() || undefined,
    };
    const encoded = encodeDraft(draft);
    const consumers = uniqueConsumers(mutation.consumers);
    const eventId = createId();
    const settlementScopeId = draft.settlementScopeId?.trim() || eventId;
    const correlationId = draft.correlationId ?? eventId;
    const createdAt = (draft.createdAt ? new Date(draft.createdAt) : now())
      .toISOString();
    const maxAttempts = boundedInteger(
      mutation.maxAttempts,
      defaultMaxAttempts,
      1,
    );
    const priority = boundedInteger(mutation.priority, 0, -2147483648);
    const normalized = { ...mutation, draft };

    const runOn = async (transaction: SqlExecutor) => {
      if (draft.deduplicationId) {
        await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify([
            databaseSchema,
            draft.namespace,
            draft.deduplicationId,
          ])],
        );
        const existing = await loadDuplicate(
          transaction,
          draft.namespace,
          draft.deduplicationId,
        );
        if (existing) {
          return await duplicateResult(transaction, existing, normalized);
        }
      }

      const context = { transaction, tables };
      const value = await mutation.mutate(context);
      const inserted = await transaction.query<EventRow>(
        `INSERT INTO ${tables.events} (
            id, schema_version, type, namespace, thread_id,
            subject_type, subject_id, payload, delta, routing, visibility,
            metadata, causation_id, correlation_id, deduplication_id, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
            $12::jsonb, $13, $14, $15, $16::timestamptz
          ) RETURNING *`,
        [
          eventId,
          EVENT_SCHEMA_VERSION,
          draft.type,
          draft.namespace,
          draft.threadId ?? null,
          draft.subject?.type ?? null,
          draft.subject?.id ?? null,
          encoded.payload.text,
          encoded.delta.text,
          encoded.routing.text,
          encoded.visibility.text,
          encoded.metadata.text,
          draft.causationId ?? null,
          correlationId,
          draft.deduplicationId ?? null,
          createdAt,
        ],
      );
      const event = mapEvent(inserted.rows[0]);
      await indexOperationEvent?.(transaction, {
        namespace: event.namespace,
        operationId: settlementScopeId,
        eventId: event.id,
        position: event.position,
        correlationId: event.correlationId,
        createdAt: event.createdAt,
        metadata: event.metadata,
      });

      const deliveries: EventDelivery[] = [];
      for (const consumer of consumers) {
        const deliveryScopeId = consumer.settlement === "detached"
          ? `detached:${event.id}:${consumer.consumerId}`
          : settlementScopeId;
        const result = await transaction.query<DeliveryRow>(
          `INSERT INTO ${tables.event_deliveries} (
              id, event_id, consumer_id, settlement_scope_id,
              status, attempts, max_attempts,
              priority, available_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, NOW(), NOW(), NOW())
            RETURNING *`,
          [
            createId(),
            event.id,
            consumer.consumerId,
            deliveryScopeId,
            maxAttempts,
            priority,
          ],
        );
        deliveries.push(mapDelivery(result.rows[0], databaseSchema));
      }

      return Object.freeze({
        value,
        event,
        deliveries,
        settlementScopeId,
        deduplicated: false,
      });
    };

    const recoverOn = async (
      transaction: SqlExecutor,
      error: unknown,
    ) => {
      const existing = await loadDuplicate(
        transaction,
        draft.namespace,
        draft.deduplicationId!,
      );
      if (!existing) throw error;
      return await duplicateResult(transaction, existing, normalized);
    };

    try {
      return mutation.transaction
        ? await runOn(mutation.transaction)
        : await session.transaction(runOn);
    } catch (error) {
      if (!draft.deduplicationId || !isDeduplicationViolation(error)) {
        throw error;
      }
      if (mutation.transaction) throw error;
      return await session.transaction((transaction) =>
        recoverOn(transaction, error)
      );
    }
  };

  const getEvent = async (id: string): Promise<DurableEvent | null> => {
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

  const deadLetterExhaustedLeases = async (
    id?: string,
  ): Promise<number> => {
    const params: unknown[] = [
      JSON.stringify({
        name: "DeliveryLeaseExpired",
        message: "The delivery lease expired after its final attempt.",
      }),
    ];
    const idFilter = id ? `AND id = $${params.push(id)}` : "";
    const result = await session.query<{ id: string }>(
      `UPDATE ${tables.event_deliveries}
       SET status = 'dead_letter', lease_owner = NULL,
           lease_expires_at = NULL, last_error = $1::jsonb,
           updated_at = NOW(), settled_at = NOW()
       WHERE status = 'leased' AND lease_expires_at <= NOW()
         AND attempts >= max_attempts ${idFilter}
       RETURNING id`,
      params,
    );
    return result.rows.length;
  };

  const claimDelivery = async (claim: {
    id: string;
    owner: string;
    leaseMs?: number;
  }): Promise<EventDelivery | null> => {
    await deadLetterExhaustedLeases(claim.id);
    const leaseMs = boundedInteger(claim.leaseMs, defaultLeaseMs, 0);
    const result = await session.query<DeliveryRow>(
      `UPDATE ${tables.event_deliveries}
       SET status = 'leased', attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW(), settled_at = NULL
       WHERE id = $1 AND attempts < max_attempts
         AND (
           (status IN ('pending', 'retry_wait') AND available_at <= NOW())
           OR (status = 'leased' AND lease_expires_at <= NOW())
         )
       RETURNING *`,
      [claim.id, claim.owner, leaseMs],
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  const settleDelivery = async (
    id: string,
    status: Extract<DeliveryStatus, "succeeded" | "cancelled">,
    owner?: string,
  ): Promise<boolean> => {
    const params: unknown[] = [id, status];
    const ownerFilter = owner ? `AND lease_owner = $${params.push(owner)}` : "";
    const allowed = status === "succeeded"
      ? "status = 'leased'"
      : "status IN ('pending', 'leased', 'retry_wait')";
    const result = await session.query<{ id: string }>(
      `UPDATE ${tables.event_deliveries}
       SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = NOW(), settled_at = NOW()
       WHERE id = $1 AND ${allowed} ${ownerFilter}
       RETURNING id`,
      params,
    );
    return result.rows.length === 1;
  };

  const listRecoverable = async (
    listOptions: {
      namespace?: string;
      consumerIds?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<readonly EventDelivery[]> => {
    await deadLetterExhaustedLeases();
    const conditions = [
      `((d.status IN ('pending', 'retry_wait') AND d.available_at <= NOW())
        OR (d.status = 'leased' AND d.lease_expires_at <= NOW()))`,
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
       ORDER BY d.priority DESC, d.available_at, d.created_at, d.id
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
    await deadLetterExhaustedLeases();
    const leaseMs = boundedInteger(claim.leaseMs, defaultLeaseMs, 0);
    const params: unknown[] = [claim.owner, leaseMs];
    const conditions = [
      `((d.status IN ('pending', 'retry_wait') AND d.available_at <= NOW())
        OR (d.status = 'leased' AND d.lease_expires_at <= NOW()))`,
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

    const result = await session.query<DeliveryRow>(
      `WITH candidate AS (
        SELECT d.id FROM ${tables.event_deliveries} d
        JOIN ${tables.events} e ON e.id = d.event_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY d.priority DESC, d.available_at, d.created_at, d.id
        FOR UPDATE OF d SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${tables.event_deliveries} AS d
      SET status = 'leased', attempts = d.attempts + 1,
          lease_owner = $1,
          lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          updated_at = NOW(), settled_at = NULL
      FROM candidate
      WHERE d.id = candidate.id
      RETURNING d.*`,
      params,
    );
    return result.rows[0] ? mapDelivery(result.rows[0], databaseSchema) : null;
  };

  return {
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
        priority: appendOptions.priority,
        maxAttempts: appendOptions.maxAttempts,
        mutate: () => Promise.resolve(undefined),
        recoverDuplicate: () => Promise.resolve(undefined),
      });
    },
    getEvent,
    getEventByDeduplicationId(namespace, deduplicationId) {
      return loadDuplicate(session, namespace, deduplicationId);
    },
    async listEvents(listOptions, executor = session) {
      const conditions = ["namespace = $1"];
      const params: unknown[] = [listOptions.namespace];
      if (listOptions.threadId) {
        params.push(listOptions.threadId);
        conditions.push(`thread_id = $${params.length}`);
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
      const conditions: string[] = [];
      const params: unknown[] = [];
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
      const result = await session.query<{ id: string }>(
        `UPDATE ${tables.event_deliveries}
         SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
             updated_at = NOW()
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2
           AND lease_expires_at > NOW()
         RETURNING id`,
        [heartbeat.id, heartbeat.owner, leaseMs],
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
      const result = await session.query<DeliveryRow>(
        `UPDATE ${tables.event_deliveries}
         SET status = CASE WHEN $5 = FALSE OR attempts >= max_attempts
                           THEN 'dead_letter' ELSE 'retry_wait' END,
             available_at = CASE WHEN $5 = FALSE OR attempts >= max_attempts
               THEN available_at
               ELSE NOW() + ($3 * INTERVAL '1 millisecond') END,
             lease_owner = NULL, lease_expires_at = NULL,
             last_error = $4::jsonb, updated_at = NOW(),
             settled_at = CASE WHEN $5 = FALSE OR attempts >= max_attempts
               THEN NOW() ELSE NULL END
         WHERE id = $1 AND status = 'leased' AND lease_owner = $2
         RETURNING *`,
        [
          failure.id,
          failure.owner,
          backoffMs,
          JSON.stringify(serializeError(failure.error, retryable)),
          retryable,
        ],
      );
      return result.rows[0]
        ? mapDelivery(result.rows[0], databaseSchema)
        : null;
    },
    listRecoverable,
    async nextRecoveryDelayMs() {
      await deadLetterExhaustedLeases();
      const result = await session.query<{
        delay_ms: string | number | null;
      }>(
        `SELECT GREATEST(0, EXTRACT(EPOCH FROM (
           MIN(CASE WHEN status = 'leased' THEN lease_expires_at ELSE available_at END)
           - NOW()
         )) * 1000) AS delay_ms
         FROM ${tables.event_deliveries}
         WHERE status IN ('pending', 'leased', 'retry_wait')
           AND attempts < max_attempts`,
      );
      const value = result.rows[0]?.delay_ms;
      return value == null ? null : Math.max(0, Number(value));
    },
    async scopeSettlement(namespace, settlementScopeId) {
      await deadLetterExhaustedLeases();
      const result = await session.query<{
        unsettled: string | number;
        dead_letters: string | number;
        cancelled: string | number;
        succeeded: string | number;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE d.status IN ('pending', 'leased', 'retry_wait')) AS unsettled,
           COUNT(*) FILTER (WHERE d.status = 'dead_letter') AS dead_letters,
           COUNT(*) FILTER (WHERE d.status = 'cancelled') AS cancelled,
           COUNT(*) FILTER (WHERE d.status = 'succeeded') AS succeeded
         FROM ${tables.event_deliveries} d
         JOIN ${tables.events} e ON e.id = d.event_id
         WHERE e.namespace = $1 AND d.settlement_scope_id = $2`,
        [namespace, settlementScopeId],
      );
      const row = result.rows[0];
      return deepFreeze({
        unsettled: Number(row?.unsettled ?? 0),
        deadLetters: Number(row?.dead_letters ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
        succeeded: Number(row?.succeeded ?? 0),
      });
    },
    async cancelScope(namespace, settlementScopeId, reason) {
      const result = await session.query<{ id: string }>(
        `UPDATE ${tables.event_deliveries} AS delivery
         SET status = 'cancelled', lease_owner = NULL,
             lease_expires_at = NULL, last_error = $3::jsonb,
             updated_at = NOW(), settled_at = NOW()
         FROM ${tables.events} AS event
         WHERE delivery.event_id = event.id
           AND event.namespace = $1
           AND delivery.settlement_scope_id = $2
           AND delivery.status IN ('pending', 'leased', 'retry_wait')
         RETURNING delivery.id`,
        [
          namespace,
          settlementScopeId,
          JSON.stringify({ reason: reason ?? "cancelled" }),
        ],
      );
      return result.rows.length;
    },
    async retryDeadLetter(id) {
      const result = await session.query<{ id: string }>(
        `UPDATE ${tables.event_deliveries}
         SET status = 'pending', attempts = 0, available_at = NOW(),
             lease_owner = NULL, lease_expires_at = NULL,
             last_error = NULL, settled_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'dead_letter' RETURNING id`,
        [id],
      );
      return result.rows.length === 1;
    },
    async discardDeadLetter(id) {
      const result = await session.query<{ id: string }>(
        `UPDATE ${tables.event_deliveries}
         SET status = 'cancelled', updated_at = NOW(), settled_at = NOW()
         WHERE id = $1 AND status = 'dead_letter' RETURNING id`,
        [id],
      );
      return result.rows.length === 1;
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
