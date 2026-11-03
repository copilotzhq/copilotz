/** Per thread: which lines are shown, and where whole messages start. */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const outlineSchema = {
  type: "object",
  properties: {
    /** Shared messages numbered so far: the next one's index (agents' steps aren't numbered). */
    count: { type: "integer" },
    /** The lines shown, oldest first: [level, index, bytes]. */
    lines: { type: "array" },
    bytes: { type: "integer" },
    /** The first message still whole, and when it was written. */
    boundary: { type: "integer" },
    since: { type: "string" },
    /** What each message still whole costs a prompt (estimated tokens), from the boundary on. */
    tail: { type: "array", items: { type: "integer" } },
    tailAt: { type: "array", items: { type: "string" } },
    /** And their ids: each is summarized as it leaves the tail. */
    tailIds: { type: "array", items: { type: "string" } },
    /** Which of them are agents' steps: they leave without a line. */
    tailSteps: { type: "array", items: { type: "boolean" } },
    /** The last message numbered, so a retried delivery knows it's done. */
    last: { type: "string" },
    /**
     * It has weighed every message of the thread from its first (made by this
     * compactor, not one that came later or from before steps counted): until
     * it first cuts, all of them can be sent.
     */
    complete: { type: "boolean" },
    /**
     * The newest message when its tail last cut: state on messages up to it
     * (thinking bound to the old start) is stale.
     */
    cutAt: { type: "string" },
  },
  required: ["count", "lines", "bytes", "boundary", "tail", "tailAt"],
} as const;

export type Outline = Infer<typeof outlineSchema> & { _id: string };

// Rewritten on every message, and nobody listens: no events.
export const outline = defineCollection({ schema: outlineSchema, events: false });
