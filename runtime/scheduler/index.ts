import { Cron } from "croner";
import type { Copilotz } from "@/index.ts";
import type { MessagePayload } from "@/types/index.ts";
import type { RunOptions } from "@/runtime/index.ts";

export type ScheduledJobStatus = "active" | "paused" | "cancelled";

export type ScheduledJobSchedule = {
  type: "cron";
  expression: string;
  timezone?: string;
};

export type ScheduledJobRunTemplate = {
  message: MessagePayload;
  options?: RunOptions | null;
};

export type ScheduledJobData = {
  id?: string;
  name: string;
  status: ScheduledJobStatus;
  schedule: ScheduledJobSchedule;
  run: ScheduledJobRunTemplate;
  nextRunAt: string | null;
  nextRunAtMs: number | null;
  lastRunAt?: string | null;
  lastRunAtMs?: number | null;
  leaseOwner?: string | null;
  leaseUntilMs?: number | null;
  metadata?: Record<string, unknown> | null;
};

type ScheduledJobRow = {
  id: string;
  namespace: string | null;
  name: string | null;
  data: ScheduledJobData;
};

export type ScheduledJobTickOptions = {
  namespace?: string;
  now?: Date;
  limit?: number;
  leaseMs?: number;
  leaseOwner?: string;
  waitForCompletion?: boolean;
};

export type ScheduledJobTickResult = {
  namespace: string;
  checkedAt: string;
  claimed: number;
  dispatched: number;
  skipped: number;
  failed: number;
  jobs: Array<{
    jobId: string;
    name: string;
    runId?: string;
    status: "dispatched" | "skipped" | "failed";
    queueId?: string;
    threadId?: string;
    error?: string;
  }>;
};

export function getNextScheduledRunAt(
  schedule: ScheduledJobSchedule,
  from: Date = new Date(),
): Date {
  if (schedule.type !== "cron") {
    throw new Error(`Unsupported scheduled job type: ${schedule.type}`);
  }
  const cron = new Cron(schedule.expression, {
    timezone: schedule.timezone,
    paused: true,
  });
  const next = cron.nextRun(from);
  if (!next) {
    throw new Error(`Cron expression has no next run: ${schedule.expression}`);
  }
  return next;
}

async function claimDueScheduledJobs(
  copilotz: Pick<Copilotz, "ops" | "config">,
  options: Required<
    Pick<ScheduledJobTickOptions, "limit" | "leaseMs" | "leaseOwner">
  > & { namespace: string; nowMs: number },
): Promise<ScheduledJobRow[]> {
  const leaseUntilMs = options.nowMs + options.leaseMs;
  const result = await copilotz.ops.query<ScheduledJobRow>(
    `WITH due AS (
       SELECT "id"
       FROM "nodes"
       WHERE "type" = 'scheduled_job'
         AND "namespace" = $1
         AND "data"->>'status' = 'active'
         AND (NULLIF("data"->>'nextRunAtMs', '')::bigint) <= $2
         AND (
           "data"->>'leaseUntilMs' IS NULL
           OR (NULLIF("data"->>'leaseUntilMs', '')::bigint) <= $2
         )
       ORDER BY (NULLIF("data"->>'nextRunAtMs', '')::bigint) ASC, "id" ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     UPDATE "nodes" job
     SET "data" = jsonb_set(
           jsonb_set(job."data", '{leaseOwner}', to_jsonb($4::text), true),
           '{leaseUntilMs}',
           to_jsonb($5::bigint),
           true
         ),
         "updated_at" = NOW()
     FROM due
     WHERE job."id" = due."id"
     RETURNING job."id", job."namespace", job."name", job."data"`,
    [
      options.namespace,
      options.nowMs,
      options.limit,
      options.leaseOwner,
      leaseUntilMs,
    ],
  );
  return result.rows;
}

