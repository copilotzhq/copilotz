import type { AgentAskMetadata } from "@copilotz/copilotz/events";
import {
  agentAskMetadata,
  deriveWorkflowId,
  withAgentAskMetadata,
  withWorkflowMetadata,
} from "@copilotz/copilotz/events";
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
        eventType: "copilotz.core.llm.generate.failed",
      },
      {
        eventType: "copilotz.core.llm.generate.cancelled",
      },
      {
        eventType: "copilotz.core.llm.session.failed",
      },
      {
        eventType: "copilotz.core.llm.session.cancelled",
      },
    ],
    async handle(event, context) {
      const lifecycle = asRecord(event.data);
      const attempt = asRecord(lifecycle.input);
      const error = asRecord(lifecycle.error);
      const ask = agentAskMetadata(asRecord(attempt.metadata));
      if (!ask || ask.phase === "answer") return;
      if (optionalText(attempt.participantId) !== ask.askedParticipantId) {
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
        threadId: String(attempt.threadId),
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
