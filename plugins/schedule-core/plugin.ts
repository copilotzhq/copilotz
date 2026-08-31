/**
 * Composes the concrete Schedule Core primitives.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { corePlugin } from "../core/plugin.ts";
import { schedulesPlugin } from "../schedules/index.ts";
import {
  dispatchScheduledMessageAction,
  scheduledJobsAction,
} from "./actions/index.ts";
import { dispatchScheduledMessageProcessor } from "./processors/index.ts";
import { scheduledJobsToolResource } from "./resources/index.ts";

export const CORE_SCHEDULES_PLUGIN_ID = "@copilotz/core-schedules";
export const CORE_SCHEDULES_PLUGIN_VERSION = "0.64.1";

type EmptyMap = Readonly<Record<never, never>>;
type CoreSchedulesActions = Readonly<{
  dispatchScheduledMessage: typeof dispatchScheduledMessageAction;
  scheduled_jobs: typeof scheduledJobsAction;
}>;
type CoreSchedulesProcessors = Readonly<{
  dispatchScheduledMessage: typeof dispatchScheduledMessageProcessor;
}>;
type CoreSchedulesResources = Readonly<{
  tools: Readonly<{ scheduled_jobs: typeof scheduledJobsToolResource }>;
}>;

/** Core conversation integration over generic due Events. */
export const coreSchedulesPlugin: CopilotzPlugin<
  typeof CORE_SCHEDULES_PLUGIN_ID,
  typeof CORE_SCHEDULES_PLUGIN_VERSION,
  readonly [typeof schedulesPlugin, typeof corePlugin],
  EmptyMap,
  CoreSchedulesActions,
  CoreSchedulesProcessors,
  CoreSchedulesResources,
  EmptyMap
> = definePlugin({
  id: CORE_SCHEDULES_PLUGIN_ID,
  version: CORE_SCHEDULES_PLUGIN_VERSION,
  plugins: [schedulesPlugin, corePlugin] as const,
  actions: {
    dispatchScheduledMessage: dispatchScheduledMessageAction,
    scheduled_jobs: scheduledJobsAction,
  },
  processors: {
    dispatchScheduledMessage: dispatchScheduledMessageProcessor,
  },
  resources: {
    tools: { scheduled_jobs: scheduledJobsToolResource },
  },
});
