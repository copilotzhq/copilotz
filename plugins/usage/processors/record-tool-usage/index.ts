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
import type { UsageOptions } from "../../shared/contracts.ts";
import {
  optionalText,
  participantExternalId,
  persistUsage,
  record,
  toolUsageRecord,
} from "../../shared/accounting.ts";

export const toolUsageProcessor: Processor<ProcessorContext> = defineProcessor<
  ProcessorContext
>({
  id: "copilotz.usage.record-tool-action",
  on: ["completed", "failed", "cancelled"].map((status) => ({
    eventType: "*" as const,
    data: {
      status,
      metadata: { schema: "copilotz.core.tool-action.v1" },
    },
  })),
  async handle(event, context) {
    const config = context.resources.usage?.config as
      | Pick<UsageOptions, "enabled">
      | undefined;
    if (config?.enabled === false) return;
    const options = (context.adapters.usage?.hooks ?? {}) as Omit<
      UsageOptions,
      "enabled"
    >;
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

export default toolUsageProcessor;
