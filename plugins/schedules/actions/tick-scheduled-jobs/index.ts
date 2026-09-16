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
} from "../../shared/contracts.ts";
import { executeTickScheduledJobs } from "./execute.ts";

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

export default tickScheduledJobsAction;
