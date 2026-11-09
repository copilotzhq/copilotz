/**
 * Boards: kanban boards in a space (`in`), each with its columns in order.
 * Shared through the spaces plugin (`shared: { board: {} }`), so everyone
 * there reads them and its editors change them; people change them with
 * `board.*`, agents with their tools.
 */
import { defineCollection } from "copilotz";

export const board = defineCollection({
  schema: {
    type: "object",
    properties: {
      in: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id", "name"],
        },
      },
      archived: { type: "string" },
      by: { type: "string" },
      at: { type: "string" },
      updatedBy: { type: "string" },
      updated: { type: "string" },
    },
    required: ["in", "name", "columns", "at"],
  },
  indexes: [["in"]],
});
