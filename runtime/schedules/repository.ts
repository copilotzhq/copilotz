import { Cron } from "../../dependencies/croner.ts";
import type { CollectionRecord } from "../domain/index.ts";
import type { MutationIdentity } from "../domain/index.ts";
import type {
  DurableEventDraft,
  EventMutationContext,
} from "../events/index.ts";
import type {
  CreateScheduledJobInput,
  CreateScheduledJobRepositoryOptions,
  ScheduledJob,
  ScheduledJobOccurrence,
  ScheduledJobRepository,
  ScheduledJobRun,
  ScheduledJobRunNowResult,
  ScheduledJobSchedule,
  ScheduledJobStatus,
  ScheduledJobTickItem,
  UpdateScheduledJobInput,
} from "./types.ts";

const COLLECTION = "scheduled_job";
const NOT_DUE = "scheduled_job_not_due";

type JobRow = Readonly<{
  id: string;
  namespace: string;
  data: unknown;
  updated_at: string | Date;
  created_at: string | Date;
}>;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid timestamp.");
  return date.toISOString();
}

function status(value: unknown): ScheduledJobStatus {
  if (value === "active" || value === "paused" || value === "cancelled") {
    return value;
  }
  throw new TypeError(`Invalid scheduled job status '${String(value)}'.`);
}

function schedule(value: ScheduledJobSchedule): ScheduledJobSchedule {
  if (!value || value.type !== "cron") {
    throw new TypeError("Scheduled jobs currently require a cron schedule.");
  }
  return Object.freeze({
    type: "cron",
    expression: required(value.expression, "Cron expression"),
    ...(value.timezone?.trim() ? { timezone: value.timezone.trim() } : {}),
  });
}

export function getNextScheduledRunAt(
  value: ScheduledJobSchedule,
  from: Date = new Date(),
): Date {
  const normalized = schedule(value);
  const cron = new Cron(normalized.expression, {
    timezone: normalized.timezone,
    paused: true,
  });
  const next = cron.nextRun(from);
  if (!next) {
    throw new Error(
      `Cron expression has no next run: ${normalized.expression}`,
    );
  }
  return next;
}

function job(value: CollectionRecord): ScheduledJob {
  const run = record(value.run, "Scheduled job run") as ScheduledJobRun;
  if (!Array.isArray(run.content)) {
    throw new TypeError("Scheduled job run content must be canonical refs.");
  }
  return Object.freeze({
    ...value,
    name: required(value.name, "Scheduled job name"),
    status: status(value.status),
    schedule: schedule(value.schedule as ScheduledJobSchedule),
    run: Object.freeze(structuredClone(run)),
    nextRunAt: typeof value.nextRunAt === "string" ? value.nextRunAt : null,
    nextRunAtMs: typeof value.nextRunAtMs === "number"
      ? value.nextRunAtMs
      : null,
    lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : null,
    lastRunAtMs: typeof value.lastRunAtMs === "number"
      ? value.lastRunAtMs
      : null,
    metadata: Object.freeze(structuredClone(
      value.metadata && typeof value.metadata === "object"
        ? value.metadata as Record<string, unknown>
        : {},
    )),
  }) as ScheduledJob;
}

function rowJob(row: JobRow): ScheduledJob {
  const data = record(row.data, "Scheduled job row");
  return job({
    ...data,
    id: row.id,
    namespace: row.namespace,
    createdAt: typeof data.createdAt === "string"
      ? data.createdAt
      : iso(row.created_at),
    updatedAt: typeof data.updatedAt === "string"
      ? data.updatedAt
      : iso(row.updated_at),
  });
}

function contentKey(
  namespace: string,
  id: string | undefined,
  identity: MutationIdentity | undefined,
  operation: string,
): string {
  return `${
    identity?.deduplicationId ?? `${namespace}:${id ?? crypto.randomUUID()}`
  }:${operation}:content`;
}

function mutationIdentity(
  input: MutationIdentity | undefined,
  fallback: string,
): MutationIdentity {
  return input ?? { deduplicationId: fallback, correlationId: fallback };
}

function notDue(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: NOT_DUE });
}

