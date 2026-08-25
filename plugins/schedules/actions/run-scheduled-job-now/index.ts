/**
 * Defines the Action that manually claims one Scheduled Job occurrence.
 *
 * @module
 */

import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  ScheduledJobRunNowInput,
  ScheduledJobRunNowResult,
} from "../../internal/contracts.ts";
import { executeRunScheduledJobNow } from "./internal/execute.ts";

export const runScheduledJobNowAction: ActionDefinition<
  ScheduledJobRunNowInput,
  ScheduledJobRunNowResult,
  ActionContext,
  undefined,
  undefined
> = defineAction({
  id: "copilotz.schedules.run-now",
  execute: executeRunScheduledJobNow,
});
