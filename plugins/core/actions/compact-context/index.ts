/** Durable foreground maintenance; private maintenance content stays separate. @module */
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { CoreActionContext } from "../../internal/runtime-context.ts";
import { coreAgent } from "../../internal/runtime-context.ts";
import {
  loadCoreThreadMetadata,
  participantAgentId,
} from "../../processors/internal/helpers.ts";
import { mapParticipantRecord } from "../../../core-collections/internal/projections.ts";
import { isContextResource } from "../../resources/context/index.ts";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "threadId",
    "agentId",
    "participantId",
    "triggerMessageId",
    "estimatedTokens",
    "limitEstimatedTokens",
  ],
  properties: {
    threadId: { type: "string", minLength: 1 },
    agentId: { type: "string", minLength: 1 },
    participantId: { type: "string", minLength: 1 },
    triggerMessageId: { type: "string", minLength: 1 },
    historyAfterMessageId: { type: "string", minLength: 1 },
    estimatedTokens: { type: "number", minimum: 1 },
    limitEstimatedTokens: { type: "number", minimum: 1 },
  },
} as const;

type Input = {
  threadId: string;
  agentId: string;
  participantId: string;
  triggerMessageId: string;
  historyAfterMessageId?: string;
  estimatedTokens: number;
  limitEstimatedTokens: number;
};
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["advanced"],
  properties: { advanced: { type: "boolean" } },
} as const;

type Output = { advanced: boolean };

export const compactContextAction: ActionDefinition<
  Input,
  Output,
  CoreActionContext,
  typeof inputSchema,
  typeof outputSchema
> = defineAction({
  id: "copilotz.core.context.compact",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const metadata = await loadCoreThreadMetadata(context, input.threadId);
    const participant = metadata.participantRecords.find((entry) =>
      entry.id === input.participantId
    );
    const agent = coreAgent(context.resources, input.agentId);
    if (
      !agent || participant?.participantType !== "agent" ||
      participantAgentId(participant) !== agent.id
    ) {
      throw new Error(
        "The Agent is no longer authorized in this conversation.",
      );
    }
    for (
      const resource of Object.values(context.resources.promptContext ?? {})
    ) {
      if (!isContextResource(resource) || !resource.compact) continue;
      context.signal.throwIfAborted();
      if (
        await resource.compact({
          ...input,
          purpose: "conversation",
          agent,
          participant: mapParticipantRecord(participant),
          thread: metadata.thread,
          collections: context.collections,
          context: context as unknown as ProcessorContext,
          signal: context.signal,
          idempotencyKey: context.operationKey,
        })
      ) return { advanced: true };
    }
    throw new Error(
      "Conversation history cannot be consolidated into a safe bounded range.",
    );
  },
});

export default compactContextAction;
