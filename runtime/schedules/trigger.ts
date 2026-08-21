import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type {
  CollectionEventBody,
  CollectionMutation,
  CollectionRecord,
  CollectionWrite,
} from "../collections/index.ts";
import { isCollectionNoop } from "../collections/index.ts";
import { scheduledJobCollection } from "./collection.ts";
import {
  getNextScheduledRunAt,
  normalizeScheduledJobRecord,
  requireScheduledText,
  scheduledRecord,
} from "./model.ts";
import type {
  CreateScheduledJobTriggerOptions,
  ScheduledJob,
  ScheduledJobRunNowResult,
  ScheduledJobTickItem,
  ScheduledJobTrigger,
} from "./types.ts";

const NOT_DUE_MESSAGES = [
  "is no longer due",
  "is not active",
  "is not due yet",
  "was not found",
];

type JobRow = Readonly<{
  id: string;
  namespace: string;
  data: unknown;
  updated_at: string | Date;
  created_at: string | Date;
}>;

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid timestamp.");
  return date.toISOString();
}

function rowJob(row: JobRow): ScheduledJob {
  const data = scheduledRecord(row.data, "Scheduled job row");
  return normalizeScheduledJobRecord({
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
  options: CreateScheduledJobTriggerOptions,
  namespace: string,
  settlementScopeId: string,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const expires = Date.now() + timeoutMs;
  while (true) {
    const settlement = await options.eventStore.scopeSettlement(
      namespace,
      settlementScopeId,
    );
    if (settlement.deadLetters > 0) {
      throw new Error(
        `Scheduled scope '${settlementScopeId}' dead-lettered.`,
      );
    }
    if (settlement.cancelled > 0) {
      throw new Error(`Scheduled scope '${settlementScopeId}' was cancelled.`);
    }
    if (settlement.unsettled === 0) return;
    if (Date.now() >= expires) {
      throw new Error(
        `Scheduled scope '${settlementScopeId}' did not settle in time.`,
      );
    }
    await sleep(pollMs);
  }
}

function isNotDue(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NOT_DUE_MESSAGES.some((item) => message.includes(item));
}

function requireMutation(
  value: CollectionWrite<ScheduledJob>,
): CollectionMutation<ScheduledJob> {
  if (isCollectionNoop(value)) {
    throw new Error(`Scheduled job '${value.record.id}' was not due.`);
  }
  return value;
}

function occurrenceId(
  jobId: string,
  scheduledFor: Date,
  manualDeduplicationId?: string,
): string {
  return manualDeduplicationId
    ? `${jobId}:manual:${encodeURIComponent(manualDeduplicationId)}`
    : `${jobId}:${scheduledFor.getTime()}`;
}

async function eventBodyJob(
  options: CreateScheduledJobTriggerOptions,
  namespace: string,
  event: { payload: unknown },
): Promise<ScheduledJob> {
  const body = await readEventBody<CollectionEventBody<CollectionRecord>>(
    { transaction: options.session, tables: options.eventStore.tables },
    namespace,
    eventDataRef(event.payload),
  );
  return normalizeScheduledJobRecord(body.record);
}

async function settlementScopeForEvent(
  options: CreateScheduledJobTriggerOptions,
  namespace: string,
  eventId: string,
): Promise<string> {
  const deliveries = await options.eventStore.listDeliveries({
    namespace,
    eventId,
    limit: 1,
  });
  return deliveries[0]?.settlementScopeId ?? eventId;
}

export function createScheduledJobTrigger(
  options: CreateScheduledJobTriggerOptions,
): ScheduledJobTrigger {
  const now = options.now ?? (() => new Date());
  const nextRunAt = options.nextRunAt ?? getNextScheduledRunAt;
  const collection = () => {
    const bound = options.collectionRuntime.get<ScheduledJob>(
      scheduledJobCollection.name,
    );
    if (!bound) throw new Error("Scheduled job collection is not bound.");
    return bound;
  };

  const triggerDue = async (input: {
    namespace: string;
    id: string;
    mode: "manual" | "scheduled";
    scheduledFor: Date;
    checkedAt?: Date;
    deduplicationId: string;
    correlationId: string;
    causationId?: string;
    settlementScopeId?: string;
    metadata?: Record<string, unknown>;
    waitForCompletion?: boolean;
    settlementPollMs?: number;
    settlementTimeoutMs?: number;
    threadId?: string;
  }): Promise<CollectionMutation<ScheduledJob>> => {
    const mutation = requireMutation(
      await collection().mutate(input.id, "due", {
        mode: input.mode,
        scheduledFor: input.scheduledFor.toISOString(),
        ...(input.checkedAt
          ? { checkedAt: input.checkedAt.toISOString() }
          : {}),
      }, {
        namespace: input.namespace,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        visibility: { kind: "internal" },
        identity: {
          deduplicationId: input.deduplicationId,
          correlationId: input.correlationId,
          ...(input.causationId ? { causationId: input.causationId } : {}),
          ...(input.settlementScopeId
            ? { settlementScopeId: input.settlementScopeId }
            : {}),
          metadata: {
            ...structuredClone(input.metadata ?? {}),
            scheduledJob: {
              jobId: input.id,
              occurrenceId: occurrenceId(
                input.id,
                input.scheduledFor,
                input.mode === "manual" ? input.deduplicationId : undefined,
              ),
              scheduledFor: input.scheduledFor.toISOString(),
              ...(input.mode === "manual" ? { manual: true } : {}),
            },
          },
        },
      }),
    );
    if (input.waitForCompletion) {
      await waitForScope(
        options,
        input.namespace,
        mutation.settlementScopeId,
        positiveInteger(
          input.settlementPollMs,
          10,
          "Schedule settlement poll interval",
        ),
        positiveInteger(
          input.settlementTimeoutMs,
          300_000,
          "Schedule settlement timeout",
        ),
      );
    }
    return mutation;
  };

  const runNow: ScheduledJobTrigger["runNow"] = async (runOptions) => {
    const namespace = requireScheduledText(runOptions.namespace, "Namespace");
    const id = requireScheduledText(runOptions.id, "Scheduled job ID");
    const scheduledFor = runOptions.now ?? now();
    const fallback =
      `scheduled_job:run_now:${namespace}:${id}:${crypto.randomUUID()}`;
    const deduplicationId = runOptions.identity?.deduplicationId ?? fallback;
    const existing = await options.eventStore.getEventByDeduplicationId(
      namespace,
      deduplicationId,
    );
    if (existing) {
      const job = await eventBodyJob(options, namespace, existing);
      const settlementScopeId = await settlementScopeForEvent(
        options,
        namespace,
        existing.id,
      );
      return Object.freeze({
        jobId: id,
        name: job.name,
        occurrenceId: occurrenceId(
          id,
          new Date(job.lastRunAt!),
          deduplicationId,
        ),
        eventId: existing.id,
        settlementScopeId,
        deduplicated: true,
        dispatchFailures: 0,
      });
    }
    const current = await collection().get(id, namespace);
    if (!current) throw new Error(`Scheduled job '${id}' was not found.`);
    const job = normalizeScheduledJobRecord(current);
    const committed = await triggerDue({
      namespace,
      id,
      mode: "manual",
      scheduledFor,
      deduplicationId,
      correlationId: runOptions.identity?.correlationId ??
        occurrenceId(id, scheduledFor, deduplicationId),
      ...(runOptions.identity?.causationId
        ? { causationId: runOptions.identity.causationId }
        : {}),
      ...(runOptions.identity?.settlementScopeId
        ? { settlementScopeId: runOptions.identity.settlementScopeId }
        : {}),
      metadata: runOptions.identity?.metadata,
      waitForCompletion: runOptions.waitForCompletion,
      settlementPollMs: runOptions.settlementPollMs,
      settlementTimeoutMs: runOptions.settlementTimeoutMs,
      ...(job.run.thread?.id ? { threadId: job.run.thread.id } : {}),
    });
    const result: ScheduledJobRunNowResult = Object.freeze({
      jobId: id,
      name: committed.record.name,
      occurrenceId: occurrenceId(id, scheduledFor, deduplicationId),
      eventId: committed.event.id,
      settlementScopeId: committed.settlementScopeId,
      deduplicated: committed.deduplicated,
      dispatchFailures: committed.dispatch.failures.length,
    });
    return result;
  };

  const tick: ScheduledJobTrigger["tick"] = async (tickOptions) => {
    const namespace = requireScheduledText(tickOptions.namespace, "Namespace");
    const checkedAt = tickOptions.now ?? now();
    const limit = positiveInteger(tickOptions.limit, 10, "Schedule tick limit");
    const candidates = await options.session.query<JobRow>(
      `SELECT id, namespace, data, created_at, updated_at
       FROM ${options.eventStore.tables.nodes}
       WHERE namespace = $1 AND type = $2
         AND data->>'status' = 'active'
         AND NULLIF(data->>'nextRunAtMs', '')::bigint <= $3
       ORDER BY NULLIF(data->>'nextRunAtMs', '')::bigint, id
       LIMIT $4`,
      [
        namespace,
        scheduledJobCollection.name,
        checkedAt.getTime(),
        limit,
      ],
    );
    const jobs: ScheduledJobTickItem[] = [];
    for (const row of candidates.rows) {
      const candidate = rowJob(row);
      const scheduledForMs = candidate.nextRunAtMs;
      if (scheduledForMs === null) continue;
      const scheduledFor = new Date(scheduledForMs);
      const id = occurrenceId(candidate.id, scheduledFor);
      try {
        nextRunAt(candidate.schedule, checkedAt);
        const committed = await triggerDue({
          namespace,
          id: candidate.id,
          mode: "scheduled",
          scheduledFor,
          checkedAt,
          deduplicationId: `scheduled_job:due:${namespace}:${id}`,
          correlationId: id,
          waitForCompletion: tickOptions.waitForCompletion,
          settlementPollMs: tickOptions.settlementPollMs,
          settlementTimeoutMs: tickOptions.settlementTimeoutMs,
          ...(candidate.run.thread?.id
            ? { threadId: candidate.run.thread.id }
            : {}),
        });
        jobs.push(Object.freeze({
          jobId: candidate.id,
          name: candidate.name,
          occurrenceId: id,
          eventId: committed.event.id,
          status: committed.deduplicated ? "skipped" : "dispatched",
          ...(committed.deduplicated
            ? {}
            : { dispatchFailures: committed.dispatch.failures.length }),
        }));
      } catch (error) {
        jobs.push(Object.freeze(
          isNotDue(error)
            ? {
              jobId: candidate.id,
              name: candidate.name,
              occurrenceId: id,
              status: "skipped",
            }
            : {
              jobId: candidate.id,
              name: candidate.name,
              occurrenceId: id,
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

  return Object.freeze({ runNow, tick });
}
