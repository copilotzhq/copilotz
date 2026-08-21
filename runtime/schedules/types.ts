import type { ContentSequence } from "../content/index.ts";
import type { CollectionRecord } from "../collections/index.ts";
import type { CollectionRuntime } from "../collections/index.ts";
import type { EventStore, SqlExecutor } from "../events/index.ts";
import type { MutationIdentity, ParticipantInput } from "../domain/index.ts";

export type ScheduledJobStatus = "active" | "paused" | "cancelled";

export type ScheduledJobSchedule = Readonly<{
  type: "cron";
  expression: string;
  timezone?: string;
}>;

export type ScheduledJobThread = Readonly<{
  id?: string;
  externalId?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}>;

export type ScheduledJobSender =
  & Omit<ParticipantInput, "participantType">
  & Readonly<{ participantType?: "job" }>;

export type ScheduledJobRun = Readonly<{
  thread?: ScheduledJobThread;
  sender?: ScheduledJobSender;
  /** Participant IDs/external IDs or agent resource IDs. */
  recipientIds?: readonly string[];
  content: ContentSequence;
  metadata?: Record<string, unknown>;
}>;

export type ScheduledJob =
  & CollectionRecord
  & Readonly<{
    name: string;
    status: ScheduledJobStatus;
    schedule: ScheduledJobSchedule;
    run: ScheduledJobRun;
    nextRunAt: string | null;
    nextRunAtMs: number | null;
    lastRunAt?: string | null;
    lastRunAtMs?: number | null;
    metadata?: Readonly<Record<string, unknown>>;
  }>;

export type ScheduledJobOccurrence = Readonly<{
  jobId: string;
  jobName: string;
  occurrenceId: string;
  scheduledFor: string;
  run: ScheduledJobRun;
}>;

export type ScheduledJobTickOptions = Readonly<{
  namespace: string;
  now?: Date;
  limit?: number;
  waitForCompletion?: boolean;
  settlementPollMs?: number;
  settlementTimeoutMs?: number;
}>;

export type ScheduledJobTickItem = Readonly<{
  jobId: string;
  name: string;
  occurrenceId?: string;
  eventId?: string;
  status: "dispatched" | "skipped" | "failed";
  dispatchFailures?: number;
  error?: string;
}>;

export type ScheduledJobTickResult = Readonly<{
  namespace: string;
  checkedAt: string;
  claimed: number;
  dispatched: number;
  skipped: number;
  failed: number;
  jobs: readonly ScheduledJobTickItem[];
}>;

export type ScheduledJobRunNowOptions = Readonly<{
  namespace: string;
  id: string;
  now?: Date;
  waitForCompletion?: boolean;
  settlementPollMs?: number;
  settlementTimeoutMs?: number;
  identity?: MutationIdentity;
}>;

export type ScheduledJobRunNowResult = Readonly<{
  jobId: string;
  name: string;
  occurrenceId: string;
  eventId: string;
  settlementScopeId: string;
  deduplicated: boolean;
  dispatchFailures: number;
}>;

export type ScheduledJobTrigger = Readonly<{
  runNow(
    options: ScheduledJobRunNowOptions,
  ): Promise<ScheduledJobRunNowResult>;
  tick(options: ScheduledJobTickOptions): Promise<ScheduledJobTickResult>;
}>;

/** Scheduled-job trigger bound to one processor delivery namespace. */
export type ScopedScheduledJobTrigger = Readonly<{
  runNow(
    id: string,
    options?:
      & Omit<ScheduledJobRunNowOptions, "namespace" | "id" | "identity">
      & Readonly<{ operationKey?: string; metadata?: Record<string, unknown> }>,
  ): Promise<ScheduledJobRunNowResult>;
}>;

export type CreateScheduledJobTriggerOptions = Readonly<{
  collectionRuntime: CollectionRuntime;
  session: SqlExecutor;
  eventStore: Pick<
    EventStore,
    | "tables"
    | "scopeSettlement"
    | "getEventByDeduplicationId"
    | "listDeliveries"
  >;
  nextRunAt?: (schedule: ScheduledJobSchedule, from: Date) => Date;
  now?: () => Date;
}>;

export type CreateScheduledJobsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  toolId?: string;
}>;
