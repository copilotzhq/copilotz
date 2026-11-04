/**
 * Calls to tools that change things, lately taken, by their id
 * (`mcp:<thread>:<request>:<what>`): the step each wrote, or is writing,
 * when it began, whether it's done, and what an error said. Written before
 * the tool runs, so it outlasts a restart:
 *
 * - a request sent again while it runs joins it (the owner does that);
 * - up to two minutes after its answer, it's answered from its step, and the
 *   tool doesn't run again;
 * - one cut short (an executor lost, a deploy) runs again as the same step,
 *   with `retry`, for 15 minutes;
 * - later, the same request is a new call (a client that numbers each call
 *   from 1 asks the same thing again for a reason).
 *
 * A read-only tool keeps none: it always runs, and answers what is true now.
 * No events; what's older than 15 minutes goes (`mcp.prune`).
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const receipt = defineCollection({
  schema: {
    type: "object",
    properties: {
      /** The step's id (its message), which the tool knows as its `trigger`. */
      step: { type: "string" },
      /** When it began (ms). */
      at: { type: "integer" },
      done: { type: "boolean" },
      /** What it answered when it failed (its step keeps the error itself). */
      said: { type: "string" },
    },
    required: ["step", "at"],
  },
  events: false,
  indexes: [["at"]],
});

/** How long after its answer a request sent again is answered from it, not run again. */
export const RESEND_MS = 120_000;
/** How long a call cut short runs again as itself; then its receipt goes. */
export const RERUN_MS = 900_000;
