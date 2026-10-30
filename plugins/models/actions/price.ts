/**
 * `models.price`: what the catalog says a model costs (per million tokens,
 * with tiers), and which catalog said it. The usage ledger rates a model's
 * use with it when the app has no rate of its own.
 */
import { defineAction } from "../../../runtime/mod.ts";
import { catalog, lookup } from "../shared/choice.ts";

/** Where catalog prices come from, and when it was fetched. */
export const CATALOG = `models.dev ${catalog.fetched}`;

export const price = defineAction({
  description: "A model's price in the catalog, by its catalog id",
  record: false,
  input: {
    type: "object",
    properties: { catalog: { type: "string" } },
    required: ["catalog"],
    additionalProperties: false,
  },
  run: (_ctx, input) => {
    const cost = lookup(input.catalog)?.cost;
    return { ...(cost ? { cost } : {}), source: CATALOG };
  },
});
