/** Settles a deferred Ask branch when the asked LLM call terminates. @module */

import {
  CORE_LLM_CALL_METADATA_SCHEMA,
  coreLlmCallMetadata,
} from "../../shared/workflow-metadata.ts";
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../shared/runtime-context.ts";
import { settleAskFailure } from "../../shared/ask-failure.ts";

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
      if (!event.durable) return;
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
      await settleAskFailure(
        context,
        ask,
        metadata.agentParticipantId,
        lifecycle.error,
        lifecycle.status === "cancelled",
        event.id,
      );
    },
  });

export default failAskProcessor;
