/**
 * Tiers: how hard an app's agents think, chosen by budget rather than model
 * by model. Agents don't hold models here: each does a **kind of work**, and
 * a **tier** is a template giving each kind a model chain (a model, its
 * effort, and what's tried after it when it fails). Every conversation runs
 * on a tier.
 *
 * - **The app** declares its tiers (`tiers`: each a title, what it's good
 *   for, an order, and a chain for each kind, as an agent's `model` takes
 *   one) and names its kinds (`tierKinds`: `{ north: { title: "Decides" } }`;
 *   the kinds are the tiers' keys, and an app agent of that name does that
 *   kind). Any other agent says which kind it does (`like`), else it does the
 *   app's first.
 * - **An org** keeps its own version of each tier (kinds' chains changed, a
 *   title), takes tiers away, makes new ones (`tiers.save`, `tiers.remove`,
 *   `tiers.restore`; `tierTemplate`), and adds kinds of work of its own, each
 *   based on one of the app's (`tiers.kind`; `tierKind`). Its owners and
 *   admins do; everyone in it reads them.
 * - **Which tier, first that applies:** the conversation's, the person's own
 *   default for new chats, the space's, the org's, then the tier the org's
 *   plan gives (the `planTier` resource, which credits fills)
 *   (`tiers.choose`; `modelChoice`, by name, never copies). The org can cap
 *   what its members choose (`tiers.cap`); its owners and admins aren't
 *   bound by it, and its budget bounds what anyone spends.
 * - **Every turn:** chat asks `tiers.model` through its `agentModel` resource,
 *   for every agent, with the kind it works like. A change applies from each
 *   conversation's next reply.
 * - **Plans first:** where the app has people's plans (providers with
 *   `harness`: Claude Code, ChatGPT…), a turn's chain goes with the plans its
 *   person has connected now (each `connectedPlans` source says), in their
 *   order (`tiers.harnesses`; `modelChoice.harnesses` lists them), and each
 *   model runs on those that serve it before any API. A tier names models;
 *   an entry naming a plan (`claude-plan/…`) stands for its model on plans
 *   only. `plansFor` (shared/plans.ts) is what a turn goes with, and
 *   `models.check` what a chain would try.
 *
 * Its queries (`modelChoice.offered`, `modelChoice.agent`) show the tiers
 * with what a typical message comes to at the org's prices (the app's
 * `typicalMessage`, measured, else a plain reply), and how far the plan's
 * credits go (`planCredits`).
 *
 * ```ts
 * plugins: [models, chat, ...access, tiers, definePlugin({
 *   name: "app",
 *   resources: {
 *     tierKinds: { north: { title: "Decides" }, east: { title: "Builds" } },
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
import { definePlugin, type Plugin } from "copilotz";
import {
  capAction,
  chooseAction,
  harnessesAction,
  kindAction,
  removeAction,
  restoreAction,
  saveAction,
} from "./actions/choose.ts";
import { modelAction } from "./actions/model.ts";
import { modelChoice } from "./collections/choice.ts";
import { tierKind, tierTemplate } from "./collections/template.ts";
import { appTiersOf } from "./shared/tiers.ts";

export * from "./contract.ts";

export const tiers: Plugin = definePlugin({
  name: "tiers",
  // Its choices are an org's, its spaces' and its conversations', changed by who runs them.
  requires: ["chat", "spaces"],
  collections: { modelChoice, tierTemplate, tierKind },
  actions: {
    "tiers.model": modelAction,
    "tiers.choose": chooseAction,
    "tiers.cap": capAction,
    "tiers.save": saveAction,
    "tiers.remove": removeAction,
    "tiers.restore": restoreAction,
    "tiers.kind": kindAction,
    "tiers.harnesses": harnessesAction,
  },
  resources: {
    // Chat asks it which model chain each agent thinks with.
    agentModel: { tiers: { action: "tiers.model" } },
  },
  // Every tier has a title, and models that can be called as configured.
  async check(merged) {
    for (const [name, tier] of Object.entries(appTiersOf(merged))) {
      if (!tier.title) throw new Error(`Tier "${name}" has no title`);
      for (const [kind, model] of Object.entries(tier.agents ?? {})) {
        try {
          await merged.call("models.check", { model, port: "llm" });
        } catch (error) {
          throw new Error(`Tier "${name}", ${kind}: ${(error as Error).message}`);
        }
      }
    }
  },
});

export default tiers;
