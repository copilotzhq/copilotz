/**
 * `routine.fire`: what time calls, as the routine's maker (whoever set its
 * timer: always its maker), once per occurrence. Nobody calls it from
 * outside. A routine gone or paused since (its timer outlived it) does
 * nothing, and its timer goes.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Routine } from "../collections/routine.ts";
import { fire } from "../shared/fire.ts";
import { byId, timerOf } from "../shared/routines.ts";

export const fireAction = defineAction({
  description: "Runs a routine when its time comes (time calls it)",
  input: byId,
  run: async (ctx, { routine }) => {
    // Its maker may no longer see it (they left): it's read as the system, and says so when it runs.
    const found = await ctx.as().db.collection<Routine>("routine").findOne({ _id: routine });
    if (!found || found.paused) {
      await ctx.as().unschedule(timerOf(routine));
      return { skipped: found ? "paused" : "gone" };
    }
    const due = ctx.scheduled?.at;
    return await fire(ctx, found, {
      id: due ? `${routine}@${due}` : `${routine}@${crypto.randomUUID()}`,
      ...(due ? { due } : {}),
    });
  },
});
