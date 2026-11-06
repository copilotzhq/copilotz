/**
 * `card.update`: changes a card, by an editor of its space (the rules say):
 * any of its title, description, assignee (someone in the space), labels and
 * due date; `null` clears one. Moving it is `card.move`.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { invalid, readOnly, said } from "../shared/errors.ts";
import {
  ASSIGNEE,
  DESCRIPTION,
  DUE,
  dueOf,
  keyOf,
  LABELS,
  labelsOf,
  TITLE,
} from "../shared/fields.ts";
import { cardOf, inSpace } from "../shared/load.ts";

const orNull = <S>(schema: S) => ({ anyOf: [schema, { type: "null" }] }) as const;

export const updateCardAction = defineAction({
  description: "Changes a card: its title, description, assignee, labels or due date (null clears)",
  input: {
    type: "object",
    properties: {
      card: { type: "string", minLength: 1 },
      title: TITLE,
      description: orNull(DESCRIPTION),
      assignee: orNull(ASSIGNEE),
      labels: orNull(LABELS),
      due: orNull(DUE),
    },
    required: ["card"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const found = await cardOf(ctx, input.card);
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw invalid("A card needs a title.");
      set.title = title;
    }
    const description = typeof input.description === "string"
      ? input.description.trim()
      : input.description;
    if (description) set.description = description;
    else if (description !== undefined) unset.description = "";
    if (input.assignee) {
      if (input.assignee !== found.assignee) await inSpace(ctx, found.in, input.assignee);
      set.assignee = input.assignee;
    } else if (input.assignee === null) unset.assignee = "";
    const labels = input.labels ? labelsOf(input.labels) : input.labels;
    if (labels?.length) set.labels = labels;
    else if (labels !== undefined) unset.labels = "";
    if (input.due) set.due = dueOf(input.due);
    else if (input.due === null) unset.due = "";
    set.updatedBy = keyOf(ctx.actor);
    set.updated = new Date().toISOString();
    const changed = await ctx.db.collection("card").updateOne(
      { _id: found._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    ).catch(said());
    if (!changed.matchedCount) throw readOnly();
    return { card: found._id, board: found.board };
  },
});
