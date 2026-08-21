import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { llmAttemptContent } from "@copilotz/copilotz/content";
import {
  agentAskMetadata,
  deriveWorkflowId,
  textWorkflowAttemptEventMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
} from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { requireAgent } from "@copilotz/copilotz/agents";
import type { ToolInvocation } from "@copilotz/copilotz/llm";
import { createWorkflowPipelineMetadata } from "@copilotz/copilotz/tools";
import { threadMessageFeature } from "../features/thread-message.ts";
import { toolExecutionFeature } from "../features/tool-execution.ts";
import {
  asRecord,
  collectionEventRecord,
  loadParticipant,
  optionalText,
  parseJsonText,
  recordThreadId,
  requiredText,
  resolvedValue,
  stringArray,
  toolCatalogFor,
  valueContent,
} from "./helpers.ts";

async function toolCallsFromAttempt(
  context: CopilotzProcessorContext,
  attempt: CollectionRecord,
): Promise<readonly ToolInvocation[]> {
  const ref = llmAttemptContent(attempt).toolCalls;
  if (!ref) return Object.freeze([]);
  const resolved = await context.content.resolve(ref);
  const value = resolvedValue(resolved);
  return Object.freeze(Array.isArray(value) ? value as ToolInvocation[] : []);
}

export const projectTextResultProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.project-text-result",
    on: [{
      eventType: "llm_attempt.updated",
      data: { record: { status: "completed" } },
    }],
    requires: {
      features: {
        threadMessage: threadMessageFeature,
        toolExecution: toolExecutionFeature,
      },
    },
    async handle(event, context) {
      const record = collectionEventRecord(event);
      const attempt = record;
      if (!textWorkflowAttemptEventMetadata(asRecord(attempt.metadata))) return;
      if (String(attempt.status) !== "completed") return;
      const participant = optionalText(attempt.participantId)
        ? await loadParticipant(context, optionalText(attempt.participantId)!)
        : null;
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM attempt '${attempt.id}' has no agent participant.`,
        );
      }
      const content = llmAttemptContent(attempt);
      const toolCalls = await toolCallsFromAttempt(context, attempt);
      const activeAsk = agentAskMetadata(attempt.metadata);
      const outputAsk = activeAsk
        ? Object.freeze({
          ...activeAsk,
          phase: toolCalls.length ? "progress" as const : "answer" as const,
          answerAttemptId: attempt.id,
        })
        : null;
      const messageMetadata = withWorkflowMetadata(
        outputAsk ? withAgentAskMetadata(undefined, outputAsk) : undefined,
        {
          kind: "agent_output",
          llmAttemptId: attempt.id,
          agentParticipantId: participant.id,
        },
      );
      const outputMessage = await context.features.threadMessage.create({
        id: await deriveWorkflowId("message", attempt.id, "output"),
        threadId: recordThreadId(attempt),
        sender: participant,
        recipientIds: [],
        content: content.answer ? [content.answer] : [],
        visibility: { kind: "public" },
        metadata: messageMetadata,
      }, {
        operationKey: "project:agent-message",
      }) as CollectionRecord;
      const outputMessageId = String(outputMessage.id);
      if (!toolCalls.length) return;

      const agent = requireAgent(
        context,
        requiredText(optionalText(attempt.agentId), "LLM attempt agent id"),
      );
      const toolCatalog = toolCatalogFor(context, agent);
      const granted = new Set(stringArray(attempt.availableToolIds));
      const availableTools = (await toolCatalog.forAgent(
        context,
        agent,
      )).filter((tool) => granted.has(tool.key));
      const toolsByKey = new Map(
        availableTools.map((tool) => [tool.key, tool]),
      );

      const batchId = attempt.id;
      const items = [];
      for (const [index, call] of toolCalls.entries()) {
        const toolId = requiredText(call.tool?.id, "Tool call tool id");
        const tool = toolsByKey.get(toolId);
        const parsedArguments = typeof call.args === "string"
          ? parseJsonText(call.args)
          : call.args;
        const preparedArguments = await context.content.prepare(
          valueContent(parsedArguments, "tool.arguments"),
          { operationKey: `project:tool:${call.id}:arguments` },
        );
        const executionMetadata = withWorkflowMetadata(
          activeAsk ? withAgentAskMetadata(undefined, activeAsk) : undefined,
          {
            kind: "tool_execution",
            llmAttemptId: attempt.id,
            parentLlmAttemptId: attempt.id,
            toolCallId: call.id,
            batchId,
            batchSize: toolCalls.length,
            batchIndex: index,
            ...(outputMessageId ? { sourceMessageId: outputMessageId } : {}),
            agentParticipantId: participant.id,
            ...(call.pipeline
              ? { pipeline: createWorkflowPipelineMetadata(call.pipeline) }
              : {}),
          },
        );
        const toolName = typeof tool?.name === "string"
          ? tool.name
          : call.tool?.name ?? toolId;
        items.push({
          id: await deriveWorkflowId("tool", attempt.id, call.id),
          ...(outputMessageId ? { messageId: outputMessageId } : {}),
          participantId: participant.id,
          agentId: optionalText(attempt.agentId),
          toolCallId: call.id,
          tool: { id: toolId, name: toolName },
          arguments: preparedArguments,
          status: "running",
          historyVisibility: tool?.historyPolicy?.visibility ?? "public_status",
          metadata: executionMetadata,
          sender: {
            externalId: `tool:${toolId}`,
            participantType: "tool" as const,
            name: toolName,
          },
        });
      }
      await context.features.toolExecution.createBatch({
        threadId: recordThreadId(attempt),
        items,
      }, { operationKey: `project:tools:${attempt.id}:create` });
    },
  });
