import {
  agentAskMetadata,
  deriveWorkflowId,
  withAgentAskMetadata,
  type WorkflowMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { agentUsesSessionRuntime } from "@copilotz/copilotz/agents";
import {
  asRecord,
  collectionEventRecord,
  listThreadMessages,
  loadParticipant,
  participantAgentId,
  policyOptions,
  requireCollection,
  requiredText,
  stringArray,
  toolCatalogFor,
} from "./helpers.ts";

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function isLastSettledToolResult(
  context: CopilotzProcessorContext,
  threadId: string,
  metadata: WorkflowMetadata,
): Promise<boolean> {
  const batchSize = metadata.batchSize ?? 1;
  if (batchSize <= 1) return true;
  const batchId = requiredText(metadata.batchId, "Tool batch id");
  const executionId = requiredText(
    metadata.toolExecutionId,
    "Tool execution id",
  );
  const executions = requireCollection(context, "tool_execution");
  const history = await executions.list({
    where: { threadId },
    order: { field: "createdAt", direction: "asc" },
    limit: 1_000,
  });
  const batch = history.filter((record) =>
    workflowMetadata(asRecord(record.metadata))?.batchId === batchId
  );
  const terminal = batch.filter((record) =>
    TERMINAL_TOOL_STATUSES.has(String(record.status))
  );
  if (terminal.length < batchSize) return false;
  const last = [...terminal].sort((left, right) => {
    const finished = String(left.finishedAt ?? left.updatedAt).localeCompare(
      String(right.finishedAt ?? right.updatedAt),
    );
    return finished !== 0
      ? finished
      : String(left.id).localeCompare(String(right.id));
  }).at(-1);
  return last?.id === executionId;
}

export const messageRouterProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.message-to-text-attempt",
    on: [{ eventType: "message.created" }],
    async handle(event, context) {
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
      if (
        metadata?.kind === "tool_result" &&
        !await isLastSettledToolResult(
          context,
          String(record.threadId),
          metadata,
        )
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
        const agent = context.agents[agentId];
        if (!agent) continue;
        if (agentUsesSessionRuntime(agent)) {
          const running = await requireCollection(context, "llm_attempt")
            .queries.byThreadParticipantStatus({
              threadId: String(record.threadId),
              participantId: participant.id,
              status: "running",
            });
          if (running.length > 0) continue;
        }
        const options = policyOptions(agent);
        const toolCatalog = toolCatalogFor(context, agent);
        const available = await toolCatalog.forAgent(context, agent);
        const tools = options.resolveAgentTools
          ? await options.resolveAgentTools({
            agent,
            tools: available,
            sourceEvent: event,
            context,
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
        await context.collections.llm_attempt.create({
          id,
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
          metadata: ask
            ? withAgentAskMetadata(attemptMetadata, ask)
            : attemptMetadata,
        }, {
          operationKey: `route:${continuationKey}`,
          threadId: String(record.threadId),
          identity: {
            metadata: ask
              ? withAgentAskMetadata(attemptMetadata, ask)
              : attemptMetadata,
          },
        });
      }
    },
  });
