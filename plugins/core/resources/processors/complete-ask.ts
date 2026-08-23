import {
  agentAskMetadata,
  deriveWorkflowId,
  withAgentAskMetadata,
  withWorkflowMetadata,
} from "@copilotz/copilotz/events";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreProcessorContext } from "../../context.ts";
import {
  asRecord,
  collectionEventRecord,
  requireCollection,
} from "./helpers.ts";

export const completeAskProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.complete-agent-ask",
    on: [{
      eventType: "message.created",
      metadata: { copilotzAsk: { phase: "answer" } },
    }],
    async handle(event, context) {
      const record = collectionEventRecord(event);
      const sender = await requireCollection(context, "participant").get(
        { id: String(record.senderId) },
      );
      if (!sender) {
        throw new Error(`Ask answer '${record.id}' sender was not found.`);
      }
      const ask = agentAskMetadata(asRecord(record.metadata));
      if (!ask || ask.phase !== "answer") return;
      if (
        sender.id !== ask.askedParticipantId
      ) {
        return;
      }
      const output = {
        type: "json",
        value: {
          status: "answered",
          askId: ask.askId,
          questionMessageId: ask.questionMessageId,
          answerMessageId: record.id,
          askedAgentId: ask.askedAgentId,
          askedParticipantId: ask.askedParticipantId,
        },
        role: "tool.output",
      } as const;
      await context.actions.createThreadMessage({
        id: await deriveWorkflowId("message", ask.toolExecutionId, "result"),
        threadId: String(record.threadId),
        sender: {
          externalId: "tool:ask",
          participantType: "tool",
          name: "Ask Agent",
        },
        recipientIds: [ask.askingParticipantId],
        content: output,
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
              toolStatus: "completed",
              toolId: "ask",
              toolInvocation: ask.toolInvocation,
            }, ask.parentAsk)
            : {
              historyVisibility: "public_status",
              requesterId: ask.askingParticipantId,
              toolStatus: "completed",
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
      }, { operationKey: `ask:${ask.askId}:complete` });
    },
  });
