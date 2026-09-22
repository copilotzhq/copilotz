/**
 * Routes durable scheduler ticks to the tick Scheduled Jobs Action.
 *
 * @module
 */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { SCHEDULED_JOBS_TICK_INPUT_EVENT } from "../../authoring/inputs/index.ts";
import type { ScheduledJobTickInput } from "../../shared/contracts.ts";
import type { SchedulesProcessorContext } from "../../shared/context.ts";

export const scheduledJobsTickInputProcessor: Processor<
  SchedulesProcessorContext
> = defineProcessor<SchedulesProcessorContext>({
  id: "schedules.tick-input",
  on: [{ eventType: SCHEDULED_JOBS_TICK_INPUT_EVENT }],
  async handle(event, context) {
    if (!event.durable) return;
    const input = event.data && typeof event.data === "object" &&
        !Array.isArray(event.data)
      ? event.data as ScheduledJobTickInput
      : {};
    await context.actions.tickScheduledJobs(input, {
      operationKey: "scheduled-jobs-tick-input",
    });
  },
});

export default scheduledJobsTickInputProcessor;
