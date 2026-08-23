import {
  agentAskMetadata,
  deriveWorkflowId,
  withAgentAskMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/events";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { isSettledActionError } from "@copilotz/copilotz/actions";
import { agentUsesSessionRuntime } from "@copilotz/copilotz/agents";
import {
  coreAgent,
  type CoreProcessorContext,
  coreWorkflowContext,
} from "../../context.ts";
import {
  asRecord,
  collectionEventRecord,
  listThreadMessages,
  loadParticipant,
  participantAgentId,
  policyOptions,
  requiredText,
  stringArray,
  toolCatalogFor,
} from "./helpers.ts";
export const messageRouterProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.message-to-text-attempt",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
      const workflowContext = coreWorkflowContext(context);
      if (!event.routing?.recipientIds?.length) return;
      if (!event.durable || !event.threadId) return;
      const record = collectionEventRecord(event);
      const sender = await loadParticipant(context, String(record.senderId));
      if (!sender) {
        throw new Error(`Message '${record.id}' sender was not found.`);
      }
      const metadata = workflowMetadata(asRecord(record.metadata));
      const ask = agentAskMetadata(asRecord(record.metadata));
      if (
        metadata?.continuation === "realtime" ||
        metadata?.continuation === "none"
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
        history.slice(0, triggerIndex + 1).map((item) => item.id),
      );
      for (const recipientId of new Set(stringArray(record.recipientIds))) {
        const participant = await loadParticipant(context, recipientId);
        if (!participant || participant.participantType !== "agent") continue;
        const agentId = participantAgentId(participant);
        const agent = coreAgent(context.resources, agentId);
        if (!agent) continue;
        const useSession = agentUsesSessionRuntime(agent);
        const options = policyOptions(agent);
        const toolCatalog = toolCatalogFor(agent);
        const available = await toolCatalog.forAgent(workflowContext, agent);
        const tools = options.resolveAgentTools
          ? await options.resolveAgentTools({
            agent,
            tools: available,
            sourceEvent: event,
            context: workflowContext,
          })
          : available;
        const availableIds = new Set(available.map((tool) => tool.key));
        const grantedIds = new Set<string>();
        for (const tool of tools) {
          if (!availableIds.has(tool.key)) {
            throw new Error(
              `Agent tool resolver granted unavailable tool '${tool.key}'.`,
            );
          }
          if (grantedIds.has(tool.key)) {
            throw new Error(
              `Agent tool resolver returned duplicate tool '${tool.key}'.`,
            );
          }
          grantedIds.add(tool.key);
        }
        const continuationKey = metadata?.kind === "tool_result"
          ? `${requiredText(metadata.batchId, "Tool batch id")}:${recipientId}`
          : `${record.id}:${recipientId}`;
        const attemptMetadata = {
          triggerMessageId: record.id,
          ...(metadata?.batchId ? { batchId: metadata.batchId } : {}),
        };
        const id = await deriveWorkflowId("llm", continuationKey);
        const input = {
          id,
          namespace: context.namespace,
          threadId: String(record.threadId),
          messageId: record.id,
          participantId: participant.id,
          initiatorParticipantId: sender.id,
          agentId,
          ...(metadata?.parentLlmAttemptId ?? ask?.callingAttemptId
            ? {
              parentAttemptId: metadata?.parentLlmAttemptId ??
                ask?.callingAttemptId,
            }
            : {}),
          inputMessageIds: [...historyIds],
          availableToolIds: tools.map((tool) => tool.key),
          status: "running",
          attemptIndex: 0,
          content: [],
          startedAt: event.createdAt,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          metadata: ask
            ? withAgentAskMetadata(attemptMetadata, ask)
            : attemptMetadata,
          sourceEvent: event,
        };
        const action = useSession
          ? context.actions.runLlmSession
          : context.actions.generateLlm;
        try {
          await action(input, {
            operationKey: `route:${continuationKey}`,
            identity: {
              correlationId: event.correlationId,
              causationId: event.id,
            },
          });
        } catch (error) {
          if (!isSettledActionError(error)) throw error;
        }
      }
    },
  });
