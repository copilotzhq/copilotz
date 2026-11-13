/**
 * `models.price`: what the catalog says a model costs (per million tokens,
 * with tiers), and which catalog said it. The usage ledger rates a model's
 * use with it when the app has no rate of its own.
 */
import { defineAction } from "../../../runtime/mod.ts";
import { catalog, loadCatalog, lookup } from "../shared/choice.ts";

export const price = defineAction({
  description: "A model's price in the catalog, by its catalog id",
  record: false,
  input: {
    type: "object",
    properties: { catalog: { type: "string" } },
    required: ["catalog"],
    additionalProperties: false,
  },
  run: async (_ctx, input) => {
    await loadCatalog();
    const cost = lookup(input.catalog)?.cost;
    // Where catalog prices come from, and when it was fetched.
    return { ...(cost ? { cost } : {}), source: `models.dev ${catalog.fetched}` };
  },
});
