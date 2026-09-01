/** Projects terminal ordinary Agent LLM failures into public timeline Messages. @module */

import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmCallMetadata,
  withAgentFailureMetadata,
  withWorkflowMetadata,
} from "../../internal/workflow-metadata.ts";
import type { CoreToolProcessorContext } from "../../internal/runtime-context.ts";
import { loadParticipant } from "../internal/helpers.ts";

function isPrivateOrDelegated(
  metadata: NonNullable<ReturnType<typeof coreLlmCallMetadata>>,
): boolean {
  return Boolean(metadata.ask) || Boolean(metadata.agentTurn) ||
    metadata.responseVisibility.kind !== "public";
}

export const projectAgentFailureProcessor: Processor<CoreToolProcessorContext> =
  defineProcessor<CoreToolProcessorContext>({
    id: "copilotz.core.project-agent-failure",
    on: ["failed", "cancelled"].map((status) => ({
      eventType: `llm.call.${status}`,
      data: {
        status,
        metadata: { schema: CORE_LLM_CALL_METADATA_SCHEMA },
      },
    })),
    async handle(event, context) {
      const lifecycle = parseActionLifecycleEvent(event, {
        actionId: "llm.call",
        statuses: ["failed", "cancelled"],
        requireRoot: true,
      });
      if (
        !lifecycle ||
        (lifecycle.status !== "failed" && lifecycle.status !== "cancelled")
      ) return;
      const metadata = coreLlmCallMetadata(lifecycle.metadata);
      if (!metadata || isPrivateOrDelegated(metadata)) return;
      const participant = await loadParticipant(
        context,
        metadata.agentParticipantId,
      );
      if (!participant || participant.participantType !== "agent") {
        throw new Error(
          `LLM call '${lifecycle.actionRunId}' has no agent participant.`,
        );
      }
      const createMessage = context.actions.createThreadMessage;
      if (typeof createMessage !== "function") {
        throw new Error("Core requires the createThreadMessage Action.");
      }
      const id = await deriveWorkflowId(
        "message",
        lifecycle.actionRunId,
        "agent-failure",
      );
      const failureMetadata = withWorkflowMetadata(
        withAgentFailureMetadata(undefined, {
          schema: "copilotz.agent-failure",
          llmAttemptId: lifecycle.actionRunId,
          source: "llm.call",
          status: lifecycle.status,
        }),
        {
          kind: "agent_failure",
          continuation: "none",
          llmAttemptId: lifecycle.actionRunId,
          outcome: lifecycle.status,
          sourceMessageId: metadata.triggerMessageId,
          agentParticipantId: metadata.agentParticipantId,
          initiatorParticipantId: metadata.initiatorParticipantId,
        },
      );
      await createMessage({
        id,
        threadId: metadata.threadId,
        sender: participant,
        recipientIds: [],
        content: "I couldn't complete that response. Please try again.",
        visibility: { kind: "public" },
        metadata: failureMetadata,
      }, {
        operationKey: "project:agent-failure",
        signal: context.signal,
      });
    },
  });
