import { Cron } from "../../dependencies/croner.ts";
import type { CollectionRecord } from "../domain/index.ts";
import type {
  ScheduledJob,
  ScheduledJobRun,
  ScheduledJobSchedule,
  ScheduledJobStatus,
} from "./types.ts";

export function requireScheduledText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

export function scheduledRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function normalizeScheduledJobStatus(
  value: unknown,
): ScheduledJobStatus {
  if (value === "active" || value === "paused" || value === "cancelled") {
    return value;
  }
  throw new TypeError(`Invalid scheduled job status '${String(value)}'.`);
}

export function normalizeScheduledJobSchedule(
  value: ScheduledJobSchedule,
): ScheduledJobSchedule {
  if (!value || value.type !== "cron") {
    throw new TypeError("Scheduled jobs currently require a cron schedule.");
  }
  return Object.freeze({
    type: "cron",
    expression: requireScheduledText(value.expression, "Cron expression"),
    ...(value.timezone?.trim() ? { timezone: value.timezone.trim() } : {}),
  });
}

export function getNextScheduledRunAt(
  value: ScheduledJobSchedule,
  from: Date = new Date(),
): Date {
  const normalized = normalizeScheduledJobSchedule(value);
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

export function normalizeScheduledJobRecord(
  value: CollectionRecord,
): ScheduledJob {
  const run = scheduledRecord(
    value.run,
    "Scheduled job run",
  ) as ScheduledJobRun;
  if (!Array.isArray(run.content)) {
    throw new TypeError("Scheduled job run content must be canonical refs.");
  }
  return Object.freeze({
    ...value,
    name: requireScheduledText(value.name, "Scheduled job name"),
    status: normalizeScheduledJobStatus(value.status),
    schedule: normalizeScheduledJobSchedule(
      value.schedule as ScheduledJobSchedule,
    ),
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
