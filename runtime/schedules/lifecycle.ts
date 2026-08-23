import type { DurableContentInput } from "../content/index.ts";
import type {
  CollectionRecord,
  ScopedCollection,
  ScopedCollections,
} from "../collections/index.ts";
import { scheduledJobCollection } from "./collection.ts";
import {
  getNextScheduledRunAt,
  normalizeScheduledJobRecord,
  normalizeScheduledJobSchedule,
  normalizeScheduledJobStatus,
  requireScheduledText,
} from "./model.ts";
import type {
  ScheduledJob,
  ScheduledJobRun,
  ScheduledJobSchedule,
  ScheduledJobStatus,
} from "./types.ts";

export type ScheduledJobRunInput =
  & Omit<ScheduledJobRun, "content">
  & Readonly<{ content: DurableContentInput }>;

export type CreateScheduledJobInput = Readonly<{
  id?: string;
  name: string;
  status?: Exclude<ScheduledJobStatus, "cancelled">;
  schedule: ScheduledJobSchedule;
  run: ScheduledJobRunInput;
  metadata?: Record<string, unknown>;
}>;

export type UpdateScheduledJobInput = Readonly<{
  id: string;
  patch: Readonly<{
    name?: string;
    status?: ScheduledJobStatus;
    schedule?: ScheduledJobSchedule;
    run?: Partial<ScheduledJobRunInput>;
    metadata?: Record<string, unknown>;
  }>;
}>;

export type ListScheduledJobsInput = Readonly<{
  status?: ScheduledJobStatus;
  after?: string;
  limit?: number;
}>;

export type ScheduledJobMutationContext = Readonly<{
  collections: ScopedCollections;
  now(): Date;
}>;

function collection(
  context: ScheduledJobMutationContext,
): ScopedCollection<CollectionRecord, Record<string, unknown>> {
  const scoped = context.collections.scheduledJob ??
    context.collections[scheduledJobCollection.name];
  if (!scoped) throw new Error("Scheduled job collection is not bound.");
  return scoped as ScopedCollection<CollectionRecord, Record<string, unknown>>;
}

function runPatch(
  current: ScheduledJob,
  input: Partial<ScheduledJobRunInput>,
): ScheduledJobRun {
  return Object.freeze({
    ...structuredClone(current.run),
    ...structuredClone(input),
    content: input.content ?? current.run.content,
  }) as ScheduledJobRun;
}

/** Creates one Scheduled Job through its Collection-owned mutation contract. */
export async function createScheduledJob(
  input: CreateScheduledJobInput,
  context: ScheduledJobMutationContext,
): Promise<ScheduledJob> {
  const name = requireScheduledText(input.name, "Scheduled job name");
  const schedule = normalizeScheduledJobSchedule(input.schedule);
  const timestamp = context.now();
  const next = getNextScheduledRunAt(schedule, timestamp);
  const record = await collection(context).create({
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    name,
    status: input.status ?? "active",
    schedule,
    run: structuredClone(input.run),
    nextRunAt: next.toISOString(),
    nextRunAtMs: next.getTime(),
    lastRunAt: null,
    lastRunAtMs: null,
    metadata: structuredClone(input.metadata ?? {}),
  }, { operationKey: `scheduled_job.create:${input.id ?? name}` });
  return normalizeScheduledJobRecord(record);
}

/** Applies the scheduling invariants around one ordinary Collection update. */
export async function updateScheduledJob(
  input: UpdateScheduledJobInput,
  context: ScheduledJobMutationContext,
): Promise<ScheduledJob> {
  const id = requireScheduledText(input.id, "Scheduled job ID");
  const jobs = collection(context);
  const currentValue = await jobs.get({ id });
  if (!currentValue) throw new Error(`Scheduled job '${id}' was not found.`);
  const current = normalizeScheduledJobRecord(currentValue);
  const patch: Record<string, unknown> = {};
  if (input.patch.name !== undefined) {
    patch.name = requireScheduledText(input.patch.name, "Scheduled job name");
  }
  const schedule = input.patch.schedule
    ? normalizeScheduledJobSchedule(input.patch.schedule)
    : current.schedule;
  if (input.patch.schedule) patch.schedule = schedule;
  const nextStatus = input.patch.status ?? current.status;
  if (input.patch.status !== undefined) {
    patch.status = normalizeScheduledJobStatus(input.patch.status);
  }
  if (input.patch.metadata !== undefined) {
    patch.metadata = structuredClone(input.patch.metadata);
  }
  if (input.patch.run) patch.run = runPatch(current, input.patch.run);
  if (nextStatus === "cancelled") {
    patch.nextRunAt = null;
    patch.nextRunAtMs = null;
  } else if (
    input.patch.schedule ||
    (nextStatus === "active" && current.status !== "active") ||
    (nextStatus === "active" &&
      (current.nextRunAtMs === null ||
        current.nextRunAtMs <= context.now().getTime()))
  ) {
    const next = getNextScheduledRunAt(schedule, context.now());
    patch.nextRunAt = next.toISOString();
    patch.nextRunAtMs = next.getTime();
  }
  if (Object.keys(patch).length === 0) return current;
  const record = await jobs.update(
    { id, set: patch as Partial<ScheduledJob> },
    { operationKey: `scheduled_job.update:${id}` },
  );
  return normalizeScheduledJobRecord(record);
}

export async function getScheduledJob(
  input: { id: string },
  context: ScheduledJobMutationContext,
): Promise<ScheduledJob | null> {
  const value = await collection(context).get({
    id: requireScheduledText(input.id, "Scheduled job ID"),
  });
  return value ? normalizeScheduledJobRecord(value) : null;
}

export async function listScheduledJobs(
  input: ListScheduledJobsInput = {},
  context: ScheduledJobMutationContext,
): Promise<readonly ScheduledJob[]> {
  const values = await collection(context).list({
    after: input.after,
    limit: input.limit,
    ...(input.status ? { where: { status: input.status } } : {}),
  });
  return Object.freeze(values.map(normalizeScheduledJobRecord));
}
