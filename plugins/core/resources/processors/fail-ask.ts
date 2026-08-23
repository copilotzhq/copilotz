import {
  type AgentAskMetadata,
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmCallMetadata,
} from "../../internal/workflow-metadata.ts";
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../context.ts";
import { resumeDeferredToolPlan } from "../../internal/tool-plan.ts";
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
    message: cancelled
      ? `Ask to agent '${ask.askedAgentId}' was cancelled: ${cause}`
      : `Asked agent '${ask.askedAgentId}' failed: ${cause}`,
  });
}

export const failAskProcessor: Processor<CoreToolProcessorContext> =
  defineProcessor<CoreToolProcessorContext>({
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
      if (!metadata) return;
      const ask = metadata.ask;
      if (!ask || ask.phase === "answer") return;
      if (metadata.agentParticipantId !== ask.askedParticipantId) {
        throw new Error(`Ask '${ask.askId}' failure ownership does not match.`);
      }
      const cancelled = lifecycle.status === "cancelled";
      await resumeDeferredToolPlan(context, ask, {
        status: cancelled ? "cancelled" : "failed",
        error: askFailure(asRecord(lifecycle.error), ask, cancelled),
      });
    },
  });
