/**
 * What an org and its spaces chose for the app's agents' models: the org's
 * (`_id: "org"`) and each space's (`space:<id>`), each a tier by its name and
 * models picked for some agents. Never a copy of a tier's lists: retuning a
 * tier moves everyone on it. Changed only through `tiers.choose` and
 * `tiers.pick`, which say who may; read by `_id`, so a turn's asking costs
 * what the owner has cached.
 *
 * Queries, for front ends, as the person looking:
 * - `offered` `{ space? }`: the tiers on offer with each agent's model and a
 *   typical reply's price at this org's prices, what the org chose and the
 *   plan gives, and with `space`, what the space chose; then what applies
 *   there, each agent's model and where it comes from. Anyone in the org reads
 *   the org's; a space's, those who reach it.
 * - `agent` `{ agent, space }`: one of the app's agents in a space, its model
 *   and where it comes from, and when it's picked for the space, where taking
 *   the pick back leaves it (`without`); null for an agent that isn't the app's.
 */
import { defineCollection, forbidden, people } from "../../../../runtime/mod.ts";
import type { ModelRef } from "../../../models/contract.ts";
import { agentAt, shownAt } from "../shared/shown.ts";

const choiceSchema = {
  type: "object",
  properties: {
    /** The space it's for; none: the org's. */
    space: { type: "string" },
    /** A tier by its name; none: the one above (the org's, then the plan's). */
    tier: { type: "string" },
    /** Models picked for some of the app's agents, by name, as an agent's `model` takes one. */
    custom: { type: "object" },
    at: { type: "string" },
  },
  required: ["at"],
} as const;

export type ModelChoice = {
  _id: string;
  space?: string;
  tier?: string;
  custom?: Record<string, ModelRef>;
  at: string;
};

/** Only someone who reaches the space reads what it chose: the rules say whether they do. */
async function reached(
  ctx: Parameters<typeof shownAt>[0],
  space: string,
): Promise<void> {
  const found = await ctx.db.collection("space").findOne({ _id: space });
  if (!found) throw forbidden("You can't read that space.");
}

export const modelChoice = defineCollection({
  schema: choiceSchema,
  queries: {
    offered: {
      allow: people,
      run: async (_, params: { space?: string }, ctx) => {
        if (params.space) await reached(ctx, params.space);
        return await shownAt(ctx, params.space);
      },
    },
    agent: {
      allow: people,
      run: async (_, params: { agent: string; space: string }, ctx) => {
        await reached(ctx, params.space);
        return await agentAt(ctx, params.agent, params.space);
      },
    },
  },
});
