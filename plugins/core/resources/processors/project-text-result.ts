import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import {
  CORE_LLM_CALL_METADATA_SCHEMA,
  CORE_TOOL_PLAN_METADATA_SCHEMA,
  coreLlmCallMetadata,
  withAgentAskMetadata,
  withCoreToolPlanMetadata,
  withWorkflowMetadata,
} from "../../internal/workflow-metadata.ts";
import type { LlmCallOutput, LlmToolCall } from "@copilotz/copilotz/llm";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../context.ts";
import {
  type CoreToolPlanBase,
  invokeToolPlanAction,
  toolActionMetadataAt,
  validateCoreToolPlan,
} from "../../internal/tool-plan.ts";
import { asRecord, loadParticipant } from "./helpers.ts";

function llmOutput(value: unknown): LlmCallOutput {
  const output = asRecord(value);
  if (
    typeof output.model !== "string" || typeof output.adapter !== "string" ||
    typeof output.providerModel !== "string" || !Array.isArray(output.content)
  ) throw new TypeError("llm.call completed without a valid settled output.");
  return output as LlmCallOutput;
}

export const projectTextResultProcessor: Processor<
  CoreToolProcessorContext
> = defineProcessor<CoreToolProcessorContext>({
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
      throw new Error(`LLM call '${actionRunId}' has no agent participant.`);
    }
    const rawToolCalls = Object.freeze(
      structuredClone(output.toolCalls ?? []) as readonly LlmToolCall[],
    );
    const toolCalls = rawToolCalls.length
      ? validateCoreToolPlan(context, {
        agentId: metadata.agentId,
        availableToolIds: metadata.availableToolIds,
        calls: rawToolCalls,
      })
      : rawToolCalls;
    const planMessageId = await deriveWorkflowId(
      "message",
      actionRunId,
      "output",
    );
    const planId = toolCalls.length
      ? await deriveWorkflowId("tool-plan", actionRunId)
      : undefined;
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
    const outputMetadata = planId
      ? withCoreToolPlanMetadata(semanticOutputMetadata, {
        schema: CORE_TOOL_PLAN_METADATA_SCHEMA,
        planId,
        planSize: toolCalls.length,
      })
      : semanticOutputMetadata;
    const messageMetadata = withWorkflowMetadata(
      outputAsk
        ? withAgentAskMetadata(outputMetadata, outputAsk)
        : outputMetadata,
      {
        kind: "agent_output",
        llmAttemptId: actionRunId,
        parentLlmAttemptId: metadata.parentActionRunId,
        sourceMessageId: metadata.triggerMessageId,
        agentParticipantId: participant.id,
      },
    );
    const createMessage = context.actions.createThreadMessage;
    if (typeof createMessage !== "function") {
      throw new Error("Core requires the createThreadMessage Action.");
    }
    const outputMessage = await createMessage({
      id: planMessageId,
      threadId: metadata.threadId,
      sender: participant,
      recipientIds: [],
      content: output.content,
      visibility: structuredClone(metadata.responseVisibility),
      metadata: messageMetadata,
    }, {
      operationKey: "project:agent-message",
      signal: context.signal,
    }) as CollectionRecord;
    if (!toolCalls.length || !planId) return;

    const plan: CoreToolPlanBase = Object.freeze({
      planId,
      planMessageId: String(outputMessage.id),
      planSize: toolCalls.length,
      threadId: metadata.threadId,
      triggerMessageId: metadata.triggerMessageId,
      agentId: metadata.agentId,
      agentParticipantId: metadata.agentParticipantId,
      initiatorParticipantId: metadata.initiatorParticipantId,
      availableToolIds: metadata.availableToolIds,
      responseVisibility: metadata.responseVisibility,
      parentLlmActionRunId: actionRunId,
      ...(metadata.ask ? { ask: metadata.ask } : {}),
    });
    await invokeToolPlanAction(
      context,
      toolActionMetadataAt(plan, toolCalls[0], 0),
    );
  },
});
