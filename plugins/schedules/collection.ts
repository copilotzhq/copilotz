import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { getNextScheduledRunAt } from "./model.ts";
import type { ScheduledJobSchedule } from "./types.ts";

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function iso(value: unknown, name: string): string {
  const date = new Date(text(value, name));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} is invalid.`);
  return date.toISOString();
}

const occurrenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    mode: { type: "string", enum: ["scheduled", "manual"] },
    scheduledFor: { type: "string" },
  },
  required: ["id", "mode", "scheduledFor"],
} as const;

const scheduledJobSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    name: { type: "string" },
    status: {
      type: "string",
      enum: ["active", "paused", "cancelled"],
    },
    schedule: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "cron" },
        expression: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["type", "expression"],
    },
    payload: { type: "object", additionalProperties: true },
    content: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    nextRunAt: { type: ["string", "null"] },
    nextRunAtMs: { type: ["number", "null"] },
    lastOccurrence: { anyOf: [occurrenceSchema, { type: "null" }] },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "name",
    "status",
    "schedule",
    "payload",
    "nextRunAt",
    "nextRunAtMs",
    "lastOccurrence",
    "metadata",
  ],
} as const;

const dueCommandInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    occurrenceId: { type: "string" },
    mode: { type: "string", enum: ["scheduled", "manual"] },
    scheduledFor: { type: "string" },
    checkedAt: { type: "string" },
  },
  required: ["occurrenceId", "mode", "scheduledFor"],
} as const;

export const scheduledJobCollection: CollectionDefinition<
  typeof scheduledJobSchema
> = defineCollection({
  name: "scheduled_job",
  schema: scheduledJobSchema,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  content: { fields: ["content"] },
  indexes: ["status", "nextRunAtMs", ["status", "nextRunAtMs"]],
  commands: {
    due: {
      event: "scheduled_job.due",
      input: dueCommandInputSchema,
      mutate({ current, input }) {
        const command = record(input, "Scheduled due command");
        const mode = command.mode === "manual" ? "manual" : "scheduled";
        const scheduledFor = new Date(
          iso(command.scheduledFor, "Scheduled occurrence time"),
        );
        const scheduledForMs = scheduledFor.getTime();
        if (current.status === "cancelled") {
          throw new Error(`Scheduled job '${current.id}' is cancelled.`);
        }
        const set: Record<string, unknown> = {
          lastOccurrence: {
            id: text(command.occurrenceId, "Scheduled occurrence ID"),
            mode,
            scheduledFor: scheduledFor.toISOString(),
          },
        };
        if (mode === "scheduled") {
          if (current.status !== "active") {
            throw new Error(`Scheduled job '${current.id}' is not active.`);
          }
          if (current.nextRunAtMs !== scheduledForMs) {
            throw new Error(`Scheduled job '${current.id}' is no longer due.`);
          }
          const checkedAt = new Date(
            command.checkedAt === undefined
              ? scheduledFor.toISOString()
              : iso(command.checkedAt, "Scheduled check time"),
          );
          if (scheduledForMs > checkedAt.getTime()) {
            throw new Error(`Scheduled job '${current.id}' is not due yet.`);
          }
          const next = getNextScheduledRunAt(
            current.schedule as ScheduledJobSchedule,
            checkedAt,
          );
          set.nextRunAt = next.toISOString();
          set.nextRunAtMs = next.getTime();
        }
        return { set };
      },
    },
  },
});
