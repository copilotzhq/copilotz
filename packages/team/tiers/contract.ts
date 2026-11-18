/**
 * The tiers plugin's contract: the shapes of a tier (its `tiers` resource), a
 * kind of work (`tierKinds`), what levels chose, and what its queries answer,
 * and the resource kinds it reads (`planTier`, `planCredits`,
 * `typicalMessage`). The rest is reached by name: its collections
 * (`modelChoice`, `tierTemplate`, `tierKind`), its queries
 * (`modelChoice.offered`, `modelChoice.agent`) and its Actions
 * (`tiers.model`, `tiers.choose`, `tiers.cap`, `tiers.save`, `tiers.remove`,
 * `tiers.restore`, `tiers.kind`).
 */
export type { By, Choice, Kind, Tier } from "./shared/tiers.ts";
export type { ModelChoice } from "./collections/choice.ts";
export type {
  AgentNow,
  CreditsShown,
  KindShown,
  ModelShown,
  PlanCredits,
  Shown,
  TierShown,
  TypicalMessage,
} from "./shared/shown.ts";

/**
 * A `planTier` resource: the Action saying which tier the org's plan gives its
 * agents while the org hasn't chosen (credits' `billing.tier`), `{}` in, a
 * tier's name or null out.
 */
export type PlanTier = { action: string };
