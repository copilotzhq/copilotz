/** Visibility policy carried by every semantic or ephemeral event. */
export type EventVisibility =
  | { kind: "public" }
  | { kind: "participants"; participantIds: readonly string[] }
  | {
    kind: "tool";
    policy: "requester_only" | "public_status" | "public";
    requesterId: string;
  }
  | { kind: "internal" };

/** Stable domain record described by an event. */
export type EventSubject = {
  type: string;
  id: string;
};

/** Internal immutable JSON body for a durable event. */
export type EventBodyRef = Readonly<{
  eventBodyId: string;
  schemaVersion: number;
  mediaType: "application/json";
}>;

/** Conversational routing only; guaranteed work lives in delivery records. */
export type EventRouting = {
  senderId?: string;
  recipientIds?: readonly string[];
};

/** Immutable semantic fact stored in the database. */
export type DurableEvent<TPayload = unknown> = Readonly<{
  durable: true;
  id: string;
  /** Database-assigned monotonic position, serialized without precision loss. */
  position: string;
  schemaVersion: number;
  type: string;
  namespace: string;
  threadId?: string;
  subject?: EventSubject;
  payload: TPayload;
  delta?: unknown;
  routing: EventRouting;
  visibility: EventVisibility;
  metadata: Readonly<Record<string, unknown>>;
  causationId?: string;
  correlationId: string;
  deduplicationId?: string;
  createdAt: string;
}>;

/** Process-lifetime frame or delta that is never inserted into the database. */
export type EphemeralEvent<TPayload = unknown> = Readonly<{
  durable: false;
  type:
    | "text.delta"
    | "reasoning.delta"
    | "audio.delta"
    | "tool_call.delta"
    | "tool_output.delta"
    | (string & Record<never, never>);
  namespace: string;
  threadId?: string;
  payload: TPayload;
  routing: EventRouting;
  visibility: EventVisibility;
  metadata: Readonly<Record<string, unknown>>;
  causationId?: string;
  correlationId: string;
  streamId?: string;
  sequence?: number;
  createdAt: string;
}>;

export type EphemeralEventDraft<TPayload = unknown> = Readonly<{
  type: EphemeralEvent["type"];
  namespace: string;
  threadId?: string;
  payload: TPayload;
  routing?: EventRouting;
  visibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  causationId?: string;
  correlationId: string;
  streamId?: string;
  sequence?: number;
  createdAt?: string;
}>;

/** Unified event vocabulary exposed to processors and attachment observers. */
export type CopilotzEvent<TPayload = unknown> =
  | DurableEvent<TPayload>
  | EphemeralEvent<TPayload>;

/** Immutable event view with its durable body resolved for consumption. */
export type ResolvedCopilotzEvent<TData = unknown> = CopilotzEvent & {
  readonly data: TData;
};

/** Input used to append one immutable semantic event. */
export type DurableEventDraft<TPayload = unknown> = {
  type: string;
  namespace: string;
  threadId?: string;
  subject?: EventSubject;
  payload: TPayload;
  delta?: unknown;
  routing?: EventRouting;
  visibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  createdAt?: string;
  /** Runtime-owned completion scope inherited by this mutation's deliveries. */
  settlementScopeId?: string;
};

export type DeliveryStatus =
  | "pending"
  | "leased"
  | "retry_wait"
  | "succeeded"
  | "cancelled"
  | "dead_letter";

/** Mutable guaranteed-work obligation for one logical consumer. */
export type EventDelivery = Readonly<{
  /** Physical database schema containing this delivery row. */
  databaseSchema: string;
  id: string;
  eventId: string;
  consumerId: string;
  settlementScopeId: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  priority: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
}>;

/** Durable consumer selected atomically for an event mutation. */
export type DurableConsumerObligation = Readonly<{
  consumerId: string;
  settlement: "inherit" | "detached";
}>;

export type DeliveryScopeSettlement = Readonly<{
  unsettled: number;
  deadLetters: number;
  cancelled: number;
  succeeded: number;
}>;

export type EventStoreErrorCode =
  | "event_invalid"
  | "event_deduplication_conflict"
  | "event_transaction_unavailable";

export type EventStoreError = Error & {
  code: EventStoreErrorCode;
};

export function isDurableEvent(
  event: CopilotzEvent,
): event is DurableEvent {
  return event.durable;
}

function invalidEventData(label: string): never {
  throw new TypeError(`${label} must contain strict JSON data only.`);
}

/** Captures transport-safe Event data without invoking object accessors. */
export function snapshotEventData<T>(value: T, label = "Event data"): T {
  const ancestors = new WeakSet<object>();
  const snapshot = (candidate: unknown): unknown => {
    if (
      candidate === null || typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) invalidEventData(label);
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (!candidate || typeof candidate !== "object") invalidEventData(label);
    if (ancestors.has(candidate)) invalidEventData(label);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          invalidEventData(label);
        }
        const keys = Reflect.ownKeys(candidate);
        if (
          keys.length !== candidate.length + 1 ||
          keys.at(-1) !== "length"
        ) invalidEventData(label);
        const result: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          if (keys[index] !== String(index)) invalidEventData(label);
          const descriptor = Object.getOwnPropertyDescriptor(
            candidate,
            String(index),
          );
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalidEventData(label);
          }
          result.push(snapshot(descriptor.value));
        }
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalidEventData(label);
      }
      const entries: [string, unknown][] = [];
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") invalidEventData(label);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          invalidEventData(label);
        }
        entries.push([key, snapshot(descriptor.value)]);
      }
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(candidate);
    }
  };
  return snapshot(value) as T;
}

/** Validates and freezes one non-persistent stream/control event. */
export function createEphemeralEvent<TPayload>(
  draft: EphemeralEventDraft<TPayload>,
  now: () => Date = () => new Date(),
): EphemeralEvent<TPayload> {
  const type = draft.type.trim();
  const namespace = draft.namespace.trim();
  const correlationId = draft.correlationId.trim();
  if (!type || !namespace || !correlationId) {
    throw new TypeError(
      "Ephemeral events require type, namespace, and correlationId.",
    );
  }
  const createdAt = draft.createdAt ?? now().toISOString();
  if (Number.isNaN(new Date(createdAt).getTime())) {
    throw new TypeError("Ephemeral event createdAt must be valid.");
  }
  if (
    draft.sequence !== undefined &&
    (!Number.isSafeInteger(draft.sequence) || draft.sequence < 0)
  ) {
    throw new TypeError("Ephemeral event sequence must be non-negative.");
  }
  const visibility = snapshotEventData<EventVisibility>(
    draft.visibility ?? { kind: "public" },
    "Ephemeral Event visibility",
  );
  return Object.freeze({
    durable: false,
    type: type as EphemeralEvent["type"],
    namespace,
    ...(draft.threadId?.trim() ? { threadId: draft.threadId.trim() } : {}),
    payload: snapshotEventData(draft.payload, "Ephemeral Event payload"),
    routing: snapshotEventData(
      draft.routing ?? {},
      "Ephemeral Event routing",
    ),
    visibility,
    metadata: snapshotEventData(
      draft.metadata ?? {},
      "Ephemeral Event metadata",
    ),
    ...(draft.causationId?.trim()
      ? { causationId: draft.causationId.trim() }
      : {}),
    correlationId,
    ...(draft.streamId?.trim() ? { streamId: draft.streamId.trim() } : {}),
    ...(draft.sequence !== undefined ? { sequence: draft.sequence } : {}),
    createdAt,
  });
}
