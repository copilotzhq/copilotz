/**
 * Forgets one of the person's computers: it can't connect again (its program
 * forgets it at its next try), every space it's in loses it, and what
 * agents waited on it for, and what they were let do there, go with it. Its files stay
 * where they are, on the machine.
 */
import { defineAction } from "../../../../runtime/mod.ts";

export const forgetAction = defineAction({
  description: "Forgets one of your computers",
  input: {
    type: "object",
    properties: { computer: { type: "string" } },
    required: ["computer"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const { deletedCount } = await ctx.db.collection("computer").deleteOne({ _id: input.computer });
    if (deletedCount) {
      // Its desks too, in every space it's in: the system's to remove.
      await ctx.as().db.collection("desk").deleteMany({ computer: input.computer });
      await ctx.as().db.collection("approval").deleteMany({ computer: input.computer });
      await ctx.as().db.collection("grant").deleteMany({ computer: input.computer });
    }
    return { forgotten: deletedCount > 0 };
  },
});
