/**
 * Routes durable manual-run input envelopes to the run-now Action.
 *
 * @module
 */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { SCHEDULED_JOB_RUN_NOW_INPUT_EVENT } from "../../authoring/inputs/index.ts";
import type { ScheduledJobRunNowInput } from "../../internal/contracts.ts";
import type { SchedulesProcessorContext } from "../internal/context.ts";

export const scheduledJobRunNowInputProcessor: Processor<
  SchedulesProcessorContext
> = defineProcessor<SchedulesProcessorContext>({
  id: "schedules.run-now-input",
  on: [{ eventType: SCHEDULED_JOB_RUN_NOW_INPUT_EVENT }],
  async handle(event, context) {
    if (
      !event.durable || !event.payload ||
      typeof event.payload !== "object" || Array.isArray(event.payload)
    ) {
      throw new TypeError("Scheduled run-now input must be an object.");
    }
    await context.actions.runScheduledJobNow(
      event.payload as ScheduledJobRunNowInput,
      { operationKey: "scheduled-job-run-now-input" },
    );
  },
});
