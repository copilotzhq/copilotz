/**
 * Summary nodes: a binary tree of lines over each thread's shared messages,
 * and one over each agent's steps there, which only that agent reads.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const summarySchema = {
  type: "object",
  properties: {
    thread: { type: "string" },
    /** A node at `level` covers 2^level messages, from `index` × 2^level on. */
    level: { type: "integer" },
    index: { type: "integer" },
    text: { type: "string" },
    bytes: { type: "integer" },
    /** Level 0: the message it summarizes. */
    message: { type: "string" },
    /** In an agent's tree of its steps: that agent, the only one it's shown to. */
    agent: { type: "string" },
    at: { type: "string" },
  },
  required: ["thread", "level", "index", "text", "bytes", "at"],
} as const;

export type Summary = Infer<typeof summarySchema> & { _id: string };

export const summary = defineCollection({
  schema: summarySchema,
  queries: {
    /** A thread's summary tree, level by level. */
    of: (summaries, params: { thread: string }) =>
      summaries.find({ thread: params.thread }).sort({ level: 1, index: 1 }),
  },
});
