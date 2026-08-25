/**
 * Defines the Action that claims all currently due Scheduled Jobs.
 *
 * @module
 */

import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  ScheduledJobTickInput,
  ScheduledJobTickResult,
} from "../../internal/contracts.ts";
import { executeTickScheduledJobs } from "./internal/execute.ts";

export const tickScheduledJobsAction: ActionDefinition<
  ScheduledJobTickInput,
  ScheduledJobTickResult,
  ActionContext,
  undefined,
  undefined
> = defineAction({
  id: "copilotz.schedules.tick",
  execute: executeTickScheduledJobs,
});
