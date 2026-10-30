/**
 * `usage.quote` `{ meter, subject, quantities, catalog? }`: what a use would
 * be charged, rated by the books in force now, as a recorded use would be
 * (`rate`), without recording anything: for showing prices before use (a
 * cloud computer's size an hour). Answers `{ price }` (null when nothing
 * prices it), and what it would cost (`cost`) only to platform staff and the
 * system, who see costs. Only reads, so it isn't recorded, and queries and
 * Views may ask it.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { nonzero, rate } from "../shared/rate.ts";

export const quoteAction = defineAction({
  description: "What a use would be charged now (its price), without recording it",
  record: false,
  input: {
    type: "object",
    properties: {
      meter: { type: "string" },
      subject: { type: "string" },
      catalog: { type: "string" },
      quantities: { type: "object", additionalProperties: { type: "number" } },
    },
    required: ["meter", "subject", "quantities"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const rated = await rate(ctx, {
      meter: input.meter,
      subject: input.subject,
      ...(input.catalog ? { catalog: input.catalog } : {}),
      quantities: nonzero(input.quantities as Record<string, number>),
      at: new Date().toISOString(),
    });
    // Costs (and so margins) are for platform staff and the system, as `org.me` marks staff.
    const costs = !ctx.actor || ctx.actor.staff === true;
    return {
      price: rated.price ?? null,
      ...(costs ? { cost: rated.cost ?? null } : {}),
    };
  },
});
