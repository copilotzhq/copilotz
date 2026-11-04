/**
 * The web lines' counters, for their `limits`: new visitors an hour from
 * each network; a visitor's messages a minute and a day, each of its
 * networks', the line's a minute (and its newcomers'); new visitors who
 * speak, an hour, on the line and from each network; and what the line's
 * visitors' turns were charged today (`spent`, for its `budget`, with what's
 * held for messages let in, `holds`), and the most one call cost lately. Each
 * counter is one window's (`<line>|<what>@<window start>`), counting until
 * `until` (ms), and goes after it (`contact.prune`). Networks are counted by
 * their tags (HMACs), never as they are. Kept in memory: gone on restart,
 * when it matters least.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const rateSchema = {
  type: "object",
  properties: {
    until: { type: "integer" },
    count: { type: "integer" },
    /** What was charged in the window (a line's budget's); for a line's cost, one call's. */
    spent: { type: "number" },
    /** A line's budget's day: what's held for messages let in, by visitor (see shared/budget.ts). */
    holds: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { amount: { type: "number" }, until: { type: "integer" } },
        required: ["amount", "until"],
      },
    },
    /** Why the day is closed: use nothing priced (its model). */
    closed: { type: "string" },
    /** Its version: each change applies only to the day as it was read. */
    v: { type: "integer" },
  },
  required: ["until"],
} as const;

export const rate = defineCollection({ durable: false, schema: rateSchema });

export type Rate = Infer<typeof rateSchema> & { _id: string };
