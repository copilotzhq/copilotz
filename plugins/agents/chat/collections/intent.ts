/**
 * A turn's step before it commits: the tool calls its model asked for,
 * written before any of them runs, and what each returned as soon as it did.
 * A retried turn finds it and goes on with these same calls instead of asking
 * the model again: a call that returned isn't run again, one cut short runs
 * again as itself (the same `callId`). It goes in the commit that writes the
 * step; a turn that ends without that (failed for good, or stopped) keeps it
 * as its step, saying which calls never returned. One per running turn, by
 * the turn's id; trusted code's only, and no events.
 */
import { defineCollection } from "../../../../runtime/mod.ts";
import type { LlmState, ToolCall } from "../../../models/contract.ts";
import type { Told } from "../shared/types.ts";

const intentSchema = {
  type: "object",
  properties: {
    thread: { type: "string" },
    agent: { type: "string" },
    /** Its place in the turn: the step's message is `<turn>:<step>`. */
    step: { type: "integer" },
    /** What the model wrote with its calls. */
    text: { type: "string" },
    /** Its model's state, sent back with the step. */
    state: { type: "object" },
    /** What the turn was told, when the step is its first message. */
    told: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, text: { type: "string" } },
        required: ["name", "text"],
      },
    },
    /** The calls, in the model's order. */
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, input: { type: "object" } },
        required: ["id", "name"],
      },
    },
    /** What each call returned, by its place in `calls`. */
    outputs: { type: "object", additionalProperties: { type: "string" } },
    /** The question a call asked as it ran (`ToolContext.ask`), by its place in `calls`. */
    asks: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { to: { type: "string" }, text: { type: "string" } },
        required: ["to", "text"],
      },
    },
    /**
     * Calls run again once their questions were answered, by place in `calls`:
     * the call's own id (it runs as itself) and the question it asked.
     */
    again: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { call: { type: "string" }, question: { type: "string" } },
        required: ["call", "question"],
      },
    },
    at: { type: "string" },
  },
  required: ["thread", "agent", "step", "calls", "outputs", "at"],
} as const;

export const intent = defineCollection({ schema: intentSchema, events: false });

/** An intent, as it is written: its `_id` is its turn's. */
export type Intent = {
  thread: string;
  agent: string;
  step: number;
  text?: string;
  state?: LlmState;
  told?: Told[];
  calls: ToolCall[];
  outputs: Record<string, string>;
  asks?: Record<string, Question>;
  again?: Record<string, { call: string; question: string }>;
  at: string;
};

/** What a tool asks someone, its call waiting for their answer (`ToolContext.ask`). */
export type Question = { to: string; text: string };

/** What a call that never returned says, in the step a turn keeps when it ends without it. */
export const CUT_SHORT = "Interrupted before it returned: it may or may not have taken effect. " +
  "Check before calling it again.";

/** What a message that was never sent says there. */
export const NOT_SENT = "Not sent: the turn ended before it was.";
