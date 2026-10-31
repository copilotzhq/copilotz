/** Per thread: which lines are shown, and where whole messages start. */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const outlineSchema = {
  type: "object",
  properties: {
    /** Shared messages numbered so far: the next one's index. */
    count: { type: "integer" },
    /** The lines shown, oldest first: [level, index, bytes]. */
    lines: { type: "array" },
    bytes: { type: "integer" },
    /** The first message still whole, and when it was written. */
    boundary: { type: "integer" },
    since: { type: "string" },
    /** The whole messages' sizes, from the boundary on. */
    tail: { type: "array", items: { type: "integer" } },
    tailAt: { type: "array", items: { type: "string" } },
    /** And their ids: each is summarized as it leaves the tail. */
    tailIds: { type: "array", items: { type: "string" } },
    /** The last message numbered, so a retried delivery knows it's done. */
    last: { type: "string" },
  },
  required: ["count", "lines", "bytes", "boundary", "tail", "tailAt"],
} as const;

export type Outline = Infer<typeof outlineSchema> & { _id: string };

export const outline = defineCollection({ schema: outlineSchema });
