import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContentSequence } from "@copilotz/copilotz/content";
import { Cron } from "../../../dependencies/croner.ts";
import type {
  ScheduledJob,
  ScheduledJobOccurrenceRef,
  ScheduledJobPayload,
  ScheduledJobSchedule,
  ScheduledJobStatus,
} from "./contracts.ts";

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

function normalizeOccurrence(value: unknown): ScheduledJobOccurrenceRef | null {
  if (value === null || value === undefined) return null;
  const occurrence = scheduledRecord(value, "Scheduled occurrence");
  const mode = occurrence.mode === "manual"
    ? "manual"
    : occurrence.mode === "scheduled"
    ? "scheduled"
    : undefined;
  if (!mode) throw new TypeError("Scheduled occurrence mode is invalid.");
  const scheduledFor = new Date(
    requireScheduledText(
      occurrence.scheduledFor,
      "Scheduled occurrence time",
    ),
  );
  if (Number.isNaN(scheduledFor.getTime())) {
    throw new TypeError("Scheduled occurrence time is invalid.");
  }
  return Object.freeze({
    id: requireScheduledText(occurrence.id, "Scheduled occurrence ID"),
    mode,
    scheduledFor: scheduledFor.toISOString(),
  });
}

export function normalizeScheduledJobRecord<
  TPayload extends ScheduledJobPayload = ScheduledJobPayload,
>(value: CollectionRecord): ScheduledJob<TPayload> {
  const payload = scheduledRecord(
    value.payload,
    "Scheduled job payload",
  ) as TPayload;
  if (value.content !== undefined && !Array.isArray(value.content)) {
    throw new TypeError("Scheduled job content must be canonical refs.");
  }
  return Object.freeze({
    ...value,
    name: requireScheduledText(value.name, "Scheduled job name"),
    status: normalizeScheduledJobStatus(value.status),
    schedule: normalizeScheduledJobSchedule(
      value.schedule as ScheduledJobSchedule,
    ),
    payload: Object.freeze(structuredClone(payload)),
    ...(Array.isArray(value.content)
      ? {
        content: Object.freeze(
          structuredClone(value.content),
        ) as ContentSequence,
      }
      : {}),
    nextRunAt: typeof value.nextRunAt === "string" ? value.nextRunAt : null,
    nextRunAtMs: typeof value.nextRunAtMs === "number"
      ? value.nextRunAtMs
      : null,
    lastOccurrence: normalizeOccurrence(value.lastOccurrence),
    metadata: Object.freeze(structuredClone(
      value.metadata && typeof value.metadata === "object" &&
        !Array.isArray(value.metadata)
        ? value.metadata as Record<string, unknown>
        : {},
    )),
  }) as ScheduledJob<TPayload>;
}
