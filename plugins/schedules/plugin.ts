/**
 * Composes the concrete Schedules primitives.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  runScheduledJobNowAction,
  tickScheduledJobsAction,
} from "./actions/index.ts";
import { scheduledJobCollection } from "./collections/index.ts";
import {
  scheduledJobRunNowInputProcessor,
  scheduledJobsTickInputProcessor,
} from "./processors/index.ts";

export const SCHEDULES_PLUGIN_ID = "@copilotz/schedules";
export const SCHEDULES_PLUGIN_VERSION = "0.65.1";

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
