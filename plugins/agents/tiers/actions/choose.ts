/**
 * Choosing the app's agents' models, for the org or for one space, in person.
 * The org's are changed by its owners and admins, a space's by its managers;
 * which tier a space takes isn't limited: the org's budget bounds what it
 * spends. A change applies from each conversation's next reply.
 *
 * - `tiers.choose` `{ space?, tier, picks? }`: the tier by its name (null:
 *   the one above, the org's or the plan's), and `picks: null` to drop every
 *   agent's own pick there too (back to the tier as it is).
 * - `tiers.pick` `{ space?, agent, model }`: a model for one of the app's
 *   agents there, as an agent's `model` takes one (null: back to the tier's).
 *   It's checked as an agent's would be, and keeps the tier's list behind it;
 *   as it runs, it gets the `maxTokens` of the entry it replaces, and its
 *   `effort` when the picked model takes it.
 */
import { type Context, defineAction, inPerson, invalid } from "../../../../runtime/mod.ts";
import { must, ORG } from "../../../access/spaces/contract.ts";
import type { ModelRef } from "../../../models/contract.ts";
import { agentsOf } from "../../chat/contract.ts";
import type { ModelChoice } from "../collections/choice.ts";
import { type Choice, ORG_CHOICE, spaceChoice, tiersOf } from "../shared/tiers.ts";

/** Where a choice is kept, once the caller may change it. */
async function choiceFor(ctx: Context, space?: string): Promise<string> {
  if (!space) {
    await must(ctx, "manage", ORG, "Only the org's owners and admins change its agents' models.");
    return ORG_CHOICE;
  }
  await must(ctx, "manage", space, "Only this space's managers change its agents' models.");
  return spaceChoice(space);
}

/** Changes a choice; one left with nothing in it is gone, so what's above applies. */
async function change(ctx: Context, space: string | undefined, to: (had: Choice) => Choice) {
  const id = await choiceFor(ctx, space);
  const docs = ctx.as().db.collection<ModelChoice>("modelChoice");
  const had = await docs.findOne({ _id: id });
  const next = to({ ...(had?.tier ? { tier: had.tier } : {}), custom: { ...had?.custom } });
  const custom = next.custom && Object.keys(next.custom).length ? next.custom : undefined;
  if (!next.tier && !custom) {
    if (had) await docs.deleteOne({ _id: id });
    return { tier: null, custom: {} };
  }
  await docs.replaceOne({ _id: id }, {
    _id: id,
    ...(space ? { space } : {}),
    ...(next.tier ? { tier: next.tier } : {}),
    ...(custom ? { custom } : {}),
    at: new Date().toISOString(),
  }, { upsert: true });
  return { tier: next.tier ?? null, custom: custom ?? {} };
}

export const chooseAction = defineAction({
  description: "Chooses the tier of models the app's agents use, in the org or a space",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      tier: { type: ["string", "null"] },
      picks: { type: "null" },
    },
    required: ["tier"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: (ctx, input) => {
    if (input.tier !== null && !Object.hasOwn(tiersOf(ctx), input.tier)) {
      throw invalid(`There's no tier "${input.tier}".`);
    }
    return change(ctx, input.space, (had) => ({
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.picks === null ? {} : { custom: had.custom }),
    }));
  },
});

export const pickAction = defineAction({
  description: "Picks the model one of the app's agents uses, in the org or a space",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      agent: { type: "string", minLength: 1 },
      model: {},
    },
    required: ["agent", "model"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!agentsOf(ctx)[input.agent]) {
      throw invalid(`"${input.agent}" isn't one of the app's agents: it keeps its own model.`);
    }
    const model = input.model as ModelRef | null;
    if (model !== null) await ctx.call("models.check", { model, port: "llm" });
    return change(ctx, input.space, (had) => {
      const { [input.agent]: _, ...rest } = had.custom ?? {};
      return { ...had, custom: model === null ? rest : { ...rest, [input.agent]: model } };
    });
  },
});
