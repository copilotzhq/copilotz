import type { Event, EventProcessor, ProcessorDeps } from "@/types/index.ts";
import type { NewMessageEventPayload } from "@/database/schemas/index.ts";
import {
  createParticipantService,
  hasParticipantCollection,
} from "@/runtime/collections/native.ts";

export const priority = 100;

function buildSenderExternalId(payload: NewMessageEventPayload): string | null {
  const sender = payload.sender;
  if (!sender || sender.type !== "user") return null;
  return sender.externalId ?? sender.id ?? null;
}

export const participantLifecycleProcessor: EventProcessor<
  NewMessageEventPayload,
  ProcessorDeps
> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    if (!hasParticipantCollection(deps.context.collections)) return;

    const payload = event.payload as NewMessageEventPayload;
    const participantService = createParticipantService({
      collections: deps.context.collections,
      ops: deps.db.ops,
    });

    const senderExternalId = buildSenderExternalId(payload);
    if (senderExternalId) {
      const metadata = payload.sender?.metadata &&
          typeof payload.sender.metadata === "object"
        ? payload.sender.metadata as Record<string, unknown>
        : undefined;
      const email = typeof metadata?.email === "string" ? metadata.email : null;

      await participantService.upsert(
        senderExternalId,
        "human",
        deps.context.namespace ?? null,
        {
          name: payload.sender?.name ?? null,
          email,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      );
    }

    for (const agent of deps.context.agents ?? []) {
      const externalId = agent.id ?? agent.name;
      if (!externalId) continue;
      await participantService.upsert(
        externalId,
        "agent",
        deps.context.namespace ?? null,
        {
          name: agent.name,
          agentId: agent.id ?? agent.name,
          metadata: null,
        },
      );
    }
  },
};

export const { shouldProcess, process } = participantLifecycleProcessor;
