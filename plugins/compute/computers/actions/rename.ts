/** Names one of the person's computers, as every space it's in shows it. */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { mirror } from "../shared/desks.ts";

export const renameAction = defineAction({
  description: "Names one of your computers",
  input: {
    type: "object",
    properties: {
      computer: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 64 },
    },
    required: ["computer", "name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const { matchedCount } = await ctx.db.collection("computer").updateOne(
      { _id: input.computer },
      { $set: { name: input.name.trim() } },
    );
    if (matchedCount) await mirror(ctx, input.computer, { name: input.name.trim() });
    return { renamed: matchedCount > 0 };
  },
});
