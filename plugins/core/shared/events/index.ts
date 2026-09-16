/** Conversational event policy belongs to Core. @module */
export type EventVisibility =
  | { kind: "public" }
  | { kind: "participants"; participantIds: readonly string[] }
  | {
    kind: "tool";
    policy: "requester_only" | "public_status" | "public";
    requesterId: string;
  }
  | { kind: "internal" };

export type EventRouting = {
  senderId?: string;
  recipientIds?: readonly string[];
};

export type CoreEventMetadata = {
  threadId?: string;
  routing?: EventRouting;
  visibility?: EventVisibility;
};
/** Read Core's envelope; unrelated domain events have no conversational routing. */
export function coreEvent(
  event: { metadata?: Readonly<Record<string, unknown>> },
): {
  threadId?: string;
  routing: EventRouting;
  visibility: EventVisibility;
} {
  const core = event.metadata?.core as CoreEventMetadata | undefined;
  return {
    threadId: core?.threadId,
    routing: core?.routing ?? {},
    visibility: core?.visibility ?? { kind: "public" },
  };
}
