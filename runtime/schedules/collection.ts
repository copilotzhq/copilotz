import { defineCollection } from "../domain/index.ts";
import type { CollectionDefinition } from "../domain/index.ts";

const scheduledJobSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
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
    run: {
      type: "object",
      additionalProperties: false,
      properties: {
        thread: { type: "object", additionalProperties: true },
        sender: { type: "object", additionalProperties: true },
        recipientIds: { type: "array", items: { type: "string" } },
        content: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["content"],
    },
    nextRunAt: { type: ["string", "null"] },
    nextRunAtMs: { type: ["number", "null"] },
    lastRunAt: { type: ["string", "null"] },
    lastRunAtMs: { type: ["number", "null"] },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "name",
    "status",
    "schedule",
    "run",
    "nextRunAt",
    "nextRunAtMs",
  ],
} as const;

export const scheduledJobCollection: CollectionDefinition<
  typeof scheduledJobSchema
> = defineCollection({
  name: "scheduled_job",
  schema: scheduledJobSchema,
  keys: [{ property: "id" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  content: { fields: ["run.content"] },
  indexes: ["status", "nextRunAtMs", ["status", "nextRunAtMs"]],
});
