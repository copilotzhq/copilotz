/**
 * `card.create`: a card on a board, by an editor of its space (the rules
 * say): its title, and maybe its column (the first, unless given), where in
 * it (the bottom, unless `at: "top"`), its description, assignee (someone in
 * the space), labels and due date. The board is read in the same commit, so
 * the card never lands in a column that was just removed.
 */
import { defineAction, people } from "copilotz";
import type { Board, Card } from "../contract.ts";
import { invalid, notFound, said } from "../shared/errors.ts";
import {
  ASSIGNEE,
  DESCRIPTION,
  DUE,
  dueOf,
  keyOf,
  LABELS,
  labelsOf,
  newId,
  POSITION,
  TITLE,
} from "../shared/fields.ts";
import { boardOf, inSpace } from "../shared/load.ts";
import { STEP } from "../shared/order.ts";

export const createCardAction = defineAction({
  description: "Adds a card to a board: a title, and maybe its column, description, assignee, " +
    "labels and due date",
  input: {
    type: "object",
    properties: {
      board: { type: "string", minLength: 1 },
      title: TITLE,
      /** Its column's id: the board's first column, unless given. */
      column: { type: "string" },
      at: POSITION,
      description: DESCRIPTION,
      assignee: ASSIGNEE,
      labels: LABELS,
      due: DUE,
    },
    required: ["board", "title"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const title = input.title.trim();
    if (!title) throw invalid("A card needs a title.");
    const known = await boardOf(ctx, input.board);
    if (input.assignee) await inSpace(ctx, known.in, input.assignee);
    const due = input.due ? dueOf(input.due) : undefined;
    const labels = input.labels ? labelsOf(input.labels) : [];
    const description = input.description?.trim();
    const card = newId();
    const at = new Date().toISOString();
    const placed = await ctx.transaction(async (tx) => {
      const board = await tx.db.collection<Board>("board").findOne({ _id: known._id });
      if (!board) throw notFound("That board was just deleted.");
      const column = input.column
        ? board.columns.find((c) => c.id === input.column)
        : board.columns[0];
      if (!column) {
        throw invalid(`“${board.name}” has no column “${input.column}”.`);
      }
      const top = input.at === "top";
      const [end] = await tx.db.collection<Card>("card").find(
        { in: board.in, board: board._id, column: column.id },
        { sort: { order: top ? 1 : -1 }, limit: 1 },
      );
      const order = end ? end.order + (top ? -STEP : STEP) : STEP;
      await tx.db.collection("card").insertOne({
        _id: card,
        in: board.in,
        board: board._id,
        column: column.id,
        order,
        title,
        ...(description ? { description } : {}),
        ...(input.assignee ? { assignee: input.assignee } : {}),
        ...(labels.length ? { labels } : {}),
        ...(due ? { due } : {}),
        by: keyOf(ctx.actor),
        at,
      });
      return { column, order, board };
    }).catch(said());
    return {
      card,
      board: placed.board._id,
      column: placed.column.id,
      columnName: placed.column.name,
      order: placed.order,
      title,
    };
  },
});
