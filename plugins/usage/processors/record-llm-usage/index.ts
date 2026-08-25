/**
 * Records one durable Usage row for each finalized LLM provider request.
 *
 * @module
 */

import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type { CreateUsageWorkflowPluginOptions } from "../../internal/contracts.ts";
import {
  LLM_ATTEMPT_ACCOUNTING_SCHEMA,
  llmAttemptUsageRecords,
  llmAttribution,
  participantExternalId,
  persistUsage,
  record,
} from "../internal/accounting.ts";

export function createLlmUsageProcessor(
  options: CreateUsageWorkflowPluginOptions,
): Processor<ProcessorContext> {
  return defineProcessor<ProcessorContext>({
    id: "copilotz.usage.record-llm-call",
    on: [
      { eventType: "llm.call.completed" },
      { eventType: "llm.call.failed" },
      { eventType: "llm.call.cancelled" },
      { eventType: "llm.call.progress" },
    ],
    async handle(event, context) {
      const lifecycle = parseActionLifecycleEvent(event, {
        actionId: "llm.call",
        statuses: ["completed", "failed", "cancelled", "progress"],
      });
      if (!lifecycle) return;
      const attribution = llmAttribution(lifecycle.metadata);
      const initiatedById = await participantExternalId(
        context,
        attribution.initiatorParticipantId,
      );
      if (lifecycle.status === "progress") {
        const progress = record(lifecycle.progress);
        if (progress.schema !== LLM_ATTEMPT_ACCOUNTING_SCHEMA) return;
        for (
          const usage of llmAttemptUsageRecords(
            lifecycle,
            event,
            attribution,
            initiatedById,
            progress.attempts,
          )
        ) {
          await persistUsage(usage, lifecycle, context, options);
        }
        return;
      }
      if (lifecycle.status !== "completed") return;
      const output = record(lifecycle.output);
      for (
        const usage of llmAttemptUsageRecords(
          lifecycle,
          event,
          attribution,
          initiatedById,
          output.attempts,
        )
      ) {
        await persistUsage(usage, lifecycle, context, options);
      }
    },
  });
}
