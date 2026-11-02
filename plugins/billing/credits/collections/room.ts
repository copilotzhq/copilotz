/**
 * How much an org can still spend (`_id: "room"`): the answer to "may it?"
 * without reading the ledger. Kept in the owner's memory, so every executor
 * sees the same one and writing it commits nothing; a new owner starts
 * without it and works it out again. Each use takes its price off it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

export const roomSchema = {
  type: "object",
  properties: {
    /** Credits left, and the month's budget left (USD); `NO_LIMIT` for none. */
    credits: { type: "number" },
    budget: { type: "number" },
    /** The budget itself (USD), to say so when it's reached. */
    limit: { type: "number" },
    /** Below these it's running low. */
    lowCredits: { type: "number" },
    lowBudget: { type: "number" },
    /** Worked out again from then on: when a date changes what it should say. */
    until: { type: "string" },
  },
  required: ["credits", "budget", "until"],
} as const;

export type Room = Infer<typeof roomSchema> & { _id: string };

export const billingRoom = defineCollection({ durable: false, schema: roomSchema });
