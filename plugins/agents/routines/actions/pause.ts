/**
 * `routine.pause`, by its maker or a manager of its space: its timer goes,
 * and it doesn't run until it's resumed (`routine.resume`).
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { byId, disarm, editable } from "../shared/routines.ts";

export const pauseAction = defineAction({
  description: "Pauses a routine: it doesn't run until it's resumed",
  input: byId,
  allow: people,
  run: async (ctx, { routine }) => {
    const found = await editable(ctx, routine);
    if (found.paused) return { routine, paused: found.paused };
    const paused = new Date().toISOString();
    await ctx.db.collection("routine").updateOne({ _id: routine }, {
      $set: { paused },
      $unset: { next: "" },
    });
    await disarm(ctx, routine);
    return { routine, paused };
  },
});
