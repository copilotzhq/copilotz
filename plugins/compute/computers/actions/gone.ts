/** A computer went: offline, as of now, at every desk it has. */
import { defineAction } from "../../../../runtime/mod.ts";
import { mirror } from "../shared/desks.ts";

export const goneAction = defineAction({
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: async (ctx, input) => {
    const now = { online: false, seen: new Date().toISOString() };
    await ctx.db.collection("computer").updateOne({ _id: input.id }, { $set: now });
    await mirror(ctx, input.id, now);
    return null;
  },
});
