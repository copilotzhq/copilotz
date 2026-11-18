/**
 * `tiers.model` `{ agent, space?, thread? }`: the model chain an agent thinks
 * with in a conversation (chat's `agentModel` resource names it, with the
 * kind the agent works `like`, else its name): the tier in force there (the
 * conversation's, the person's own default, the space's, the org's, the
 * plan's), as the org keeps it, and that kind's chain in it; null where no
 * tier applies (an app without tiers: the agent's own). An agent of no kind
 * the tiers know works as the app's first. Asked on every run of a turn, so
 * it only reads by `_id` and the org's few templates, which the owner keeps
 * cached.
 */
import { defineAction, personOf } from "copilotz";
import { levelsOf, orgTiersOf } from "../shared/shown.ts";
import { entryOf, kindOf, tierIn } from "../shared/tiers.ts";

export const modelAction = defineAction({
  description: "The model chain an agent thinks with in a conversation",
  record: false,
  input: {
    type: "object",
    properties: {
      agent: { type: "string" },
      space: { type: "string" },
      thread: { type: "string" },
    },
    required: ["agent"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    if (!Object.keys(ctx.resources.tiers ?? {}).length) return null;
    const person = personOf(ctx.actor);
    const system = ctx.as();
    const [{ tiers, kinds }, levels] = await Promise.all([
      orgTiersOf(system),
      levelsOf(system, {
        ...(input.space ? { space: input.space } : {}),
        ...(input.thread ? { thread: input.thread } : {}),
        ...(person ? { person } : {}),
      }),
    ]);
    const inForce = tierIn(tiers, levels);
    const kind = kindOf(ctx, input.agent, undefined, kinds);
    return entryOf(inForce ? tiers[inForce.tier] : undefined, kind, kinds) ?? null;
  },
});
