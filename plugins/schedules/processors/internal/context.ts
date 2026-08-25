import type { ActionCaller } from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  runScheduledJobNowAction,
  tickScheduledJobsAction,
} from "../../actions/index.ts";

export type SchedulesProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{
    actions: Readonly<{
      runScheduledJobNow: ActionCaller<typeof runScheduledJobNowAction>;
      tickScheduledJobs: ActionCaller<typeof tickScheduledJobsAction>;
    }>;
  }>;
