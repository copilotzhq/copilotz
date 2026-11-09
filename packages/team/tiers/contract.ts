/**
 * The tiers plugin's contract: the shapes of a tier (its `tiers` resource), of
 * what an org or a space chose, and of what its queries answer, and the
 * resource kind it reads (`planTier`). The rest is reached by name: its
 * collection `modelChoice`, its queries (`modelChoice.offered`,
 * `modelChoice.agent`) and its Actions (`tiers.model`, `tiers.choose`,
 * `tiers.pick`).
 */
export type { Choice, From, Tier } from "./shared/tiers.ts";
export type { ModelChoice } from "./collections/choice.ts";
export type { AgentNow, ChoiceShown, ModelShown, Shown, TierShown } from "./shared/shown.ts";

/**
 * A `planTier` resource: the Action saying which tier the org's plan gives its
 * agents while the org hasn't chosen (credits' `billing.tier`), `{}` in, a
 * tier's name or null out.
 */
export type PlanTier = { action: string };
