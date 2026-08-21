import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { SafeWorkflowError } from "@copilotz/copilotz/domain";
import type { AgentAskMetadata } from "@copilotz/copilotz/events";
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

function askFailure(
  attempt: CollectionRecord,
  ask: AgentAskMetadata,
  cancelled: boolean,
): SafeWorkflowError {
  const cause = optionalText(asRecord(attempt.safeError).message) ??
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

export const failAskProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.fail-agent-ask",
    on: [
      {
        eventType: "llm_attempt.updated",
        data: { record: { status: "failed" } },
      },
      {
        eventType: "llm_attempt.updated",
        data: { record: { status: "cancelled" } },
      },
    ],
    requires: {
      features: { toolExecution: toolExecutionFeature },
    },
    async handle(event, context) {
      const record = collectionEventRecord(event);
      const attempt = record;
      if (
        String(attempt.status) !== "failed" &&
        String(attempt.status) !== "cancelled"
      ) {
        return;
      }
      const ask = agentAskMetadata(asRecord(attempt.metadata));
      if (!ask || ask.phase === "answer") return;
      if (optionalText(attempt.participantId) !== ask.askedParticipantId) {
        throw new Error(`Ask '${ask.askId}' failure ownership does not match.`);
      }
      const executionRecord = await requireCollection(context, "tool_execution")
        .get({ id: ask.toolExecutionId });
      if (!executionRecord) {
        throw new Error(
          `Ask tool execution '${ask.toolExecutionId}' was not found.`,
        );
      }
      const execution = executionRecord;
      if (
        String(execution.status) !== "running" &&
        String(execution.status) !== "pending"
      ) {
        return;
      }
      const cancelled = String(attempt.status) === "cancelled";
      const failure = askFailure(attempt, ask, cancelled);
      const detail = await context.content.prepare({
        type: "text",
        text: failure.message,
        role: "tool.error_detail",
      }, { operationKey: `ask:${ask.askId}:failure-detail` });
      const projected = await context.content.prepare({
        type: "json",
        value: {
          status: cancelled ? "cancelled" : "failed",
          askId: ask.askId,
          askedAgentId: ask.askedAgentId,
          error: failure.message,
        },
        role: "tool.projected_output",
      }, { operationKey: `ask:${ask.askId}:failure-output` });
      if (cancelled) {
        await context.features.toolExecution.cancel({
          id: execution.id,
          reason: failure.message,
          errorDetail: detail,
          projectedOutput: projected,
          historyVisibility: optionalText(execution.historyVisibility) ??
            "public_status",
        }, { operationKey: `ask:${ask.askId}:cancel` });
        return;
      }
      await context.features.toolExecution.fail({
        id: execution.id,
        safeError: failure,
        errorDetail: detail,
        projectedOutput: projected,
        historyVisibility: optionalText(execution.historyVisibility) ??
          "public_status",
      }, { operationKey: `ask:${ask.askId}:fail` });
    },
  });
