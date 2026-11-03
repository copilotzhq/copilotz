/**
 * Tiers: which models the app's agents think with, chosen by what the work
 * needs rather than model by model. The app declares its tiers (its `tiers`
 * resource): each a title, what it's good for, and a model for each of its
 * agents, as an agent's `model` takes one (one, settings around one, or a list
 * tried in order). An org chooses one, and a space can choose another:
 *
 * - **Who chooses, first that applies:** a model picked for the agent in the
 *   space, the space's tier, a model picked for it by the org, the org's tier,
 *   then the tier the org's plan gives (the `planTier` resource, which credits
 *   fills); else the agent's own model. A tier that doesn't name an agent
 *   leaves it on its own. A pick keeps the tier's list behind it, so a model
 *   that fails falls back as before, and the `maxTokens` of the entry it
 *   replaces, with its `effort` when the picked model takes it.
 * - **Names, never copies:** an org or a space keeps a tier's name
 *   (`modelChoice`), so retuning a tier moves everyone on it.
 * - **Who may:** the org's owners and admins choose for the org, a space's
 *   managers for the space (`tiers.choose`, `tiers.pick`); everyone who
 *   reaches them sees what was chosen (`modelChoice.offered`,
 *   `modelChoice.agent`). Which tier a space takes isn't limited: the org's
 *   budget bounds what it spends.
 * - **Every turn:** chat asks `tiers.model` through its `agentModel` resource,
 *   for the app's agents only; agents people make keep their own model. A
 *   change applies from each conversation's next reply.
 *
 * ```ts
 * plugins: [models, chat, ...access, tiers, definePlugin({
 *   name: "app",
 *   resources: {
 *     tiers: {
 *       everyday: {
 *         title: "Everyday",
 *         description: "Quick answers, routine work, volume",
 *         order: 1,
 *         agents: { north: "anthropic/claude-haiku-5-5", east: "openai/gpt-6-luna" },
 *       },
 *       expert: {
 *         title: "Expert",
 *         description: "Hard problems, decisions that matter",
 *         order: 3,
 *         agents: {
 *           north: [{ model: "anthropic/claude-opus-5-5", effort: "medium" }, "openai/gpt-6.1-sol"],
 *           east: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
 *         },
 *       },
 *     },
 *   },
 * })]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { agentsOf } from "../chat/contract.ts";
import { chooseAction, pickAction } from "./actions/choose.ts";
import { modelAction } from "./actions/model.ts";
import { modelChoice } from "./collections/choice.ts";
import { tiersOf } from "./shared/tiers.ts";

export * from "./contract.ts";

export const tiers: Plugin = definePlugin({
  name: "tiers",
  // Its choices are an org's and its spaces', changed by who runs them.
  requires: ["chat", "spaces"],
  collections: { modelChoice },
  actions: {
    "tiers.model": modelAction,
    "tiers.choose": chooseAction,
    "tiers.pick": pickAction,
  },
  resources: {
    // Chat asks it which model each of the app's agents thinks with.
    agentModel: { tiers: { action: "tiers.model" } },
  },
  // Every tier names only the app's agents, with models that can be called as configured.
  async check(merged) {
    const agents = agentsOf(merged);
    for (const [name, tier] of Object.entries(tiersOf(merged))) {
      if (!tier.title) throw new Error(`Tier "${name}" has no title`);
      for (const [agent, model] of Object.entries(tier.agents ?? {})) {
        if (!agents[agent]) {
          throw new Error(`Tier "${name}" names "${agent}", which isn't one of the app's agents`);
        }
        try {
          await merged.call("models.check", { model, port: "llm" });
        } catch (error) {
          throw new Error(`Tier "${name}", ${agent}: ${(error as Error).message}`);
        }
      }
    }
  },
});

export default tiers;
