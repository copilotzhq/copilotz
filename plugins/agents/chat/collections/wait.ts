/** Waits: an agent paused until every message it sent, and every question its tools asked, has a reply. */
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
    /** Messages still without a reply (its own and its tools' questions). Empty: the agent resumes. */
    waitingFor: names,
    received: names,
    /** The step that asked questions: its asked calls run again once they're answered. */
    step: { type: "string" },
    at: { type: "string" },
  },
  required: ["agent", "thread", "trigger", "hops", "waitingFor", "received", "at"],
} as const;

export const wait = defineCollection({
  schema: waitSchema,
});

export type Wait = Infer<typeof waitSchema> & { _id: string };
