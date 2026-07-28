import type { Event, EventProcessor, ProcessorDeps } from "@/types/index.ts";
import {
  ensureParticipantMembership,
  getParticipantCollection,
} from "./_shared.ts";

export const processorId = "participant_lifecycle";
export const eventTypes = ["thread.created"] as const;
export const priority = 100;

export const threadParticipantLifecycleProcessor: EventProcessor<
  unknown,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const participantCollection = getParticipantCollection(deps);
    if (!participantCollection) return;

    const seen = new Set<string>();
    for (const agent of deps.context.agents ?? []) {
      const externalId = (agent.id ?? agent.name)?.trim();
      if (!externalId || seen.has(externalId)) continue;
      seen.add(externalId);

      const participant = await participantCollection.upsertIdentity({
        externalId,
        participantType: "agent",
        name: agent.name,
        agentId: agent.id ?? agent.name,
        metadata: null,
      });
      await ensureParticipantMembership({
        deps,
        event,
        participantNodeId: participant.id,
      });
    }
  },
};

export const { shouldProcess, process } = threadParticipantLifecycleProcessor;
