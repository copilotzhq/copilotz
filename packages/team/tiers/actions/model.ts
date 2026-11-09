/**
 * `tiers.model` `{ agent, space? }`: the model one of the app's agents thinks
 * with in a space (chat's `agentModel` resource names it): what's picked for it
 * there, the space's tier, the org's pick, the org's tier, the plan's tier
 * (see shared/tiers.ts), or null, its own. Asked on every run of a turn, so it
 * only reads by `_id`, which the owner keeps cached: the space's choice and
 * the org's, and the plan's tier (credits' `billing.tier`, a read by `_id` too).
 * A pick gets the `maxTokens` of the entry it replaces, and its `effort` when
 * the picked model takes it (`models.efforts`, the catalog's: nothing read).
 */
import { defineAction } from "copilotz";
import { carried, type Choice, ORG_CHOICE, resolve, spaceChoice } from "../shared/tiers.ts";
import { agentsOf } from "copilotz/plugins/agents/contract";

export const modelAction = defineAction({
  description: "The model one of the app's agents thinks with in a space",
  record: false,
  input: {
    type: "object",
    properties: { agent: { type: "string" }, space: { type: "string" } },
    required: ["agent"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    // Agents people make keep their own model, and cost nothing to ask about.
    if (!agentsOf(ctx)[input.agent]) return null;
    const choices = ctx.as().db.collection<Choice>("modelChoice");
    const source = ctx.resources.planTier as { action?: string } | undefined;
    const [space, org, plan] = await Promise.all([
      input.space ? choices.findOne({ _id: spaceChoice(input.space) }) : null,
      choices.findOne({ _id: ORG_CHOICE }),
      source?.action ? ctx.as().call<string | null>(source.action, {}) : null,
    ]);
    return await carried(ctx, resolve(ctx, input.agent, { space, org, plan }));
  },
});
