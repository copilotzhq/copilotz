import type { Event, EventProcessor, ProcessorDeps } from "@/types/index.ts";
import type { NewMessageEventPayload } from "@/database/schemas/index.ts";
import {
  ensureParticipantMembership,
  getParticipantCollection,
} from "./_shared.ts";

export const processorId = "participant_lifecycle";
export const eventTypes = ["message.created"] as const;
export const priority = 100;

function buildSenderIdentity(payload: NewMessageEventPayload): {
  externalId: string;
  participantType: "human" | "agent" | "job";
  agentId?: string | null;
} | null {
  const sender = payload.sender;
  if (!sender) return null;

  if (sender.type === "user") {
    const externalId = sender.externalId ?? sender.id ?? sender.name ?? null;
    return externalId ? { externalId, participantType: "human" } : null;
  }

  if (sender.type === "job") {
    const externalId = sender.externalId ?? sender.id ?? sender.name ?? null;
    return externalId ? { externalId, participantType: "job" } : null;
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

function publicSenderMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const { _private: _ignored, ...publicMetadata } = metadata as Record<
    string,
    unknown
  >;
  return publicMetadata;
}

export const participantLifecycleProcessor: EventProcessor<
  NewMessageEventPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const participantCollection = getParticipantCollection(deps);
    if (!participantCollection) return;

    const payload = event.payload as NewMessageEventPayload;

    let senderRecord: any = null;

    const senderIdentity = buildSenderIdentity(payload);
    if (senderIdentity) {
      const metadata = publicSenderMetadata(payload.sender?.metadata);
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
      if (senderRecord?.id) {
        await ensureParticipantMembership({
          deps,
          event,
          participantNodeId: senderRecord.id,
        });
      }
    }

    return senderRecord;
  },
};

export const { shouldProcess, process } = participantLifecycleProcessor;
