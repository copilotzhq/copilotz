import type { CollectionRecord, EventCollections } from "../domain/index.ts";
import type {
  ContentInput,
  ContentPreparer,
  ContentSequence,
} from "../content/index.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
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

export type ScheduledJobRunInput =
  & Omit<ScheduledJobRun, "content">
  & Readonly<{ content: ContentInput | readonly ContentInput[] }>;

export type CreateScheduledJobInput = Readonly<{
  namespace: string;
  id?: string;
  name: string;
  status?: Exclude<ScheduledJobStatus, "cancelled">;
  schedule: ScheduledJobSchedule;
  run: ScheduledJobRunInput;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type UpdateScheduledJobInput = Readonly<{
  namespace: string;
  id: string;
  patch: Readonly<{
    name?: string;
    status?: ScheduledJobStatus;
    schedule?: ScheduledJobSchedule;
    run?: Partial<ScheduledJobRunInput>;
    metadata?: Record<string, unknown>;
  }>;
  identity?: MutationIdentity;
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

export type ScheduledJobMutationOptions = Readonly<{
  operationKey?: string;
  metadata?: Record<string, unknown>;
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

export type ScheduledJobRepository = Readonly<{
  create(
    input: CreateScheduledJobInput,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  update(
    input: UpdateScheduledJobInput,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  pause(
    namespace: string,
    id: string,
    identity?: MutationIdentity,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  resume(
    namespace: string,
    id: string,
    identity?: MutationIdentity,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  cancel(
    namespace: string,
    id: string,
    identity?: MutationIdentity,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  get(namespace: string, id: string): Promise<ScheduledJob | null>;
  list(
    namespace: string,
    options?: Readonly<{
      status?: ScheduledJobStatus;
      after?: string;
      limit?: number;
    }>,
  ): Promise<readonly ScheduledJob[]>;
  runNow(
    options: ScheduledJobRunNowOptions,
  ): Promise<ScheduledJobRunNowResult>;
  tick(options: ScheduledJobTickOptions): Promise<ScheduledJobTickResult>;
}>;

/** Scheduled-job mutations bound to one processor delivery namespace. */
export type ScopedScheduledJobs = Readonly<{
  create(
    input: Omit<CreateScheduledJobInput, "namespace" | "identity">,
    options?: ScheduledJobMutationOptions,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  update(
    input: Omit<UpdateScheduledJobInput, "namespace" | "identity">,
    options?: ScheduledJobMutationOptions,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  pause(
    id: string,
    options?: ScheduledJobMutationOptions,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  resume(
    id: string,
    options?: ScheduledJobMutationOptions,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  cancel(
    id: string,
    options?: ScheduledJobMutationOptions,
  ): Promise<CoordinatedMutationResult<ScheduledJob>>;
  get(id: string): Promise<ScheduledJob | null>;
  list(
    options?: Readonly<{
      status?: ScheduledJobStatus;
      after?: string;
      limit?: number;
    }>,
  ): Promise<readonly ScheduledJob[]>;
  runNow(
    id: string,
    options?:
      & Omit<ScheduledJobRunNowOptions, "namespace" | "id" | "identity">
      & ScheduledJobMutationOptions,
  ): Promise<ScheduledJobRunNowResult>;
}>;

export type CreateScheduledJobRepositoryOptions = Readonly<{
  collections: EventCollections;
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<
    EventStore,
    "tables" | "scopeSettlement" | "getEventByDeduplicationId"
  >;
  preparer: ContentPreparer;
  nextRunAt?: (schedule: ScheduledJobSchedule, from: Date) => Date;
  now?: () => Date;
}>;

export type CreateScheduledJobsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  toolId?: string;
}>;
