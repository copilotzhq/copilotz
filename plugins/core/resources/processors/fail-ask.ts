import { deriveWorkflowId } from "@copilotz/copilotz/events";
import {
  type AgentAskMetadata,
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmCallMetadata,
  withAgentAskMetadata,
  withWorkflowMetadata,
} from "../../internal/workflow-metadata.ts";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreProcessorContext } from "../../context.ts";
import { asRecord, optionalText } from "./helpers.ts";

function askFailure(
  error: Record<string, unknown>,
  ask: AgentAskMetadata,
  cancelled: boolean,
) {
  const cause = optionalText(error.message) ??
    (cancelled ? "The asked agent was cancelled." : "The asked agent failed.");
  return Object.freeze({
    name: cancelled ? "AgentAskCancelled" : "AgentAskFailed",
    code: cancelled ? "ask_cancelled" : "ask_failed",
    message: cancelled
      ? `Ask to agent '${ask.askedAgentId}' was cancelled: ${cause}`
      : `Asked agent '${ask.askedAgentId}' failed: ${cause}`,
    retryable: false,
  });
}

export const failAskProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.fail-agent-ask",
    on: [
      {
        eventType: "llm.call.failed",
        data: { metadata: { schema: CORE_LLM_CALL_METADATA_SCHEMA } },
      },
      {
        eventType: "llm.call.cancelled",
        data: { metadata: { schema: CORE_LLM_CALL_METADATA_SCHEMA } },
      },
    ],
    async handle(event, context) {
      const lifecycle = asRecord(event.data);
      const metadata = coreLlmCallMetadata(lifecycle.metadata);
      if (!metadata) return;
      const error = asRecord(lifecycle.error);
      const ask = metadata.ask;
      if (!ask || ask.phase === "answer") return;
      if (metadata.agentParticipantId !== ask.askedParticipantId) {
        throw new Error(`Ask '${ask.askId}' failure ownership does not match.`);
      }
      const cancelled = lifecycle.status === "cancelled";
      const failure = askFailure(error, ask, cancelled);
      const projected = {
        type: "json",
        value: {
          status: cancelled ? "cancelled" : "failed",
          askId: ask.askId,
          askedAgentId: ask.askedAgentId,
          error: failure.message,
        },
        role: "tool.projected_output",
      } as const;
      await context.actions.createThreadMessage({
        id: await deriveWorkflowId("message", ask.toolExecutionId, "result"),
        threadId: metadata.threadId,
        sender: {
          externalId: "tool:ask",
          participantType: "tool",
          name: "Ask Agent",
        },
        recipientIds: [ask.askingParticipantId],
        content: projected,
        visibility: {
          kind: "tool",
          policy: "public_status",
          requesterId: ask.askingParticipantId,
        },
        metadata: withWorkflowMetadata(
          ask.parentAsk
            ? withAgentAskMetadata({
              historyVisibility: "public_status",
              requesterId: ask.askingParticipantId,
              toolStatus: cancelled ? "cancelled" : "failed",
              toolId: "ask",
              toolInvocation: ask.toolInvocation,
            }, ask.parentAsk)
            : {
              historyVisibility: "public_status",
              requesterId: ask.askingParticipantId,
              toolStatus: cancelled ? "cancelled" : "failed",
              toolId: "ask",
              ...(ask.toolInvocation
                ? { toolInvocation: ask.toolInvocation }
                : {}),
            },
          {
            kind: "tool_result",
            llmAttemptId: ask.callingAttemptId,
            parentLlmAttemptId: ask.callingAttemptId,
            toolExecutionId: ask.toolExecutionId,
            toolCallId: ask.toolCallId,
            batchId: ask.toolExecutionId,
            batchSize: 1,
            batchIndex: 0,
            sourceMessageId: ask.questionMessageId,
            agentParticipantId: ask.askingParticipantId,
          },
        ),
      }, {
        operationKey: `ask:${ask.askId}:${cancelled ? "cancel" : "fail"}`,
      });
    },
  });
