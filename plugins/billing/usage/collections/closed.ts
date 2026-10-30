/**
 * The days closed: rolled up whole. Closing goes day by day from the
 * ledger's first, so they run without gaps, and each keeps how many records
 * it rolled up: a later count that differs means records came late.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

export const closedSchema = {
  type: "object",
  properties: {
    /** Records rolled up. */
    records: { type: "integer" },
    /** Rollups made of them. */
    groups: { type: "integer" },
    /** When it was closed. */
    at: { type: "string" },
  },
  required: ["records", "groups", "at"],
} as const;

/** A closed day: its `_id` is the day (`2026-10-27`). */
export type ClosedDay = Infer<typeof closedSchema> & { _id: string };

export const usageClosed = defineCollection({ schema: closedSchema, events: false });
