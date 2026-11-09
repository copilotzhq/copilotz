/**
 * Team (`@copilotz/team`): agents people make, and the models the app's
 * agents think with, as an org and its spaces choose them. Two plugins
 * beside Copilotz's `chat` (whose agents are the app's, in its code):
 *
 * - `team`: agents people make where they belong (a space), with their
 *   instructions, tools and model, added to other spaces by those who met
 *   them, changed only by who manage the space they belong to. Chat asks it
 *   what an agent not in the app's code is (`agentSources`).
 * - `tiers`: which model each of the app's agents thinks with, by tier
 *   ("Everyday", "Expert"), the first that applies of a space's pick, the
 *   space's tier, the org's pick, the org's tier and its plan's (the
 *   `planTier` resource: `@copilotz/billing`'s credits fill it).
 *
 * ```ts
 * import { team, tiers } from "@copilotz/team";
 *
 * plugins: [models, chat, ...access, team, tiers, app]
 * ```
 *
 * Their front ends are `@copilotz/team/web` (`teamWeb`, `tiersWeb`); their
 * shapes, `@copilotz/team/contract`.
 */
export * from "./team/mod.ts";
export * from "./tiers/mod.ts";
