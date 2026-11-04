/**
 * Calls to tools that change things, lately taken, by what each asks in its
 * conversation (`mcp:<thread>:<what>`, a hash of the tool and its input),
 * whatever the request's id: the step each wrote, or is writing, when it
 * began, whether it's done, and what it answered. Written before the tool
 * runs, so it outlasts a stop and a restart:
 *
 * - the same call while it runs, in this process, waits for that run (the
 *   route does that);
 * - asked again, under any request id, up to two minutes after it ended,
 *   it's answered what it said (kept, up to 8,000 characters; a longer
 *   answer is shown again from its step), beginning with a line saying it
 *   wasn't done again, and the tool doesn't run again; a public refusal
 *   ("That date is in the past.") is such an answer too;
 * - begun and never done (stopped past the line's `stop`, an owner that
 *   restarted mid-call, a failure by accident, told "try again"), asked
 *   again within 15 minutes, it runs again as the same step, its tool told
 *   it's a retry, with the same `callId`: the key for what it does outside;
 * - later, it's a new call.
 *
 * A read-only tool keeps none: it always runs, and answers what is true now.
 * No events; what's older than 15 minutes goes (`mcp.prune`).
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const receipt = defineCollection({
  schema: {
    type: "object",
    properties: {
      /** The step's id (its message), which its tool knows as its `callId` and `trigger`. */
      step: { type: "string" },
      /** When it began, then when it ended (ms). */
      at: { type: "integer" },
      done: { type: "boolean" },
      /** What it answered, when it's short enough to keep, and whether that was a failure. */
      text: { type: "string" },
      failed: { type: "boolean" },
    },
    required: ["step", "at"],
  },
  events: false,
  indexes: [["at"]],
});

/** How long after its answer the same call asked again is answered from it, not run again. */
export const RESEND_MS = 120_000;
/** How long a call begun and never done runs again as itself; then its receipt goes. */
export const RERUN_MS = 900_000;
