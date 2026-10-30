/**
 * `routine.delete`, by its maker or a manager of its space: its timer goes,
 * and it with its runs. The chats it posted in stay, as they are.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { byId, editable, timerOf } from "../shared/routines.ts";

export const deleteAction = defineAction({
  description: "Deletes a routine; the chats it posted in stay",
  input: byId,
  allow: (actor) => actor.kind === "person",
  run: async (ctx, { routine }) => {
    const found = await editable(ctx, routine);
    await ctx.transaction(async (tx) => {
      await tx.db.collection("routine").deleteOne({ _id: routine });
      await tx.db.collection("routineRun").deleteMany({ routine });
      tx.unschedule(timerOf(routine));
    });
    return { deleted: routine, name: found.name };
  },
});
