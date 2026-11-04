/**
 * Calls lately taken, by their id (`mcp:<thread>:<request id>:<what>`):
 * the step each wrote, or is writing, when, and what an error said. A
 * request sent again (a client that lost the answer) is answered from here:
 * while it runs, the owner joins it to the running call; up to two minutes
 * after its answer, from its step, without running the tool again; one cut
 * short runs again as the same step (its tool's `callId`, with `retry`).
 * Later, the same request is a new call: a client that numbers each call
 * from 1 asks the same thing again for a reason. Kept in memory: gone on
 * restart, when it matters least.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const call = defineCollection({
  durable: false,
  schema: {
    type: "object",
    properties: {
      /** The step's id (its message), which its tool knows as its `callId`. */
      step: { type: "string" },
      /** When it began, then when it was answered (ms). */
      at: { type: "integer" },
      done: { type: "boolean" },
      /** What it answered when it failed (a step keeps the error itself). */
      said: { type: "string" },
    },
    required: ["step", "at"],
  },
});

/** How long after its answer a request sent again is answered from it, not run again. */
export const RESEND_MS = 120_000;
