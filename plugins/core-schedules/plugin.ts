import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { corePlugin } from "../core/plugin.ts";
import { schedulesPlugin } from "../schedules/plugin.ts";
import { dispatchScheduledMessageAction } from "./action.ts";
import { dispatchScheduledMessageProcessor } from "./processor.ts";
import { scheduledMessagesTool } from "./tool.ts";

export const CORE_SCHEDULES_PLUGIN_ID = "@copilotz/core-schedules";
export const CORE_SCHEDULES_PLUGIN_VERSION = "0.61.0";

type EmptyMap = Readonly<Record<never, never>>;
type CoreSchedulesActions = Readonly<{
  dispatchScheduledMessage: typeof dispatchScheduledMessageAction;
}>;
type CoreSchedulesProcessors = Readonly<{
  dispatchScheduledMessage: typeof dispatchScheduledMessageProcessor;
}>;
type CoreSchedulesResources = Readonly<{
  tools: Readonly<{ scheduled_jobs: typeof scheduledMessagesTool }>;
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
  },
  processors: {
    dispatchScheduledMessage: dispatchScheduledMessageProcessor,
  },
  resources: {
    tools: { scheduled_jobs: scheduledMessagesTool },
  },
});
