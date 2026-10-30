/** Makes a computer the one a space's agents use, when it has several: its owner's call, or its managers'. */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { may } from "../shared/desks.ts";

export const defaultAction = defineAction({
  description: "Makes a computer the one a space's agents use",
  input: {
    type: "object",
    properties: { desk: { type: "string" } },
    required: ["desk"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) throw Object.assign(new Error("No such computer here"), { code: "invalid" });
    if (desk.owner !== ctx.actor!.id && !await may(ctx, desk.in, "manage")) {
      throw Object.assign(new Error("Only its owner, or those who manage this space, can."), {
        code: "forbidden",
      });
    }
    const desks = ctx.as().db.collection("desk");
    await desks.updateMany({ in: desk.in, default: true }, { $unset: { default: "" } });
    await desks.updateOne({ _id: desk._id }, { $set: { default: true } });
    return { default: desk._id };
  },
});
