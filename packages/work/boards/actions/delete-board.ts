/**
 * `board.delete`: removes a board and every card on it, by an editor of its
 * space (the rules say), in one commit. Conversations that mention it keep
 * what they said.
 */
import { defineAction, people } from "copilotz";
import { readOnly, said } from "../shared/errors.ts";
import { boardOf } from "../shared/load.ts";

export const deleteBoardAction = defineAction({
  description: "Deletes a board, with its cards",
  input: {
    type: "object",
    properties: { board: { type: "string", minLength: 1 } },
    required: ["board"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const found = await boardOf(ctx, input.board);
    await ctx.transaction(async (tx) => {
      await tx.db.collection("card").deleteMany({ in: found.in, board: found._id }, {
        writeConcern: { w: 0 },
      });
      const gone = await tx.db.collection("board").deleteOne({ _id: found._id });
      if (!gone.deletedCount) throw readOnly();
    }).catch(said());
    return { deleted: found._id, name: found.name };
  },
});
