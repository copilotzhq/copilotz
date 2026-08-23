import type {
  CollectionRecord,
  ScopedCollection,
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import type { DurableContentInput } from "@copilotz/copilotz/content";
import { scheduledJobCollection } from "./collection.ts";
import {
  getNextScheduledRunAt,
  normalizeScheduledJobRecord,
  normalizeScheduledJobSchedule,
  normalizeScheduledJobStatus,
  requireScheduledText,
  scheduledRecord,
} from "./model.ts";
import type {
  ScheduledJob,
  ScheduledJobPayload,
  ScheduledJobSchedule,
  ScheduledJobStatus,
} from "./types.ts";

export type CreateScheduledJobInput<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
> = Readonly<{
  id?: string;
  name: string;
  status?: Exclude<ScheduledJobStatus, "cancelled">;
  schedule: ScheduledJobSchedule;
  payload: TPayload;
  content?: DurableContentInput;
  metadata?: Record<string, unknown>;
}>;

export type UpdateScheduledJobInput<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
> = Readonly<{
  id: string;
  patch: Readonly<{
    name?: string;
    status?: ScheduledJobStatus;
    schedule?: ScheduledJobSchedule;
    /** The owning semantic plugin supplies the complete opaque payload. */
    payload?: TPayload;
    content?: DurableContentInput;
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

/** Creates one job through its Collection-owned mutation contract. */
export async function createScheduledJob<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
>(
  input: CreateScheduledJobInput<TPayload>,
  context: ScheduledJobMutationContext,
): Promise<ScheduledJob<TPayload>> {
  const name = requireScheduledText(input.name, "Scheduled job name");
  const schedule = normalizeScheduledJobSchedule(input.schedule);
  const timestamp = context.now();
  const next = getNextScheduledRunAt(schedule, timestamp);
  const payload = scheduledRecord(input.payload, "Scheduled job payload");
  const record = await collection(context).create({
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    name,
    status: input.status ?? "active",
    schedule,
    payload: structuredClone(payload),
    ...(input.content === undefined
      ? {}
      : { content: structuredClone(input.content) }),
    nextRunAt: next.toISOString(),
    nextRunAtMs: next.getTime(),
    lastOccurrence: null,
    metadata: structuredClone(input.metadata ?? {}),
  }, { operationKey: `scheduled_job.create:${input.id ?? name}` });
  return normalizeScheduledJobRecord<TPayload>(record);
}

/** Applies scheduling invariants around an ordinary Collection update. */
export async function updateScheduledJob<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
>(
  input: UpdateScheduledJobInput<TPayload>,
  context: ScheduledJobMutationContext,
): Promise<ScheduledJob<TPayload>> {
  const id = requireScheduledText(input.id, "Scheduled job ID");
  const jobs = collection(context);
  const currentValue = await jobs.get({ id });
  if (!currentValue) throw new Error(`Scheduled job '${id}' was not found.`);
  const current = normalizeScheduledJobRecord<TPayload>(currentValue);
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
  if (input.patch.payload !== undefined) {
    patch.payload = structuredClone(
      scheduledRecord(input.patch.payload, "Scheduled job payload"),
    );
  }
  if (input.patch.content !== undefined) {
    patch.content = structuredClone(input.patch.content);
  }
  if (input.patch.metadata !== undefined) {
    patch.metadata = structuredClone(input.patch.metadata);
  }
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
    { id, set: patch as Partial<ScheduledJob<TPayload>> },
    { operationKey: `scheduled_job.update:${id}` },
  );
  return normalizeScheduledJobRecord<TPayload>(record);
}

export async function getScheduledJob<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
>(
  input: { id: string },
  context: ScheduledJobMutationContext,
): Promise<ScheduledJob<TPayload> | null> {
  const value = await collection(context).get({
    id: requireScheduledText(input.id, "Scheduled job ID"),
  });
  return value ? normalizeScheduledJobRecord<TPayload>(value) : null;
}

export async function listScheduledJobs<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
>(
  input: ListScheduledJobsInput = {},
  context: ScheduledJobMutationContext,
): Promise<readonly ScheduledJob<TPayload>[]> {
  const values = await collection(context).list({
    after: input.after,
    limit: input.limit,
    ...(input.status ? { where: { status: input.status } } : {}),
  });
  return Object.freeze(
    values.map((value) => normalizeScheduledJobRecord<TPayload>(value)),
  );
}
