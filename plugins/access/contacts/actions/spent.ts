/**
 * What a web line's visitors' model calls cost, against the line's budget
 * for the day (UTC), in memory (see shared/budget.ts). Its listener on the
 * models plugin's `modelUse` calls them (resources/spend.ts); nobody outside
 * may.
 *
 * - `contact.spent` `{ line, contact?, price }`: a call charged, the
 *   visitor's hold gone with it; `{ line, contact?, unpriced }`: use nothing
 *   priced (its model), which closes the line for the day (`closed`: this
 *   closed it).
 * - `contact.budget` `{ line }`: whether its visitors' turns may make
 *   another call today (`left`).
 */
import { defineAction, invalid } from "../../../../runtime/mod.ts";
import type { Rate } from "../collections/rate.ts";
import { charge, close, type Day, left } from "../shared/budget.ts";
import { lineOf } from "../shared/web.ts";

const LINE = { type: "string", minLength: 1, maxLength: 60 } as const;

export const spentAction = defineAction({
  description: "Charges a web line's visitor's model call against its budget, or closes the day",
  record: false,
  input: {
    type: "object",
    properties: {
      line: LINE,
      contact: { type: "string", maxLength: 100 },
      price: { type: "number", minimum: 0 },
      unpriced: { type: "string", maxLength: 200 },
    },
    required: ["line"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const rates = ctx.as().db.collection<Rate & Day>("contact_rate");
    if (input.unpriced !== undefined) {
      return { closed: await close(rates, input.line, input.unpriced) };
    }
    if (input.price === undefined) throw invalid("A price, or what was unpriced.");
    await charge(rates, input.line, input.contact, input.price);
    return {};
  },
});

export const budgetAction = defineAction({
  description: "Whether a web line's visitors may still spend today",
  record: false,
  input: {
    type: "object",
    properties: { line: LINE },
    required: ["line"],
    additionalProperties: false,
  },
  run: async (ctx, input): Promise<{ left: boolean }> => {
    const line = lineOf(ctx, input.line);
    if (!line?.budget) return { left: true };
    const rates = ctx.as().db.collection<Rate & Day>("contact_rate");
    return { left: await left(rates, { name: line.name, budget: line.budget }) };
  },
});
