/** A chat erased (`thread.deleted`): its summaries go with it, and what was shown of them. */
import type { ProcessorDef } from "../../../../runtime/mod.ts";

export const eraser: ProcessorDef = {
  on: "thread.deleted",
  key: (event) => String(event.data._id),
  run: async (ctx, event) => {
    const thread = String(event.data._id);
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("summary").deleteMany({ thread });
      await tx.db.collection("outline").deleteMany({ _id: thread });
    });
  },
};
