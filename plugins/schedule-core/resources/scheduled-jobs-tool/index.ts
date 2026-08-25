/**
 * Defines the data-only Tool Resource for scheduled job management.
 *
 * @module
 */

import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import { scheduledJobsAction } from "../../actions/scheduled-jobs/index.ts";

export const scheduledJobsToolResource: ToolResource<"scheduled_jobs"> =
  defineTool("scheduled_jobs", scheduledJobsAction, {
    name: "Scheduled Jobs",
    description:
      "Create and manage recurring jobs that send public messages to Copilotz agents. Supports create, get, list, update, pause, resume, cancel, and run_now.",
  });
