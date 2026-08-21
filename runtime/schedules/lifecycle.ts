import type { DurableContentInput } from "../content/index.ts";
import type {
  CollectionRecord,
  ScopedCollection,
} from "../collections/index.ts";
import {
  defineFeature,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "../features/index.ts";
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

type FeatureScheduledJobRun =
  & Omit<ScheduledJobRun, "content">
  & Readonly<{ content: DurableContentInput }>;

type CreateScheduledJobFeatureInput = Readonly<{
  id?: string;
  name: string;
  status?: Exclude<ScheduledJobStatus, "cancelled">;
  schedule: ScheduledJobSchedule;
  run: FeatureScheduledJobRun;
  metadata?: Record<string, unknown>;
}>;

type UpdateScheduledJobFeatureInput = Readonly<{
  id: string;
  patch: Readonly<{
    name?: string;
    status?: ScheduledJobStatus;
    schedule?: ScheduledJobSchedule;
    run?: Partial<FeatureScheduledJobRun>;
    metadata?: Record<string, unknown>;
  }>;
}>;

type ListScheduledJobsFeatureInput = Readonly<{
  status?: ScheduledJobStatus;
  after?: string;
  limit?: number;
}>;

type ScheduledJobTransitionAction = (
  input: { id: string },
  context: FeatureExecuteContext,
) => Promise<ScheduledJob>;

type ScheduledJobsLifecycleActions = Readonly<{
  create: Readonly<{ execute: typeof create }>;
  update: Readonly<{ execute: typeof update }>;
  pause: Readonly<{ execute: ScheduledJobTransitionAction }>;
  resume: Readonly<{ execute: ScheduledJobTransitionAction }>;
  cancel: Readonly<{ execute: ScheduledJobTransitionAction }>;
  get: Readonly<{
    execute(
      input: { id: string },
      context: FeatureExecuteContext,
    ): Promise<ScheduledJob | null>;
  }>;
  list: Readonly<{
    execute(
      input: ListScheduledJobsFeatureInput,
      context: FeatureExecuteContext,
    ): Promise<readonly ScheduledJob[]>;
  }>;
}>;

function collection(
  context: FeatureExecuteContext,
): ScopedCollection<CollectionRecord, Record<string, unknown>> {
  const scoped = context.collections[scheduledJobCollection.name];
  if (!scoped) {
    throw new Error("Scheduled job collection is not bound.");
  }
  return scoped as ScopedCollection<CollectionRecord, Record<string, unknown>>;
}

function runPatch(
  current: ScheduledJob,
  input: Partial<FeatureScheduledJobRun>,
): ScheduledJobRun {
  return Object.freeze({
    ...structuredClone(current.run),
    ...structuredClone(input),
    content: input.content ?? current.run.content,
  }) as ScheduledJobRun;
}

async function create(
  input: CreateScheduledJobFeatureInput,
  context: FeatureExecuteContext,
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

async function update(
  input: UpdateScheduledJobFeatureInput,
  context: FeatureExecuteContext,
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
  if (input.patch.run) {
    patch.run = runPatch(current, input.patch.run);
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
    { id, set: patch as Partial<ScheduledJob> },
    { operationKey: `scheduled_job.update:${id}` },
  );
  return normalizeScheduledJobRecord(record);
}

function transition(status: ScheduledJobStatus): ScheduledJobTransitionAction {
  return (input: { id: string }, context: FeatureExecuteContext) =>
    update({ id: input.id, patch: { status } }, context);
}

export const scheduledJobsLifecycleFeature: FeatureDefinition<
  ScheduledJobsLifecycleActions
> = defineFeature({
  id: "copilotz.scheduled-jobs.lifecycle",
  actions: {
    create: { execute: create },
    update: { execute: update },
    pause: { execute: transition("paused") },
    resume: { execute: transition("active") },
    cancel: { execute: transition("cancelled") },
    get: {
      async execute(
        input: { id: string },
        context: FeatureExecuteContext,
      ): Promise<ScheduledJob | null> {
        const value = await collection(context).get({
          id: requireScheduledText(input.id, "Scheduled job ID"),
        });
        return value ? normalizeScheduledJobRecord(value) : null;
      },
    },
    list: {
      async execute(
        input: ListScheduledJobsFeatureInput = {},
        context: FeatureExecuteContext,
      ): Promise<readonly ScheduledJob[]> {
        const values = await collection(context).list({
          after: input.after,
          limit: input.limit,
          ...(input.status ? { where: { status: input.status } } : {}),
        });
        return Object.freeze(values.map(normalizeScheduledJobRecord));
      },
    },
  },
});
