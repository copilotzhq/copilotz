import type { Event, ProcessorDeps } from "@/types/index.ts";
import { hasParticipantCollection } from "@/runtime/collections/native.ts";

export type ParticipantIdentityInput = {
  id?: string;
  externalId: string;
  participantType: "human" | "agent" | "job";
  name?: string | null;
  email?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ParticipantIdentityRecord = ParticipantIdentityInput & {
  id: string;
};

export type ParticipantCollection = {
  upsertIdentity: (
    input: ParticipantIdentityInput,
  ) => Promise<ParticipantIdentityRecord>;
};

export function getParticipantCollection(
  deps: ProcessorDeps,
): ParticipantCollection | null {
  if (!hasParticipantCollection(deps.context.collections)) return null;
  const participant = (deps.context.collections as {
    participant?: Partial<ParticipantCollection>;
  }).participant;
  return typeof participant?.upsertIdentity === "function"
    ? participant as ParticipantCollection
    : null;
}

export async function ensureParticipantMembership(args: {
  deps: ProcessorDeps;
  event: Event;
  participantNodeId: string;
}): Promise<void> {
  const { deps, event, participantNodeId } = args;
  const threadNodeId = typeof deps.thread?.id === "string"
    ? deps.thread.id
    : typeof event.threadId === "string"
    ? event.threadId
    : null;
  if (!threadNodeId) return;

  await deps.db.ops.mutate.graph.ensureParticipation({
    participantNodeId,
    threadNodeId,
  }, {
    threadId: threadNodeId,
    namespace: deps.context.namespace ?? null,
    traceId: typeof event.traceId === "string" ? event.traceId : null,
    causationId: typeof event.id === "string" ? event.id : null,
  });
}
