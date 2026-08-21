import { agentAskMetadata } from "@copilotz/copilotz/events";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { toolExecutionFeature } from "../features/tool-execution.ts";
import {
  asRecord,
  collectionEventRecord,
  optionalText,
  requireCollection,
} from "./helpers.ts";

export const completeAskProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.complete-agent-ask",
    on: [{
      eventType: "message.created",
      metadata: { copilotzAsk: { phase: "answer" } },
    }],
    requires: {
      features: { toolExecution: toolExecutionFeature },
    },
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
      const executionRecord = await requireCollection(context, "tool_execution")
        .get({ id: ask.toolExecutionId });
      if (!executionRecord) {
        throw new Error(
          `Ask tool execution '${ask.toolExecutionId}' was not found.`,
        );
      }
      const execution = executionRecord;
      if (
        String(record.threadId) !== String(execution.threadId) ||
        ask.toolExecutionId !== execution.id ||
        sender.id !== ask.askedParticipantId ||
        optionalText(execution.participantId) !== ask.askingParticipantId
      ) {
        throw new Error(`Ask '${ask.askId}' answer ownership does not match.`);
      }
      if (
        String(execution.status) !== "running" &&
        String(execution.status) !== "pending"
      ) {
        return;
      }
      const output = await context.content.prepare({
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
      }, { operationKey: `ask:${ask.askId}:answer-output` });
      await context.features.toolExecution.complete({
        id: execution.id,
        output,
        projectedOutput: output,
        historyVisibility: optionalText(execution.historyVisibility) ??
          "public_status",
      }, { operationKey: `ask:${ask.askId}:complete` });
    },
  });
