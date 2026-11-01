/**
 * `routine.resume`, by its maker or a manager of its space: its timer is
 * set again, as its maker, from now; a once whose time has passed needs a
 * new one first.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { arm, byId, editable, invalid, timing } from "../shared/routines.ts";

export const resumeAction = defineAction({
  description: "Resumes a paused routine: it runs on its schedule again, from now",
  input: byId,
  allow: people,
  run: async (ctx, { routine }) => {
    const found = await editable(ctx, routine);
    if (!found.paused) return { routine, ...(found.next ? { next: found.next } : {}) };
    const when = timing(found.schedule);
    if (!when.next) throw invalid("Its time has passed: give it a new one to resume it.");
    await ctx.db.collection("routine").updateOne({ _id: routine }, {
      $set: when,
      $unset: { paused: "" },
    });
    await arm(ctx, found);
    return { routine, ...when };
  },
});
