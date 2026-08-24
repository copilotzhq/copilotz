import { isSettledActionError } from "@copilotz/copilotz/actions";
import {
  agentAskMetadata,
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmStreamMetadata,
  coreToolActionMessageMetadata,
  defineCoreLlmCallMetadata,
  workflowMetadata,
} from "../../internal/workflow-metadata.ts";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { buildCoreLlmRequest } from "../../internal/agents/prompt.ts";
import type { AgentResource } from "../../agent.ts";
import { coreAgent, type CoreProcessorContext } from "../../context.ts";
import {
  asRecord,
  collectionEventRecord,
  listThreadMessages,
  loadParticipant,
  participantAgentId,
  requiredText,
  stringArray,
  toolsForAgent,
} from "./helpers.ts";

function modelFor(agent: AgentResource): string {
  return requiredText(
    agent.models.generate ?? agent.models.session,
    `Agent '${agent.id}' model`,
  );
}

export const messageRouterProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.message-to-llm-call",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      if (!event.routing?.recipientIds?.length) return;
      if (!event.durable || !event.threadId) return;
      const record = collectionEventRecord(event);
      const sender = await loadParticipant(context, String(record.senderId));
      if (!sender) {
        throw new Error(`Message '${record.id}' sender was not found.`);
      }
      const workflow = workflowMetadata(asRecord(record.metadata));
      const ask = agentAskMetadata(asRecord(record.metadata));
      const toolAction = coreToolActionMessageMetadata(record.metadata);
      if (
        workflow?.continuation === "realtime" ||
        workflow?.continuation === "none"
      ) return;
      const history = await listThreadMessages(
        context,
        String(record.threadId),
      );
      const triggerIndex = history.findIndex((item) => item.id === record.id);
      if (triggerIndex < 0) {
        throw new Error(`Trigger message '${record.id}' was not found.`);
      }
      const historyIds = Object.freeze(
        history.slice(0, triggerIndex + 1).map((item) => String(item.id)),
      );
      for (const recipientId of new Set(stringArray(record.recipientIds))) {
        const participant = await loadParticipant(context, recipientId);
        if (!participant || participant.participantType !== "agent") continue;
        const agentId = participantAgentId(participant);
        const agent = coreAgent(context.resources, agentId);
        if (!agent) continue;
        const availableTools = toolsForAgent(context, agent);
        const availableToolIds = Object.freeze(
          availableTools.map((tool) => tool.alias),
        );
        const request = await buildCoreLlmRequest(context, {
          agent,
          participant,
          threadId: String(record.threadId),
          messageIds: historyIds,
          tools: availableTools,
        });
        const continuationKey = workflow?.kind === "tool_result"
          ? `${requiredText(toolAction?.planId, "Tool plan id")}:${recipientId}`
          : `${record.id}:${recipientId}`;
        const metadata = defineCoreLlmCallMetadata({
          schema: CORE_LLM_CALL_METADATA_SCHEMA,
          threadId: String(record.threadId),
          triggerMessageId: String(record.id),
          agentId,
          agentParticipantId: String(participant.id),
          initiatorParticipantId: toolAction?.initiatorParticipantId ??
            String(sender.id),
          availableToolIds,
          responseVisibility: structuredClone(
            toolAction?.responseVisibility ?? event.visibility,
          ),
          ...(toolAction?.parentLlmActionRunId ??
              workflow?.parentLlmAttemptId ?? ask?.callingAttemptId
            ? {
              parentActionRunId: toolAction?.parentLlmActionRunId ??
                workflow?.parentLlmAttemptId ?? ask?.callingAttemptId,
            }
            : {}),
          ...(ask ? { ask: structuredClone(ask) } : {}),
        });
        try {
          await context.actions.callLlm({
            model: modelFor(agent),
            request,
            stream: {
              metadata: coreLlmStreamMetadata(agent, ask ?? undefined),
            },
          }, {
            operationKey: `route:${continuationKey}`,
            identity: {
              correlationId: event.correlationId,
              causationId: event.id,
            },
            metadata,
            signal: context.signal,
          });
        } catch (error) {
          if (!isSettledActionError(error)) throw error;
        }
      }
    },
  });
