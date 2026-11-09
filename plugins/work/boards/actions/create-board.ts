/**
 * `board.create`: a board in a space, by someone who may write there (the
 * rules say), with the team's usual columns (Backlog, To do, Doing,
 * Blocked, In review, Done) unless it's given its own.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { columnsNamed, DEFAULT_COLUMNS, MOST_COLUMNS } from "../shared/columns.ts";
import { invalid, said } from "../shared/errors.ts";
import { COLUMN_NAME, DESCRIPTION, keyOf, NAME, newId } from "../shared/fields.ts";

export const createBoardAction = defineAction({
  description: "Makes a board in a space, with the usual columns unless given its own",
  input: {
    type: "object",
    properties: {
      in: { type: "string", minLength: 1 },
      name: NAME,
      description: DESCRIPTION,
      /** Its columns' names, left to right. */
      columns: { type: "array", minItems: 1, maxItems: MOST_COLUMNS, items: COLUMN_NAME },
    },
    required: ["in", "name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const name = input.name.trim();
    if (!name) throw invalid("A board needs a name.");
    const names = input.columns?.map((c) => c.trim()).filter(Boolean);
    if (names && new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
      throw invalid("Each column needs a name of its own.");
    }
    const columns = names?.length ? columnsNamed(names) : DEFAULT_COLUMNS.map((c) => ({ ...c }));
    const board = newId();
    const description = input.description?.trim();
    await ctx.db.collection("board").insertOne({
      _id: board,
      in: input.in,
      name,
      ...(description ? { description } : {}),
      columns,
      by: keyOf(ctx.actor),
      at: new Date().toISOString(),
    }).catch(said("Only editors of a space add boards to it."));
    return { board, name, columns };
  },
});
