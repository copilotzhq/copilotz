/**
 * `card.move`: moves a card, by an editor of its space (the rules say): to a
 * column (its own, unless given) and a place there: just before or after
 * another card (whose column it then joins), or at the top or bottom (the
 * bottom, unless given). It takes the midpoint of its new neighbours'
 * orders; when there's no room left between them, the column is numbered
 * again. The board and the column are read in the same commit as the move.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Board, Card, Place } from "../contract.ts";
import { invalid, notFound, readOnly, said } from "../shared/errors.ts";
import { keyOf, POSITION } from "../shared/fields.ts";
import { byOrder, indexOf, orderAt } from "../shared/order.ts";

export const moveCardAction = defineAction({
  description: "Moves a card: to a column, before or after another card, or to its top or bottom",
  input: {
    type: "object",
    properties: {
      card: { type: "string", minLength: 1 },
      /** The column's id: the card's own, unless given (or another card's, with before or after). */
      column: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      at: POSITION,
    },
    required: ["card"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const places = [input.before, input.after, input.at].filter((p) => p !== undefined);
    if (places.length > 1) {
      throw invalid("Say one place: before a card, after one, or top or bottom.");
    }
    if (input.before === input.card || input.after === input.card) {
      throw invalid("A card can't go next to itself.");
    }
    const place: Place | undefined = input.before !== undefined
      ? { before: input.before }
      : input.after !== undefined
      ? { after: input.after }
      : input.at
      ? { at: input.at }
      : undefined;
    const by = keyOf(ctx.actor);
    const updated = new Date().toISOString();
    return await ctx.transaction(async (tx) => {
      const cards = tx.db.collection<Card>("card");
      const card = await cards.findOne({ _id: input.card });
      if (!card) throw notFound("No such card here: it may have been deleted.");
      const board = await tx.db.collection<Board>("board").findOne({ _id: card.board });
      if (!board) throw notFound("Its board was just deleted.");
      const neighbour = place && !("at" in place)
        ? await cards.findOne({ _id: "before" in place ? place.before : place.after })
        : undefined;
      if (neighbour === null || (neighbour && neighbour.board !== board._id)) {
        throw invalid("That card isn't on this board any more.");
      }
      const target = neighbour?.column ?? input.column ?? card.column;
      if (input.column && neighbour && input.column !== neighbour.column) {
        throw invalid("That card is in another column.");
      }
      const column = board.columns.find((c) => c.id === target);
      if (!column) throw invalid(`“${board.name}” has no column “${target}”.`);
      const others = byOrder(
        await cards.find({ in: board.in, board: board._id, column: column.id }),
      ).filter((c) => c._id !== card._id);
      const { order, renumbered } = orderAt(others, indexOf(others, place));
      const moved = await cards.updateOne(
        { _id: card._id },
        { $set: { column: column.id, order, updatedBy: by, updated } },
      );
      if (!moved.matchedCount) throw readOnly();
      for (const [id, fresh] of Object.entries(renumbered)) {
        await cards.updateOne({ _id: id }, { $set: { order: fresh } }, { writeConcern: { w: 0 } });
      }
      return {
        card: card._id,
        board: board._id,
        column: column.id,
        columnName: column.name,
        from: card.column,
        order,
      };
    }).catch(said());
  },
});