function isNotDue(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
      (error as { code?: unknown }).code === NOT_DUE,
  );
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be positive.`);
  }
  return resolved;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForScope(
  options: CreateScheduledJobRepositoryOptions,
  namespace: string,
  eventId: string,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const expires = Date.now() + timeoutMs;
  while (true) {
    const settlement = await options.eventStore.scopeSettlement(
      namespace,
      eventId,
    );
    if (settlement.deadLetters > 0) {
      throw new Error(`Scheduled occurrence '${eventId}' dead-lettered.`);
    }
    if (settlement.cancelled > 0) {
      throw new Error(`Scheduled occurrence '${eventId}' was cancelled.`);
    }
    if (settlement.unsettled === 0) return;
    if (Date.now() >= expires) {
      throw new Error(
        `Scheduled occurrence '${eventId}' did not settle in time.`,
      );
    }
    await sleep(pollMs);
  }
}

function occurrence(candidate: ScheduledJob, scheduledFor: Date) {
  const occurrenceId = `${candidate.id}:${scheduledFor.getTime()}`;
  const payload: ScheduledJobOccurrence = Object.freeze({
    jobId: candidate.id,
    jobName: candidate.name,
    occurrenceId,
    scheduledFor: scheduledFor.toISOString(),
    run: Object.freeze(structuredClone(candidate.run)),
  });
  return { occurrenceId, payload };
}

/** Creates typed scheduled-job mutations over the graph/event transaction. */
export function createScheduledJobRepository(
  options: CreateScheduledJobRepositoryOptions,
): ScheduledJobRepository {
  const collection = () => options.collections.get(COLLECTION);
  const tables = options.eventStore.tables;
  const now = options.now ?? (() => new Date());
  const nextRunAt = options.nextRunAt ?? getNextScheduledRunAt;

  const create: ScheduledJobRepository["create"] = async (
    input: CreateScheduledJobInput,
  ) => {
    const namespace = required(input.namespace, "Namespace");
    const name = required(input.name, "Scheduled job name");
    const normalizedSchedule = schedule(input.schedule);
    const timestamp = now();
    const next = nextRunAt(normalizedSchedule, timestamp);
    const prepared = await options.preparer.prepare(input.run.content, {
      namespace,
      idempotencyKey: contentKey(
        namespace,
        input.id,
        input.identity,
        "create",
      ),
    });
    const identity = mutationIdentity(
      input.identity,
      `scheduled_job:create:${namespace}:${input.id ?? name}`,
    );
    const result = await collection().create({
      ...(input.id?.trim() ? { id: input.id.trim() } : {}),
      name,
      status: input.status ?? "active",
      schedule: normalizedSchedule,
      run: {
        ...structuredClone(input.run),
        content: prepared,
      },
      nextRunAt: next.toISOString(),
      nextRunAtMs: next.getTime(),
      lastRunAt: null,
      lastRunAtMs: null,
      metadata: structuredClone(input.metadata ?? {}),
    }, { namespace, identity });
    return Object.freeze({ ...result, value: job(result.value!) });
  };

  const update: ScheduledJobRepository["update"] = async (
    input: UpdateScheduledJobInput,
  ) => {
    const namespace = required(input.namespace, "Namespace");
    const id = required(input.id, "Scheduled job ID");
    const currentValue = await collection().get(namespace, id);
    if (!currentValue) throw new Error(`Scheduled job '${id}' was not found.`);
    const current = job(currentValue);
    const patch: Record<string, unknown> = {};
    if (input.patch.name !== undefined) {
      patch.name = required(input.patch.name, "Scheduled job name");
    }
    const normalizedSchedule = input.patch.schedule
      ? schedule(input.patch.schedule)
      : current.schedule;
    if (input.patch.schedule) patch.schedule = normalizedSchedule;
    const nextStatus = input.patch.status ?? current.status;
    if (input.patch.status !== undefined) {
      patch.status = status(input.patch.status);
    }
    if (input.patch.metadata !== undefined) {
      patch.metadata = structuredClone(input.patch.metadata);
    }
    if (input.patch.run) {
      let content:
        | ScheduledJobRun["content"]
        | Awaited<
          ReturnType<CreateScheduledJobRepositoryOptions["preparer"]["prepare"]>
        > = current.run.content;
      if (input.patch.run.content !== undefined) {
        content = await options.preparer.prepare(input.patch.run.content, {
          namespace,
          idempotencyKey: contentKey(
            namespace,
            id,
            input.identity,
            "update",
          ),
        });
      }
      patch.run = {
        ...structuredClone(current.run),
        ...structuredClone(input.patch.run),
        content,
      };
    }
    if (nextStatus === "cancelled") {
      patch.nextRunAt = null;
      patch.nextRunAtMs = null;
    } else if (
      input.patch.schedule ||
      (nextStatus === "active" && current.status !== "active") ||
      (nextStatus === "active" &&
        (current.nextRunAtMs === null ||
          current.nextRunAtMs <= now().getTime()))
    ) {
      const next = nextRunAt(normalizedSchedule, now());
      patch.nextRunAt = next.toISOString();
      patch.nextRunAtMs = next.getTime();
    }
    const identity = mutationIdentity(
      input.identity,
      `scheduled_job:update:${namespace}:${id}:${JSON.stringify(patch)}`,
    );
    const result = await collection().update(id, patch, {
      namespace,
      identity,
    });
    return Object.freeze({ ...result, value: job(result.value!) });
  };

  const transition = (
    namespace: string,
    id: string,
    nextStatus: ScheduledJobStatus,
    identity?: MutationIdentity,
  ) => update({ namespace, id, patch: { status: nextStatus }, identity });

  const runNow: ScheduledJobRepository["runNow"] = async (runOptions) => {
    const namespace = required(runOptions.namespace, "Namespace");
    const id = required(runOptions.id, "Scheduled job ID");
    const currentValue = await collection().get(namespace, id);
    if (!currentValue) throw new Error(`Scheduled job '${id}' was not found.`);
    const candidate = job(currentValue);
    if (candidate.status === "cancelled") {
      throw new Error(`Scheduled job '${id}' is cancelled.`);
    }
    const scheduledFor = runOptions.now ?? now();
    const fallback =
      `scheduled_job:run_now:${namespace}:${id}:${crypto.randomUUID()}`;
    const runIdentity = mutationIdentity(runOptions.identity, fallback);
    const deduplicationId = runIdentity.deduplicationId ?? fallback;
    const existingEvent = await options.eventStore.getEventByDeduplicationId(
      namespace,
      deduplicationId,
    );
    const occurrenceToken = encodeURIComponent(
      deduplicationId,
    );
    const occurrenceId = `${id}:manual:${occurrenceToken}`;
    const payload: ScheduledJobOccurrence = Object.freeze({
      jobId: id,
      jobName: candidate.name,
      occurrenceId,
      scheduledFor: scheduledFor.toISOString(),
      run: Object.freeze(structuredClone(candidate.run)),
    });
    const draft: DurableEventDraft = existingEvent
      ? {
        type: existingEvent.type,
        namespace: existingEvent.namespace,
        ...(existingEvent.threadId ? { threadId: existingEvent.threadId } : {}),
        ...(existingEvent.subject ? { subject: existingEvent.subject } : {}),
        payload: structuredClone(existingEvent.payload),
        ...(existingEvent.delta === undefined
          ? {}
          : { delta: structuredClone(existingEvent.delta) }),
        routing: structuredClone(existingEvent.routing),
        visibility: structuredClone(existingEvent.visibility),
        metadata: structuredClone(existingEvent.metadata),
        ...(existingEvent.causationId
          ? { causationId: existingEvent.causationId }
          : {}),
        correlationId: existingEvent.correlationId,
        deduplicationId,
      }
      : {
        type: "scheduled_job.due",
        namespace,
        ...(candidate.run.thread?.id
          ? { threadId: candidate.run.thread.id }
          : {}),
        subject: { type: COLLECTION, id },
        payload,
        delta: { lastRunAt: scheduledFor.toISOString() },
        visibility: { kind: "internal" },
        ...(runIdentity.causationId
          ? { causationId: runIdentity.causationId }
          : {}),
        correlationId: runIdentity.correlationId ?? occurrenceId,
        deduplicationId,
        metadata: {
          ...structuredClone(runIdentity.metadata ?? {}),
          scheduledJob: {
            jobId: id,
            occurrenceId,
            scheduledFor: scheduledFor.toISOString(),
            manual: true,
          },
        },
      };
    const committed = await options.coordinator.commitMutation({
      draft,
      mutate: async (context: EventMutationContext) => {
        const locked = await context.transaction.query<JobRow>(
          `SELECT id, namespace, data, created_at, updated_at
           FROM ${tables.nodes}
           WHERE namespace = $1 AND id = $2 AND type = '${COLLECTION}'
           FOR UPDATE`,
          [namespace, id],
        );
        const row = locked.rows[0];
        if (!row) throw new Error(`Scheduled job '${id}' was not found.`);
        const current = rowJob(row);
        if (current.status === "cancelled") {
          throw new Error(`Scheduled job '${id}' is cancelled.`);
        }
        if (
          current.name !== candidate.name ||
          JSON.stringify(current.run) !== JSON.stringify(candidate.run)
        ) {
          throw new Error(
            `Scheduled job '${id}' changed while its manual run was starting.`,
          );
        }
        const updatedAt = scheduledFor.toISOString();
        const updated = await context.transaction.query<JobRow>(
          `UPDATE ${tables.nodes}
           SET data = data || $1::jsonb, updated_at = $2::timestamptz
           WHERE namespace = $3 AND id = $4 AND type = '${COLLECTION}'
           RETURNING id, namespace, data, created_at, updated_at`,
          [
            JSON.stringify({
              lastRunAt: scheduledFor.toISOString(),
              lastRunAtMs: scheduledFor.getTime(),
              updatedAt,
            }),
            updatedAt,
            namespace,
            id,
          ],
        );
        return rowJob(updated.rows[0]);
      },
      recoverDuplicate: async (_event, context) => {
        const result = await context.transaction.query<JobRow>(
          `SELECT id, namespace, data, created_at, updated_at
           FROM ${tables.nodes}
           WHERE namespace = $1 AND id = $2 AND type = '${COLLECTION}'`,
          [namespace, id],
        );
        if (!result.rows[0]) throw new Error("Scheduled job disappeared.");
        return rowJob(result.rows[0]);
      },
    });
    if (runOptions.waitForCompletion) {
      await waitForScope(
        options,
        namespace,
        committed.event.id,
        positiveInteger(
          runOptions.settlementPollMs,
          10,
          "Schedule settlement poll interval",
        ),
        positiveInteger(
          runOptions.settlementTimeoutMs,
          300_000,
          "Schedule settlement timeout",
        ),
      );
    }
    const committedPayload = committed.event.payload as ScheduledJobOccurrence;
    const result: ScheduledJobRunNowResult = Object.freeze({
      jobId: id,
      name: committedPayload.jobName,
      occurrenceId: committedPayload.occurrenceId,
      eventId: committed.event.id,
      deduplicated: committed.deduplicated,
      dispatchFailures: committed.dispatch.failures.length,
    });
    return result;
  };

  const tick: ScheduledJobRepository["tick"] = async (tickOptions) => {
    const namespace = required(tickOptions.namespace, "Namespace");
    const checkedAt = tickOptions.now ?? now();
    const limit = positiveInteger(tickOptions.limit, 10, "Schedule tick limit");
    const pollMs = positiveInteger(
      tickOptions.settlementPollMs,
      10,
      "Schedule settlement poll interval",
    );
    const timeoutMs = positiveInteger(
      tickOptions.settlementTimeoutMs,
      300_000,
      "Schedule settlement timeout",
    );
    const candidates = await options.session.query<JobRow>(
      `SELECT id, namespace, data, created_at, updated_at
       FROM ${tables.nodes}
       WHERE namespace = $1 AND type = '${COLLECTION}'
         AND data->>'status' = 'active'
         AND NULLIF(data->>'nextRunAtMs', '')::bigint <= $2
       ORDER BY NULLIF(data->>'nextRunAtMs', '')::bigint, id
       LIMIT $3`,
      [namespace, checkedAt.getTime(), limit],
    );
    const jobs: ScheduledJobTickItem[] = [];
    for (const candidateRow of candidates.rows) {
      const candidate = rowJob(candidateRow);
      const scheduledForMs = candidate.nextRunAtMs;
      if (scheduledForMs === null) continue;
      const scheduledFor = new Date(scheduledForMs);
      const next = nextRunAt(candidate.schedule, checkedAt);
      const item = occurrence(candidate, scheduledFor);
      try {
        const committed = await options.coordinator.commitMutation({
          draft: {
            type: "scheduled_job.due",
            namespace,
            ...(candidate.run.thread?.id
              ? { threadId: candidate.run.thread.id }
              : {}),
            subject: { type: COLLECTION, id: candidate.id },
            payload: item.payload,
            delta: {
              lastRunAt: scheduledFor.toISOString(),
              nextRunAt: next.toISOString(),
            },
            visibility: { kind: "internal" },
            correlationId: item.occurrenceId,
            deduplicationId:
              `scheduled_job:due:${namespace}:${item.occurrenceId}`,
            metadata: {
              scheduledJob: {
                jobId: candidate.id,
                occurrenceId: item.occurrenceId,
                scheduledFor: scheduledFor.toISOString(),
              },
            },
          },
          mutate: async (context: EventMutationContext) => {
            const locked = await context.transaction.query<JobRow>(
              `SELECT id, namespace, data, created_at, updated_at
               FROM ${tables.nodes}
               WHERE namespace = $1 AND id = $2 AND type = '${COLLECTION}'
               FOR UPDATE`,
              [namespace, candidate.id],
            );
            const row = locked.rows[0];
            if (!row) throw notDue("Scheduled job was deleted.");
            const current = rowJob(row);
            if (
              current.status !== "active" ||
              current.nextRunAtMs !== scheduledForMs ||
              current.updatedAt !== candidate.updatedAt ||
              scheduledForMs > checkedAt.getTime()
            ) throw notDue("Scheduled job is no longer due.");
            const updatedAt = checkedAt.toISOString();
            const updated = await context.transaction.query<JobRow>(
              `UPDATE ${tables.nodes}
               SET data = data || $1::jsonb, updated_at = $2::timestamptz
               WHERE namespace = $3 AND id = $4 AND type = '${COLLECTION}'
               RETURNING id, namespace, data, created_at, updated_at`,
              [
                JSON.stringify({
                  lastRunAt: scheduledFor.toISOString(),
                  lastRunAtMs: scheduledForMs,
                  nextRunAt: next.toISOString(),
                  nextRunAtMs: next.getTime(),
                  updatedAt,
                }),
                updatedAt,
                namespace,
                candidate.id,
              ],
            );
            return rowJob(updated.rows[0]);
          },
          recoverDuplicate: async (_event, context) => {
            const result = await context.transaction.query<JobRow>(
              `SELECT id, namespace, data, created_at, updated_at
               FROM ${tables.nodes}
               WHERE namespace = $1 AND id = $2 AND type = '${COLLECTION}'`,
              [namespace, candidate.id],
            );
            if (!result.rows[0]) throw new Error("Scheduled job disappeared.");
            return rowJob(result.rows[0]);
          },
        });
        if (tickOptions.waitForCompletion) {
          await waitForScope(
            options,
            namespace,
            committed.event.id,
            pollMs,
            timeoutMs,
          );
        }
        if (committed.deduplicated) {
          jobs.push(Object.freeze({
            jobId: candidate.id,
            name: candidate.name,
            occurrenceId: item.occurrenceId,
            eventId: committed.event.id,
            status: "skipped",
          }));
          continue;
        }
        jobs.push(Object.freeze({
          jobId: candidate.id,
          name: candidate.name,
          occurrenceId: item.occurrenceId,
          eventId: committed.event.id,
          status: "dispatched",
          dispatchFailures: committed.dispatch.failures.length,
        }));
      } catch (error) {
        jobs.push(Object.freeze(
          isNotDue(error)
            ? {
              jobId: candidate.id,
              name: candidate.name,
              occurrenceId: item.occurrenceId,
              status: "skipped",
            }
            : {
              jobId: candidate.id,
              name: candidate.name,
              occurrenceId: item.occurrenceId,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
        ));
      }
    }
    return Object.freeze({
      namespace,
      checkedAt: checkedAt.toISOString(),
      claimed: jobs.filter((item) => item.status === "dispatched").length,
      dispatched: jobs.filter((item) => item.status === "dispatched").length,
      skipped: jobs.filter((item) => item.status === "skipped").length,
      failed: jobs.filter((item) => item.status === "failed").length,
      jobs: Object.freeze(jobs),
    });
  };

  return Object.freeze({
    create,
    update,
    pause: (namespace, id, identity) =>
      transition(namespace, id, "paused", identity),
    resume: (namespace, id, identity) =>
      transition(namespace, id, "active", identity),
    cancel: (namespace, id, identity) =>
      transition(namespace, id, "cancelled", identity),
    async get(namespace, id) {
      const value = await collection().get(
        required(namespace, "Namespace"),
        required(id, "Scheduled job ID"),
      );
      return value ? job(value) : null;
    },
    async list(namespace, listOptions = {}) {
      const values = await collection().list(required(namespace, "Namespace"), {
        after: listOptions.after,
        limit: listOptions.limit,
        ...(listOptions.status
          ? { where: { status: listOptions.status } }
          : {}),
      });
      return Object.freeze(values.map(job));
    },
    runNow,
    tick,
  });
}
