import type { ActionCaller } from "@copilotz/copilotz/actions";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import {
  runScheduledJobNowAction,
  tickScheduledJobsAction,
} from "./actions.ts";
import { scheduledJobCollection } from "./collection.ts";
import {
  SCHEDULED_JOB_RUN_NOW_INPUT_EVENT,
  SCHEDULED_JOBS_TICK_INPUT_EVENT,
} from "./input.ts";
import type {
  ScheduledJobRunNowInput,
  ScheduledJobTickInput,
} from "./types.ts";

type SchedulesProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{
    actions: Readonly<{
      runScheduledJobNow: ActionCaller<typeof runScheduledJobNowAction>;
      tickScheduledJobs: ActionCaller<typeof tickScheduledJobsAction>;
    }>;
  }>;

export const scheduledJobRunNowInputProcessor: Processor<
  SchedulesProcessorContext
> = defineProcessor({
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

export const scheduledJobsTickInputProcessor: Processor<
  SchedulesProcessorContext
> = defineProcessor({
  id: "schedules.tick-input",
  on: [{ eventType: SCHEDULED_JOBS_TICK_INPUT_EVENT }],
  async handle(event, context) {
    if (!event.durable) return;
    const input = event.payload && typeof event.payload === "object" &&
        !Array.isArray(event.payload)
      ? event.payload as ScheduledJobTickInput
      : {};
    await context.actions.tickScheduledJobs(input, {
      operationKey: "scheduled-jobs-tick-input",
    });
  },
});

export const SCHEDULES_PLUGIN_ID = "@copilotz/schedules";
export const SCHEDULES_PLUGIN_VERSION = "0.62.0";

type EmptyMap = Readonly<Record<never, never>>;
type SchedulesCollections = Readonly<{
  scheduledJob: typeof scheduledJobCollection;
}>;
type SchedulesActions = Readonly<{
  runScheduledJobNow: typeof runScheduledJobNowAction;
  tickScheduledJobs: typeof tickScheduledJobsAction;
}>;
type SchedulesProcessors = Readonly<{
  runScheduledJobNowInput: typeof scheduledJobRunNowInputProcessor;
  tickScheduledJobsInput: typeof scheduledJobsTickInputProcessor;
}>;

/** Generic time-to-durable-due-event semantics. */
export const schedulesPlugin: CopilotzPlugin<
  typeof SCHEDULES_PLUGIN_ID,
  typeof SCHEDULES_PLUGIN_VERSION,
  readonly [],
  SchedulesCollections,
  SchedulesActions,
  SchedulesProcessors,
  EmptyMap,
  EmptyMap
> = definePlugin({
  id: SCHEDULES_PLUGIN_ID,
  version: SCHEDULES_PLUGIN_VERSION,
  collections: { scheduledJob: scheduledJobCollection },
  actions: {
    runScheduledJobNow: runScheduledJobNowAction,
    tickScheduledJobs: tickScheduledJobsAction,
  },
  processors: {
    runScheduledJobNowInput: scheduledJobRunNowInputProcessor,
    tickScheduledJobsInput: scheduledJobsTickInputProcessor,
  },
});
