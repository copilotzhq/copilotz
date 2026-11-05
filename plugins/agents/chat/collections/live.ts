/**
 * What agents are writing right now: one document per running turn, its
 * current step's answer so far and the tools it is calling. Kept in memory
 * only. It goes in the same commit that writes what it became (the step, or
 * the reply), so a View never shows both, or neither. A contact reads one
 * only while it shows nothing private: no tool call, no broken call's
 * reason, and words only when its turn offers no tools (`open`: every step
 * an answer); else, only that the agent is at work.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

const liveSchema = {
  type: "object",
  properties: {
    thread: { type: "string" },
    agent: { type: "string" },
    /** The turn writing it (its `_id` too). */
    turn: { type: "string" },
    /** The step's answer so far. */
    text: { type: "string" },
    /** The step's tool calls, each with what it returned once it has. */
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          input: { type: "object" },
          output: { type: "string" },
        },
        required: ["id", "name"],
      },
    },
    /**
     * The model's call broke and is tried again: its `attempt`, `at` when,
     * and why. What `text` and `calls` show is the broken attempt's, until
     * the new one writes.
     */
    retry: {
      type: "object",
      properties: {
        attempt: { type: "integer" },
        at: { type: "string" },
        reason: { type: "string" },
      },
      required: ["attempt", "at", "reason"],
    },
    /**
     * Its turn offers no tools, so every step is an answer: its words may
     * show to a contact as they're written. Without it, a step being written
     * may turn out private (its tools' calls, what it says before them): a
     * contact sees only that the agent is at work, never the words.
     */
    open: { type: "boolean" },
    /** Its thread's space (with the access plugin): who may read it is who may read the thread. */
    in: { type: "string" },
    at: { type: "string" },
  },
  required: ["thread", "agent", "turn", "text", "calls", "at"],
} as const;

export const live = defineCollection({ durable: false, schema: liveSchema });

export type LiveCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
};
export type Live = {
  _id: string;
  thread: string;
  agent: string;
  turn: string;
  text: string;
  calls: LiveCall[];
  retry?: { attempt: number; at: string; reason: string };
  open?: true;
  in?: string;
  at: string;
};
