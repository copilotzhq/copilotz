/**
 * Usage rolled up by day: for each closed day, one document per group of
 * what totals group and filter by (meter, subject, the configured
 * dimensions), as the records hold them, with their sums. Derived from the
 * ledger, so closing a day again rewrites its rollups; nothing records them.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const rollupSchema = {
  type: "object",
  properties: {
    day: { type: "string" },
    meter: { type: "string" },
    subject: { type: "string" },
    catalog: { type: "string" },
    tags: { type: "object", additionalProperties: { type: "string" } },
    kind: { type: "string" },
    unpriced: { type: "array", items: { type: "string" } },
    quantities: { type: "object", additionalProperties: { type: "number" } },
    cost: { type: "number" },
    price: { type: "number" },
    costs: { type: "object", additionalProperties: { type: "number" } },
    prices: { type: "object", additionalProperties: { type: "number" } },
    saved: {
      type: "object",
      properties: { cost: { type: "number" }, price: { type: "number" } },
    },
    /** Who rated the price (`rated.price`), as the records say: none for those priced at cost before. */
    rated: { type: "object", properties: { price: { type: "string" } } },
    /** Records rolled up. */
    n: { type: "integer" },
  },
  required: ["day", "meter", "subject", "quantities", "n"],
} as const;

/**
 * Read by day, and day per meter, subject and the default dimensions. An app
 * that rolls up by others adds their indexes
 * (`collections: { usageRollup: { indexes: [["tags.tenant", "day"]] } }`).
 */
export const usageRollup = defineCollection({
  schema: rollupSchema,
  events: false,
  indexes: [["day"], ["meter", "day"], ["subject", "day"], ["tags.agent", "day"], [
    "tags.purpose",
    "day",
  ]],
});
