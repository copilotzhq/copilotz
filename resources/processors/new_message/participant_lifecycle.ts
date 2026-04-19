import type { Event, EventProcessor, ProcessorDeps } from "@/types/index.ts";
import type { NewMessageEventPayload } from "@/database/schemas/index.ts";
import { hasParticipantCollection } from "@/runtime/collections/native.ts";

export const priority = 100;

function buildSenderIdentity(payload: NewMessageEventPayload): {
  externalId: string;
  participantType: "human" | "agent";
  agentId?: string | null;
} | null {
  const sender = payload.sender;
  if (!sender) return null;

  if (sender.type === "user") {
    const externalId = sender.externalId ?? sender.id ?? sender.name ?? null;
    return externalId
      ? { externalId, participantType: "human" }
      : null;
  }

  if (sender.type === "agent" || sender.type === "tool") {
    // Tool results carry the requesting agent's identity in sender.id/name
    const externalId = sender.id ?? sender.name ?? sender.externalId ?? null;
    return externalId
      ? {
        externalId,
        participantType: "agent",
        agentId: sender.id ?? sender.name ?? null,
      }
      : null;
  }

  return null;
}

export const participantLifecycleProcessor: EventProcessor<
  NewMessageEventPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    if (!hasParticipantCollection(deps.context.collections)) return;

    const participantCollection = (deps.context.collections as any)?.participant;
    if (!participantCollection || typeof participantCollection.upsertIdentity !== "function") return;

    const payload = event.payload as NewMessageEventPayload;

    let senderRecord: any = null;

    const senderIdentity = buildSenderIdentity(payload);
    if (senderIdentity) {
      const metadata = payload.sender?.metadata &&
          typeof payload.sender.metadata === "object"
        ? payload.sender.metadata as Record<string, unknown>
        : undefined;
      const email = senderIdentity.participantType === "human" &&
          typeof metadata?.email === "string"
        ? metadata.email
        : null;

      senderRecord = await participantCollection.upsertIdentity({
        externalId: senderIdentity.externalId,
        participantType: senderIdentity.participantType,
        name: payload.sender?.name ?? null,
        email,
        agentId: senderIdentity.agentId ?? null,
        ...(metadata !== undefined ? { metadata } : {}),
      });
    }

    for (const agent of deps.context.agents ?? []) {
      const externalId = agent.id ?? agent.name;
      if (!externalId) continue;
      
      await participantCollection.upsertIdentity({
        externalId,
        participantType: "agent",
        name: agent.name,
        agentId: agent.id ?? agent.name,
        metadata: null,
      });
    }

    return senderRecord;
  },
};

export const { shouldProcess, process } = participantLifecycleProcessor;
