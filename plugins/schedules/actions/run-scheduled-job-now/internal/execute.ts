import type { ActionContext } from "@copilotz/copilotz/actions";
import { normalizeScheduledJobRecord } from "../../../internal/model.ts";
import type {
  ScheduledJobRunNowInput,
  ScheduledJobRunNowResult,
} from "../../../internal/contracts.ts";
import {
  instant,
  occurrence,
  requiredText,
  scheduledJobCollection,
} from "../../internal/shared.ts";

export async function executeRunScheduledJobNow(
  input: ScheduledJobRunNowInput,
  context: ActionContext,
): Promise<ScheduledJobRunNowResult> {
  const id = requiredText(input.id, "Scheduled job ID");
  const scheduledFor = instant(
    input.scheduledFor,
    context.now(),
    "Scheduled time",
  );
  const item = occurrence(id, scheduledFor, "manual");
  const record = await scheduledJobCollection(context).commands.due({
    id,
    occurrenceId: item.id,
    mode: item.mode,
    scheduledFor: item.scheduledFor,
  }, {
    operationKey: `scheduled_job.run_now:${item.id}`,
  });
  return Object.freeze({
    job: normalizeScheduledJobRecord(record),
    occurrence: item,
  });
}
