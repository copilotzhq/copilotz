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
  const visibility: EventVisibility = draft.visibility
    ? structuredClone(draft.visibility)
    : { kind: "public" };
  return Object.freeze({
    durable: false,
    type: type as EphemeralEvent["type"],
    namespace,
    ...(draft.threadId?.trim() ? { threadId: draft.threadId.trim() } : {}),
    payload: structuredClone(draft.payload),
    routing: Object.freeze(structuredClone(draft.routing ?? {})),
    visibility: Object.freeze(visibility),
    metadata: Object.freeze(structuredClone(draft.metadata ?? {})),
    ...(draft.causationId?.trim()
      ? { causationId: draft.causationId.trim() }
      : {}),
    correlationId,
    ...(draft.streamId?.trim() ? { streamId: draft.streamId.trim() } : {}),
    ...(draft.sequence !== undefined ? { sequence: draft.sequence } : {}),
    createdAt,
  });
}
