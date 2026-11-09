/**
 * `card.delete`: removes a card from its board, by an editor of its space
 * (the rules say).
 */
import { defineAction, people } from "copilotz";
import { readOnly, said } from "../shared/errors.ts";
import { cardOf } from "../shared/load.ts";

export const deleteCardAction = defineAction({
  description: "Deletes a card",
  input: {
    type: "object",
    properties: { card: { type: "string", minLength: 1 } },
    required: ["card"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const found = await cardOf(ctx, input.card);
    const gone = await ctx.db.collection("card").deleteOne({ _id: found._id }).catch(said());
    if (!gone.deletedCount) throw readOnly();
    return { deleted: found._id, board: found.board, title: found.title };
  },
});
