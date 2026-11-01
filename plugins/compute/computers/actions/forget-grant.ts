/** `computer.forgetGrant`: takes back a yes the person gave: the rules reach only their own. */
import { defineAction, inPerson } from "../../../../runtime/mod.ts";

export const forgetGrantAction = defineAction({
  description: "Takes back what you let an agent do without asking",
  input: {
    type: "object",
    properties: { grant: { type: "string", minLength: 1 } },
    required: ["grant"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const gone = await ctx.db.collection("grant").deleteOne({ _id: input.grant });
    return { forgotten: gone.deletedCount > 0 };
  },
});
