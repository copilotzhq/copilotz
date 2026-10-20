import type { ActionCaller } from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { runScheduledJobNowAction } from "../actions/index.ts";

export type SchedulesProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{
    actions: Readonly<{
      runScheduledJobNow: ActionCaller<typeof runScheduledJobNowAction>;
    }>;
  }>;
