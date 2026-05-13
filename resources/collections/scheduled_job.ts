/**
 * Scheduled job collection: cron-like recurring runs stored as graph nodes.
 */
import { defineCollection } from "@/database/collections/index.ts";

export default defineCollection({
  name: "scheduled_job",
  schema: {
    type: "object",
    additionalProperties: true,
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
          type: { type: "string", enum: ["cron"] },
          expression: { type: "string" },
          timezone: { type: "string" },
        },
        required: ["type", "expression"],
      },
      run: {
        type: "object",
        additionalProperties: true,
        properties: {
          message: { type: "object", additionalProperties: true },
          options: { type: ["object", "null"], additionalProperties: true },
        },
        required: ["message"],
      },
      nextRunAt: { type: ["string", "null"] },
      nextRunAtMs: { type: ["number", "null"] },
      lastRunAt: { type: ["string", "null"] },
      lastRunAtMs: { type: ["number", "null"] },
      leaseOwner: { type: ["string", "null"] },
      leaseUntilMs: { type: ["number", "null"] },
      metadata: { type: ["object", "null"], additionalProperties: true },
    },
    required: ["name", "status", "schedule", "run", "nextRunAt", "nextRunAtMs"],
  } as const,
  keys: [{ property: "id" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  indexes: [
    "status",
    "nextRunAtMs",
    ["status", "nextRunAtMs"],
  ],
});
