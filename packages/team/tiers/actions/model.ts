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
 *
 * Where the app has plans (providers with `harness`), the chain goes with
 * the plans its person has connected now, in their order, and the models
 * those that said so run: `{ model: chain, harnesses, served? }` (none for a
 * turn that's nobody's), and the models plugin runs each model on them first
 * (see shared/plans.ts). Asking which they have is one read per plugin that
 * keeps plans, beside the rest.
 */
import { defineAction, personOf } from "copilotz";
import { connectedOf, harnessesOf, plansOf } from "../shared/plans.ts";
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
    const plans = Object.keys(harnessesOf(ctx)).length > 0;
    const [{ tiers, kinds }, levels, connected] = await Promise.all([
      orgTiersOf(system),
      levelsOf(system, {
        ...(input.space ? { space: input.space } : {}),
        ...(input.thread ? { thread: input.thread } : {}),
        ...(person ? { person } : {}),
      }),
      plans && person ? connectedOf(ctx) : new Map<string, string[] | undefined>(),
    ]);
    const inForce = tierIn(tiers, levels);
    const kind = kindOf(ctx, input.agent, undefined, kinds);
    const chain = entryOf(inForce ? tiers[inForce.tier] : undefined, kind, kinds);
    if (chain === undefined) return null;
    if (!plans) return chain;
    return { model: chain, ...plansOf(ctx, connected, levels.person?.harnesses) };
  },
});
