/**
 * Cards: one real outcome each, on a board (`board`), in one of its columns
 * (`column`), at an `order` there (lowest first). A card lives in its
 * board's space (`in`), so the spaces plugin's rules keep it to those who
 * reach that space, as they do the board (`shared: { card: {} }`).
 */
import { defineCollection } from "copilotz";

export const card = defineCollection({
  schema: {
    type: "object",
    properties: {
      in: { type: "string" },
      board: { type: "string" },
      column: { type: "string" },
      order: { type: "number" },
      title: { type: "string" },
      description: { type: "string" },
      assignee: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      due: { type: "string" },
      by: { type: "string" },
      at: { type: "string" },
      updatedBy: { type: "string" },
      updated: { type: "string" },
    },
    required: ["in", "board", "column", "order", "title", "at"],
  },
  indexes: [["board", "column"], ["in"]],
});
