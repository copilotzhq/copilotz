import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContentSequence } from "@copilotz/copilotz/content";

export type ScheduledJobStatus = "active" | "paused" | "cancelled";

export type ScheduledJobSchedule = Readonly<{
  type: "cron";
  expression: string;
  timezone?: string;
}>;

/**
 * Semantic data interpreted only by a plugin reacting to `scheduled_job.due`.
 * The schedules plugin persists and reproduces it without inspecting it.
 */
export type ScheduledJobPayload = Readonly<Record<string, unknown>>;

export type ScheduledJobOccurrenceRef = Readonly<{
  id: string;
  mode: "scheduled" | "manual";
  scheduledFor: string;
}>;

export type ScheduledJob<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
> =
  & CollectionRecord
  & Readonly<{
    name: string;
    status: ScheduledJobStatus;
    schedule: ScheduledJobSchedule;
    payload: TPayload;
    /** Optional runtime-generic durable content owned by this job. */
    content?: ContentSequence;
    nextRunAt: string | null;
    nextRunAtMs: number | null;
    lastOccurrence: ScheduledJobOccurrenceRef | null;
    metadata: Readonly<Record<string, unknown>>;
  }>;

export type ScheduledJobOccurrence<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
> = Readonly<{
  jobId: string;
  jobName: string;
  occurrenceId: string;
  mode: "scheduled" | "manual";
  scheduledFor: string;
  payload: TPayload;
  content?: ContentSequence;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ScheduledJobTickInput = Readonly<{
  checkedAt?: string;
  limit?: number;
}>;

export type ScheduledJobTickItem = Readonly<{
  jobId: string;
  name: string;
  occurrenceId: string;
  status: "claimed" | "skipped" | "failed";
  error?: string;
}>;

export type ScheduledJobTickResult = Readonly<{
  checkedAt: string;
  claimed: number;
  skipped: number;
  failed: number;
  jobs: readonly ScheduledJobTickItem[];
}>;

export type ScheduledJobRunNowInput = Readonly<{
  id: string;
  scheduledFor?: string;
}>;

export type ScheduledJobRunNowResult = Readonly<{
  job: ScheduledJob;
  occurrence: ScheduledJobOccurrenceRef;
}>;
