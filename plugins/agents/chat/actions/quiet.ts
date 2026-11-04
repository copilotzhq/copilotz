/**
 * `chat.quiet`: a turn that waited for its sender to be quiet (a customer
 * writing several short messages in a row: `chat.send`'s `quiet`) starts
 * now, for the latest of them; the agent reads them all, and answers once.
 * Called by the timer each message set again in its place, as whoever sent
 * it; by nobody else. A message that's gone by then (its chat erased) starts
 * nothing.
 */
import { defineAction } from "../../../../runtime/mod.ts";

export const quietAction = defineAction({
  description: "Starts a turn that waited for its chat to be quiet",
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      agent: { type: "string" },
      trigger: { type: "string" },
      hops: { type: "integer" },
    },
    required: ["thread", "agent", "trigger", "hops"],
    additionalProperties: false,
  },
  run: async (ctx, turn) => {
    // Its message, as whoever sent it reads it: gone (its chat erased, they're out of it), no turn.
    if (!await ctx.db.collection("message").findOne({ _id: turn.trigger })) return;
    await ctx.transaction((tx) => {
      // The same id it would have had at once: one turn per message, however often called.
      tx.emit("turn.requested", turn, { id: `${turn.trigger}:${turn.agent}` });
      return Promise.resolve();
    });
  },
});
