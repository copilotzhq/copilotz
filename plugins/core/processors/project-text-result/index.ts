import {
  snapshotRootTools,
  snapshotToolStageActionIds,
  snapshotToolStageHistory,
} from "./tool-plan.ts";
/** Projects terminal LLM output into Messages or durable Tool plans. @module */

import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import {
  CORE_LLM_CALL_METADATA_SCHEMA,
  CORE_TOOL_PLAN_METADATA_SCHEMA,
  coreLlmCallMetadata,
  withAgentAskMetadata,
  withCoreAgentTurnMetadata,
  withCoreToolPlanMetadata,
  withWorkflowMetadata,
} from "../../shared/workflow-metadata.ts";
import type { LlmCallOutput, LlmToolCall } from "@copilotz/copilotz/llm";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../shared/runtime-context.ts";
import {
  calls,
  type CoreToolPlanBase,
  createDurableToolPlan,
  dispatchInitialStages,
} from "../../shared/tool-plan.ts";
import { asRecord, loadParticipant } from "../../shared/helpers.ts";

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
    if (!event.durable) return;
    const lifecycle = parseActionLifecycleEvent(event, {
      actionId: "llm.call",
      statuses: ["completed"],
      requireRoot: true,
    });
    if (!lifecycle || lifecycle.status !== "completed") return;
    const metadata = coreLlmCallMetadata(lifecycle.metadata);
    if (!metadata) return;
    const actionRunId = lifecycle.actionRunId;
    const output = llmOutput(lifecycle.output);
    const participant = await loadParticipant(
      context,
      metadata.agentParticipantId,
    );
    if (!participant || participant.participantType !== "agent") {
      throw new Error(`LLM call '${actionRunId}' has no agent participant.`);
    }
    const rawToolCalls = structuredClone(
      output.toolCalls ?? [],
    ) as readonly LlmToolCall[];
    if (rawToolCalls.length) {
      // A retry after the plan committed only resumes its dispatch; the plan
      // was validated against the grants current when it was created.
      const existing = await context.collections.toolPlan?.get({
        id: await deriveWorkflowId("tool-plan", actionRunId),
      });
      if (existing) {
        await dispatchInitialStages(context, event, existing);
        return;
      }
    }
    const toolCalls = rawToolCalls.length ? calls(rawToolCalls) : rawToolCalls;
    const planMessageId = await deriveWorkflowId(
      "message",
      actionRunId,
      "output",
    );
    const planId = toolCalls.length
      ? await deriveWorkflowId("tool-plan", actionRunId)
      : undefined;
    const outputAsk = metadata.ask
      ? ({
        ...metadata.ask,
        phase: toolCalls.length ? "progress" as const : "answer" as const,
        answerAttemptId: actionRunId,
      } as const)
      : null;
    const semanticOutputMetadata = {
      llmToolCalls: toolCalls,
      ...(output.reasoning
        ? { llmReasoning: structuredClone(output.reasoning) }
        : {}),
      ...(output.nativeReasoning
        ? { llmNativeReasoning: structuredClone(output.nativeReasoning) }
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
        agentId: metadata.agentId,
        agentParticipantId: participant.id,
        initiatorParticipantId: metadata.initiatorParticipantId,
      },
    );
    const scopedMessageMetadata = metadata.agentTurn
      ? withCoreAgentTurnMetadata(messageMetadata, metadata.agentTurn)
      : messageMetadata;
    const createMessage = context.actions.createThreadMessage;
    if (typeof createMessage !== "function") {
      throw new Error("Core requires the createThreadMessage Action.");
    }
    const outputMessage = await createMessage({
      id: planMessageId,
      threadId: metadata.threadId,
      sender: participant,
      recipientIds: outputAsk ? [outputAsk.askingParticipantId] : [],
      content: output.content,
      visibility: structuredClone(metadata.responseVisibility),
      metadata: scopedMessageMetadata,
      ...(metadata.agentTurn ? { historyScopeId: metadata.agentTurn.id } : {}),
    }, {
      operationKey: "project:agent-message",
      signal: context.signal,
    }) as CollectionRecord;
    if (!toolCalls.length || !planId) return;

    const plan: CoreToolPlanBase = {
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
      ...(metadata.agentTurn ? { agentTurn: metadata.agentTurn } : {}),
      rootTools: snapshotRootTools(
        context,
        toolCalls,
        metadata.availableToolIds,
      ),
      stageHistoryVisibility: snapshotToolStageHistory(
        context,
        toolCalls,
        metadata.availableToolIds,
      ),
      stageActionIds: snapshotToolStageActionIds(
        context,
        toolCalls,
        metadata.availableToolIds,
      ),
      ...(metadata.ask ? { ask: metadata.ask } : {}),
    } as const;
    await createDurableToolPlan(context, plan, toolCalls);
    const created = await context.collections.toolPlan?.get({ id: planId });
    if (!created) throw new Error(`Tool plan '${planId}' was not found.`);
    await dispatchInitialStages(context, event, created);
  },
});

export default projectTextResultProcessor;