async function hasRunEvent(
  copilotz: Pick<Copilotz, "ops">,
  runId: string,
): Promise<boolean> {
  const existing = await copilotz.ops.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM "events"
       WHERE metadata->'scheduledJob'->>'runId' = $1
     ) AS "exists"`,
    [runId],
  );
  return existing.rows[0]?.exists === true;
}

async function advanceScheduledJob(
  copilotz: Pick<Copilotz, "ops">,
  job: ScheduledJobRow,
  args: { now: Date; lastRunAt: Date },
): Promise<void> {
  const next = getNextScheduledRunAt(job.data.schedule, args.now);
  await copilotz.ops.query(
    `UPDATE "nodes"
     SET "data" = (
       ("data" - 'leaseOwner' - 'leaseUntilMs') ||
       jsonb_build_object(
         'lastRunAt', $2::text,
         'lastRunAtMs', $3::bigint,
         'nextRunAt', $4::text,
         'nextRunAtMs', $5::bigint
       )
     ),
     "updated_at" = NOW()
     WHERE "id" = $1`,
    [
      job.id,
      args.lastRunAt.toISOString(),
      args.lastRunAt.getTime(),
      next.toISOString(),
      next.getTime(),
    ],
  );
}

async function releaseScheduledJobLease(
  copilotz: Pick<Copilotz, "ops">,
  jobId: string,
): Promise<void> {
  await copilotz.ops.query(
    `UPDATE "nodes"
     SET "data" = "data" - 'leaseOwner' - 'leaseUntilMs',
         "updated_at" = NOW()
     WHERE "id" = $1`,
    [jobId],
  );
}

function buildScheduledRun(
  job: ScheduledJobRow,
  scheduledFor: Date,
): {
  runId: string;
  message: MessagePayload;
  options: RunOptions;
} {
  const runId = `${job.id}:${scheduledFor.getTime()}`;
  const templateMessage = job.data.run.message;
  const templateMetadata = templateMessage.metadata &&
      typeof templateMessage.metadata === "object"
    ? templateMessage.metadata as Record<string, unknown>
    : {};
  const scheduledJobMetadata = {
    jobId: job.id,
    jobName: job.data.name,
    runId,
    scheduledFor: scheduledFor.toISOString(),
    scheduledForMs: scheduledFor.getTime(),
  };

  const message: MessagePayload = {
    ...templateMessage,
    sender: {
      ...(templateMessage.sender ?? {}),
      type: "job",
      id: templateMessage.sender?.id ?? job.id,
      externalId: templateMessage.sender?.externalId ?? job.id,
      name: templateMessage.sender?.name ?? job.data.name,
    },
    metadata: {
      ...templateMetadata,
      scheduledJob: scheduledJobMetadata,
    },
  };
  const templateOptions = job.data.run.options ?? {};
  const eventMetadata = templateOptions.eventMetadata &&
      typeof templateOptions.eventMetadata === "object"
    ? templateOptions.eventMetadata as Record<string, unknown>
    : {};
  const options: RunOptions = {
    ...templateOptions,
    namespace: job.namespace ?? templateOptions.namespace,
    traceId: runId,
    eventMetadata: {
      ...eventMetadata,
      scheduledJob: scheduledJobMetadata,
    },
  };

  return { runId, message, options };
}

async function dispatchScheduledJob(
  copilotz: Pick<Copilotz, "ops" | "run">,
  job: ScheduledJobRow,
  now: Date,
  waitForCompletion: boolean,
): Promise<ScheduledJobTickResult["jobs"][number]> {
  const scheduledForMs = typeof job.data.nextRunAtMs === "number"
    ? job.data.nextRunAtMs
    : now.getTime();
  const scheduledFor = new Date(scheduledForMs);
  const { runId, message, options } = buildScheduledRun(job, scheduledFor);

  if (await hasRunEvent(copilotz, runId)) {
    await advanceScheduledJob(copilotz, job, {
      now,
      lastRunAt: scheduledFor,
    });
    return {
      jobId: job.id,
      name: job.data.name,
      runId,
      status: "skipped",
    };
  }

  const handle = await copilotz.run(message, options);
  await advanceScheduledJob(copilotz, job, {
    now,
    lastRunAt: scheduledFor,
  });
  if (waitForCompletion) {
    await handle.done;
  } else {
    handle.done.catch((err) => {
      console.error("[scheduler] scheduled job run failed", {
        jobId: job.id,
        runId,
        threadId: handle.threadId,
        queueId: handle.queueId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return {
    jobId: job.id,
    name: job.data.name,
    runId,
    status: "dispatched",
    queueId: handle.queueId,
    threadId: handle.threadId,
  };
}

export async function tickScheduledJobs(
  copilotz: Pick<Copilotz, "ops" | "config" | "run">,
  options: ScheduledJobTickOptions = {},
): Promise<ScheduledJobTickResult> {
  const namespace = options.namespace ?? copilotz.config.namespace;
  if (!namespace) {
    throw new Error("Tenant namespace is required to tick scheduled jobs");
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const leaseOwner = options.leaseOwner ?? crypto.randomUUID();
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  const leaseMs = Math.max(1_000, Math.floor(options.leaseMs ?? 60_000));
  const rows = await claimDueScheduledJobs(copilotz, {
    namespace,
    nowMs,
    limit,
    leaseMs,
    leaseOwner,
  });

  const jobs: ScheduledJobTickResult["jobs"] = [];
  for (const job of rows) {
    try {
      jobs.push(
        await dispatchScheduledJob(
          copilotz,
          job,
          now,
          options.waitForCompletion === true,
        ),
      );
    } catch (err) {
      await releaseScheduledJobLease(copilotz, job.id).catch(() => undefined);
      jobs.push({
        jobId: job.id,
        name: job.data.name,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    namespace,
    checkedAt: now.toISOString(),
    claimed: rows.length,
    dispatched: jobs.filter((job) => job.status === "dispatched").length,
    skipped: jobs.filter((job) => job.status === "skipped").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    jobs,
  };
}
