/** Waits: an agent paused until every message it sent has a reply. */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const names = { type: "array", items: { type: "string" } } as const;

const waitSchema = {
  type: "object",
  properties: {
    agent: { type: "string" },
    thread: { type: "string" },
    /** What the agent's turn answers, so it can answer once resumed. */
    trigger: { type: "string" },
    hops: { type: "integer" },
    /** Messages still without a reply. Empty: the agent resumes. */
    waitingFor: names,
    received: names,
    at: { type: "string" },
  },
  required: ["agent", "thread", "trigger", "hops", "waitingFor", "received", "at"],
} as const;

export const wait = defineCollection({
  schema: waitSchema,
});

export type Wait = Infer<typeof waitSchema> & { _id: string };
