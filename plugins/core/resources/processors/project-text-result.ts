import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import {
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmCallMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
} from "../../internal/workflow-metadata.ts";
import type {
  LlmCallOutput,
  LlmJsonObject,
  LlmToolCall,
} from "@copilotz/copilotz/llm";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  coreAgent,
  type CoreProcessorContext,
  coreWorkflowContext,
} from "../../context.ts";
import {
  asRecord,
  loadParticipant,
  toolCatalogFor,
  valueContent,
} from "./helpers.ts";

function llmOutput(value: unknown): LlmCallOutput {
  const output = asRecord(value);
  if (
    typeof output.model !== "string" || typeof output.adapter !== "string" ||
    typeof output.providerModel !== "string" || !Array.isArray(output.content)
  ) throw new TypeError("llm.call completed without a valid settled output.");
  return output as LlmCallOutput;
}

function legacyInvocation(
  call: LlmToolCall,
  name: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: call.id,
    tool: Object.freeze({ id: call.action, name }),
    args: JSON.stringify(call.input),
  });
}

export const projectTextResultProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.project-llm-result",
    on: [{
      eventType: "llm.call.completed",
      data: {
        status: "completed",
        metadata: { schema: CORE_LLM_CALL_METADATA_SCHEMA },
      },
    }],
    async handle(event, context) {
      const lifecycle = asRecord(event.data);
      const metadata = coreLlmCallMetadata(lifecycle.metadata);
      if (!metadata) return;
      const actionRunId = String(lifecycle.actionRunId ?? "").trim();
      if (!actionRunId) throw new Error("llm.call lifecycle has no run ID.");
      const output = llmOutput(lifecycle.output);
      const participant = await loadParticipant(
        context,
        metadata.agentParticipantId,
      );
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM call '${actionRunId}' has no agent participant.`,
        );
      }
      const toolCalls = Object.freeze(
        structuredClone(output.toolCalls ?? []) as readonly LlmToolCall[],
      );
      const outputAsk = metadata.ask
        ? Object.freeze({
          ...metadata.ask,
          phase: toolCalls.length ? "progress" as const : "answer" as const,
          answerAttemptId: actionRunId,
        })
        : null;
      const semanticOutputMetadata = {
        llmToolCalls: toolCalls,
        ...(output.reasoning
          ? { llmReasoning: structuredClone(output.reasoning) }
          : {}),
      };
      const messageMetadata = withWorkflowMetadata(
        outputAsk
          ? withAgentAskMetadata(semanticOutputMetadata, outputAsk)
          : semanticOutputMetadata,
        {
          kind: "agent_output",
          llmAttemptId: actionRunId,
          parentLlmAttemptId: metadata.parentActionRunId,
          sourceMessageId: metadata.triggerMessageId,
          agentParticipantId: participant.id,
        },
      );
      const outputMessage = await context.actions.createThreadMessage({
        id: await deriveWorkflowId("message", actionRunId, "output"),
        threadId: metadata.threadId,
        sender: participant,
        recipientIds: [],
        content: output.content,
        visibility: { kind: "public" },
        metadata: messageMetadata,
      }, {
        operationKey: "project:agent-message",
      }) as CollectionRecord;
      if (!toolCalls.length) return;

      const agent = coreAgent(context.resources, metadata.agentId);
      if (!agent) {
        throw new Error(`Unknown agent resource '${metadata.agentId}'.`);
      }
      const availableTools = (await toolCatalogFor().forAgent(
        coreWorkflowContext(context),
        agent,
      )).filter((tool) => metadata.availableToolIds.includes(tool.key));
      const toolsByKey = new Map(
        availableTools.map((tool) => [tool.key, tool]),
      );
      const items = [];
      for (const [index, call] of toolCalls.entries()) {
        const tool = toolsByKey.get(call.action);
        if (!tool) {
          throw new Error(
            `LLM call '${actionRunId}' requested unavailable tool '${call.action}'.`,
          );
        }
        const preparedArguments = await context.content.prepare(
          valueContent(call.input as LlmJsonObject, "tool.arguments"),
          { operationKey: `project:tool:${call.id}:arguments` },
        );
        const argumentsContent = await context.content.materialize(
          preparedArguments,
        );
        const invocation = legacyInvocation(call, tool.name);
        const executionMetadata = withWorkflowMetadata(
          metadata.ask
            ? withAgentAskMetadata(undefined, metadata.ask)
            : undefined,
          {
            kind: "tool_action",
            llmAttemptId: actionRunId,
            parentLlmAttemptId: actionRunId,
            toolCallId: call.id,
            batchId: actionRunId,
            batchSize: toolCalls.length,
            batchIndex: index,
            sourceMessageId: String(outputMessage.id),
            agentParticipantId: participant.id,
          },
        );
        items.push({
          id: await deriveWorkflowId("tool", actionRunId, call.id),
          namespace: context.namespace,
          threadId: metadata.threadId,
          messageId: String(outputMessage.id),
          participantId: participant.id,
          agentId: metadata.agentId,
          toolCallId: call.id,
          invocation,
          tool: { id: call.action, name: tool.name },
          arguments: argumentsContent,
          availableToolIds: metadata.availableToolIds,
          status: "running",
          content: [],
          startedAt: event.createdAt,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          historyVisibility: tool.historyPolicy?.visibility ?? "public_status",
          metadata: executionMetadata,
          sender: {
            externalId: `tool:${call.action}`,
            participantType: "tool" as const,
            name: tool.name,
          },
          sourceEvent: event,
        });
      }
      await context.actions.executeToolBatch({
        batchId: actionRunId,
        items,
      }, {
        operationKey: `project:tools:${actionRunId}:call-batch`,
        signal: context.signal,
      });
    },
  });
