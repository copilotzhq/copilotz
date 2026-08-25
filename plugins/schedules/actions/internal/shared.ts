import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ScheduledJobOccurrenceRef } from "../../internal/contracts.ts";

export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

export function instant(
  value: string | undefined,
  fallback: Date,
  name: string,
): Date {
  if (value === undefined) return fallback;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new TypeError(`${name} is invalid.`);
  }
  return result;
}

export function occurrence(
  jobId: string,
  scheduledFor: Date,
  mode: "scheduled" | "manual",
): ScheduledJobOccurrenceRef {
  return Object.freeze({
    id: mode === "manual"
      ? `${jobId}:manual:${scheduledFor.getTime()}`
      : `${jobId}:${scheduledFor.getTime()}`,
    mode,
    scheduledFor: scheduledFor.toISOString(),
  });
}

export function scheduledJobCollection(context: ActionContext) {
  const value = context.collections.scheduledJob;
  if (!value) throw new Error("Collection 'scheduledJob' is not bound.");
  return value;
}
