/**
 * Records terminal Core Tool Action lifecycle facts in the Usage ledger.
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
  optionalText,
  participantExternalId,
  persistUsage,
  record,
  toolUsageRecord,
} from "../internal/accounting.ts";

export function createToolUsageProcessor(
  options: CreateUsageWorkflowPluginOptions,
): Processor<ProcessorContext> {
  return defineProcessor<ProcessorContext>({
    id: "copilotz.usage.record-tool-action",
    on: ["completed", "failed", "cancelled"].map((status) => ({
      eventType: "*" as const,
      data: {
        status,
        metadata: { schema: "copilotz.core.tool-action.v1" },
      },
    })),
    async handle(event, context) {
      const lifecycle = parseActionLifecycleEvent(event, {
        statuses: ["completed", "failed", "cancelled"],
      });
      if (!lifecycle) return;
      const metadata = record(lifecycle.metadata);
      const initiatedById = await participantExternalId(
        context,
        optionalText(metadata.initiatorParticipantId),
      );
      await persistUsage(
        toolUsageRecord(lifecycle, event, initiatedById),
        lifecycle,
        context,
        options,
      );
    },
  });
}
