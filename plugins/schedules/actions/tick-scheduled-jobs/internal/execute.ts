import type { ActionContext } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  getNextScheduledRunAt,
  normalizeScheduledJobRecord,
} from "../../../internal/model.ts";
import type {
  ScheduledJob,
  ScheduledJobTickInput,
  ScheduledJobTickItem,
  ScheduledJobTickResult,
} from "../../../internal/contracts.ts";
import {
  instant,
  occurrence,
  scheduledJobCollection,
} from "../../internal/shared.ts";

const NOT_DUE_MESSAGES = [
  "is no longer due",
  "is not active",
  "is not due yet",
  "was not found",
];

function positiveLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new TypeError("Schedule tick limit must be between 1 and 1000.");
  }
  return value;
}

function isNotDue(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NOT_DUE_MESSAGES.some((item) => message.includes(item));
}

async function dueCandidates(
  checkedAt: Date,
  limit: number,
  context: ActionContext,
): Promise<readonly ScheduledJob[]> {
  const records: CollectionRecord[] = [];
  let after: string | undefined;
  while (true) {
    const page = await scheduledJobCollection(context).list({
      where: { status: "active" },
      ...(after ? { after } : {}),
      limit: 1_000,
    });
    records.push(...page);
    if (page.length < 1_000) break;
    after = page[page.length - 1]?.id;
    if (!after) break;
  }
  return Object.freeze(
    records
      .map((record: CollectionRecord) => normalizeScheduledJobRecord(record))
      .filter((job) =>
        job.nextRunAtMs !== null && job.nextRunAtMs <= checkedAt.getTime()
      )
      .sort((left, right) =>
        (left.nextRunAtMs ?? 0) - (right.nextRunAtMs ?? 0) ||
        left.id.localeCompare(right.id)
      )
      .slice(0, limit),
  );
}

export async function executeTickScheduledJobs(
  input: ScheduledJobTickInput,
  context: ActionContext,
): Promise<ScheduledJobTickResult> {
  const checkedAt = instant(
    input.checkedAt,
    context.now(),
    "Schedule check time",
  );
  const limit = positiveLimit(input.limit);
  const jobs: ScheduledJobTickItem[] = [];
  for (const candidate of await dueCandidates(checkedAt, limit, context)) {
    const scheduledForMs = candidate.nextRunAtMs;
    if (scheduledForMs === null) continue;
    const scheduledFor = new Date(scheduledForMs);
    const item = occurrence(candidate.id, scheduledFor, "scheduled");
    try {
      getNextScheduledRunAt(candidate.schedule, checkedAt);
      await scheduledJobCollection(context).commands.due({
        id: candidate.id,
        occurrenceId: item.id,
        mode: item.mode,
        scheduledFor: item.scheduledFor,
        checkedAt: checkedAt.toISOString(),
      }, {
        operationKey: `scheduled_job.due:${item.id}`,
      });
      jobs.push(Object.freeze({
        jobId: candidate.id,
        name: candidate.name,
        occurrenceId: item.id,
        status: "claimed",
      }));
    } catch (error) {
      jobs.push(Object.freeze(
        isNotDue(error)
          ? {
            jobId: candidate.id,
            name: candidate.name,
            occurrenceId: item.id,
            status: "skipped" as const,
          }
          : {
            jobId: candidate.id,
            name: candidate.name,
            occurrenceId: item.id,
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          },
      ));
    }
  }
  return Object.freeze({
    checkedAt: checkedAt.toISOString(),
    claimed: jobs.filter((item) => item.status === "claimed").length,
    skipped: jobs.filter((item) => item.status === "skipped").length,
    failed: jobs.filter((item) => item.status === "failed").length,
    jobs: Object.freeze(jobs),
  });
}
