/**
 * `board.update`: changes a board, by an editor of its space (the rules
 * say): its name, its description (`null` clears it), whether it's
 * archived, and its columns: the whole list in its new order, each with the
 * id it has (renamed, moved) or none (new). A column left out is removed
 * when it's empty; one with cards only when `into` says which kept column
 * they go to (at its bottom, in their order). All in one commit.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Card } from "../contract.ts";
import { changeColumns, MOST_COLUMNS } from "../shared/columns.ts";
import { invalid, readOnly, said } from "../shared/errors.ts";
import { COLUMN_NAME, DESCRIPTION, keyOf, NAME } from "../shared/fields.ts";
import { boardOf } from "../shared/load.ts";
import { byOrder, STEP } from "../shared/order.ts";

export const updateBoardAction = defineAction({
  description: "Changes a board: its name, description, columns, or whether it's archived",
  input: {
    type: "object",
    properties: {
      board: { type: "string", minLength: 1 },
      name: NAME,
      description: { anyOf: [DESCRIPTION, { type: "null" }] },
      archived: { type: "boolean" },
      columns: {
        type: "array",
        minItems: 1,
        maxItems: MOST_COLUMNS,
        items: {
          type: "object",
          properties: { id: { type: "string" }, name: COLUMN_NAME },
          required: ["name"],
          additionalProperties: false,
        },
      },
      /** Where a removed column's cards go: a column the board keeps. */
      into: { type: "string" },
    },
    required: ["board"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const found = await boardOf(ctx, input.board);
    const name = input.name?.trim();
    if (input.name !== undefined && !name) throw invalid("A board needs a name.");
    const description = typeof input.description === "string"
      ? input.description.trim()
      : input.description;
    const change = input.columns ? changeColumns(found.columns, input.columns) : undefined;
    const set: Record<string, unknown> = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(change ? { columns: change.columns } : {}),
      ...(input.archived ? { archived: found.archived ?? new Date().toISOString() } : {}),
      updatedBy: keyOf(ctx.actor),
      updated: new Date().toISOString(),
    };
    const unset = {
      ...(description === null || description === "" ? { description: "" } : {}),
      ...(input.archived === false ? { archived: "" } : {}),
    };
    const update = { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) };
    const removed = change?.removed.map((c) => c.id) ?? [];
    const into = input.into ? change?.columns.find((c) => c.id === input.into) : undefined;
    if (input.into && !into) {
      throw invalid("Cards can only go to a column the board keeps.");
    }
    const moved = await ctx.transaction(async (tx) => {
      const changed = await tx.db.collection("board").updateOne({ _id: found._id }, update);
      if (!changed.matchedCount) throw readOnly();
      // The removed columns' cards, read in the commit that removes them, so none is left behind.
      const stranded = removed.length
        ? byOrder(
          await tx.db.collection<Card>("card").find({
            in: found.in,
            board: found._id,
            column: { $in: removed },
          }),
        )
        : [];
      if (stranded.length && !into) {
        const full = change!.removed.filter((c) => stranded.some((s) => s.column === c.id));
        const one = full.length === 1;
        throw Object.assign(
          new Error(
            `${full.map((c) => `“${c.name}”`).join(", ")} still ${one ? "has" : "have"} ` +
              `${stranded.length === 1 ? "a card" : "cards"}: move ${
                stranded.length === 1 ? "it" : "them"
              } first, or say which column ${stranded.length === 1 ? "it goes" : "they go"} to.`,
          ),
          { code: "not_empty", cards: stranded.length },
        );
      }
      if (!stranded.length || !into) return 0;
      // At the bottom of where they go, in the order they had, column by column.
      const last = await tx.db.collection<Card>("card").find(
        { in: found.in, board: found._id, column: into.id },
        { sort: { order: -1 }, limit: 1 },
      );
      let order = (last[0]?.order ?? 0) + STEP;
      const cards = tx.db.collection("card");
      for (const column of change!.removed) {
        for (const card of stranded.filter((c) => c.column === column.id)) {
          await cards.updateOne(
            { _id: card._id },
            {
              $set: { column: into.id, order, updatedBy: keyOf(ctx.actor), updated: set.updated },
            },
            { writeConcern: { w: 0 } },
          );
          order += STEP;
        }
      }
      return stranded.length;
    }).catch(said());
    return {
      board: found._id,
      name: name ?? found.name,
      columns: change?.columns ?? found.columns,
      ...(moved ? { moved } : {}),
    };
  },
});
