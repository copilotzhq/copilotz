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

/** Core owns this opaque catalog selection key; the runtime never interprets it. */
export function coreThreadObservationKey(threadId: string): string {
  const id = threadId.trim();
  if (!id) throw new TypeError("Thread id must be non-empty.");
  return `core.thread:${id}`;
}

export function coreThreadObservationMetadata(threadId: string): Readonly<{
  observationKeys: readonly string[];
}> {
  return { observationKeys: [coreThreadObservationKey(threadId)] };
}

/** Resolver supplied explicitly to the generic catalog upgrade for old Core events. */
export function resolveCoreObservationKeys(
  input: Readonly<{
    metadata: Readonly<Record<string, unknown>>;
    operationMetadata?: Readonly<Record<string, unknown>>;
  }>,
): readonly string[] {
  const keys = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  for (const metadata of [input.metadata, input.operationMetadata ?? {}]) {
    if (Array.isArray(metadata.observationKeys)) {
      for (const key of metadata.observationKeys) {
        if (typeof key === "string" && key.trim()) keys.add(key.trim());
      }
    }
    const coreThread = record(metadata.core).threadId;
    const operationThread = record(metadata.operationMetadata).threadId;
    for (const id of [coreThread, operationThread]) {
      if (typeof id === "string" && id.trim()) {
        keys.add(coreThreadObservationKey(id));
      }
    }
  }
  return [...keys];
}
