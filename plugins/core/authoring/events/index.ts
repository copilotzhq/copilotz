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
export type CoreContentRole =
  | "body"
  | "attachment"
  | "reasoning"
  | "tool.arguments"
  | "tool.output"
  | "tool.projected_output"
  | "tool.error_detail"
  | "transcript"
  | "recording"
  | "document.source"
  | "provider.trace";
export type CoreEphemeralEventType =
  | "text.delta"
  | "reasoning.delta"
  | "audio.delta"
  | "tool_call.delta"
  | "tool_output.delta";
