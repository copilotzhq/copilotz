/**
 * What commands printed, per person: text, or an item to show through its
 * kind's View. The screen prints each once, in order. Only live: kept in
 * memory, the latest ones.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const output = defineCollection({
  durable: false,
  schema: {
    type: "object",
    properties: {
      person: { type: "string" },
      text: { type: "string" },
      kind: { type: "string" },
      item: {},
      hints: { type: "object" },
      at: { type: "string" },
    },
    required: ["person", "at"],
  },
});
