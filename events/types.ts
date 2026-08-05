/**
 * Canonical Copilotz event contracts.
 *
 * Durable semantic events are immutable database records. Ephemeral events are
 * process-lifetime stream frames and are never inserted into the database.
 */

export type EventVisibility =
  | { kind: "public" }
  | { kind: "participants"; participantIds: readonly string[] }
  | {
    kind: "tool";
    policy: "requester_only" | "public_status" | "public";
    requesterId: string;
  }
  | { kind: "internal" };

export interface EventSubject {
  type: string;
  id: string;
}

export interface EventRouting {
  /** Participant or logical resource that originated the event. */
  senderId?: string;
  /** Explicit conversational recipients. Empty means the thread audience. */
  recipientIds?: readonly string[];
  /** Stable logical consumers selected atomically with the mutation. */
  consumerIds?: readonly string[];
}

export interface DurableEvent<TPayload = unknown> {
  readonly durable: true;
  readonly id: string;
  /** Database-assigned monotonic position. Serialized as a decimal string. */
  readonly position: string;
  readonly schemaVersion: number;
  readonly type: string;
  readonly namespace: string;
  readonly threadId?: string;
  readonly subject?: EventSubject;
  readonly payload: TPayload;
  readonly delta?: unknown;
  readonly routing: EventRouting;
  readonly visibility: EventVisibility;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly deduplicationId?: string;
  readonly createdAt: string;
}

export interface EphemeralEvent<TPayload = unknown> {
  readonly durable: false;
  readonly type:
    | "text.delta"
    | "reasoning.delta"
    | "audio.delta"
    | "tool_call.delta"
    | (string & Record<never, never>);
  readonly namespace: string;
  readonly threadId?: string;
  readonly payload: TPayload;
  readonly routing: EventRouting;
  readonly visibility: EventVisibility;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly streamId?: string;
  readonly sequence?: number;
  readonly createdAt: string;
}

export type CopilotzEvent<TPayload = unknown> =
  | DurableEvent<TPayload>
  | EphemeralEvent<TPayload>;

export interface DurableEventDraft<TPayload = unknown> {
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
}

export type DeliveryStatus =
  | "pending"
  | "leased"
  | "retry_wait"
  | "succeeded"
  | "cancelled"
  | "dead_letter";

export interface EventDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly consumerId: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly availableAt: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastError?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt?: string;
}

export interface EventSendHandle {
  readonly eventId: string;
  readonly threadId: string;
  readonly correlationId: string;
  readonly done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export function isDurableEvent(
  event: CopilotzEvent,
): event is DurableEvent {
  return event.durable;
}
