/**
 * A routine's runs, one each time it ran (on time, or "Run now"): when, the
 * chat it posted in, and how it went: sent, failed (and why), or forbidden
 * (its maker can no longer write where it posts). In its routine's space.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const runSchema = {
  type: "object",
  properties: {
    routine: { type: "string" },
    in: { type: "string" },
    /** When it ran. */
    at: { type: "string" },
    /** When it was due, for a run on time. */
    due: { type: "string" },
    outcome: { enum: ["sent", "failed", "forbidden"] },
    /** The chat it posted in, and its message there. */
    thread: { type: "string" },
    message: { type: "string" },
    error: { type: "string" },
    /** Something it went well despite: its chat was gone, so it started a new one. */
    note: { type: "string" },
    /** Who asked for it now ("Run now"), a person's id; none when time did. */
    by: { type: "string" },
  },
  required: ["routine", "in", "at", "outcome"],
} as const;

export const routineRun = defineCollection({
  schema: runSchema,
  indexes: [["routine", "at"]],
});

export type RoutineRun = Infer<typeof runSchema> & { _id: string };
