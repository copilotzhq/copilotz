/** Credits' settings: the `billing` resource, which an app patches. */
import type { Resources } from "../../../../runtime/mod.ts";

/** A plan: the terms an org on it gets. */
export type PlanTerms = {
  title: string;
  seat?: { price: number; currency: string };
  credits?: { once?: number; monthly?: number; perSeat?: number };
  prices?: string;
  /** The month's limit it starts with, per seat; none: the app's `budget`. */
  budget?: { perSeat: number };
  /** Which orgs may be on it: a person's own, or a team's; none: any. */
  for?: "personal" | "team";
  /** The model tier its orgs' agents use while the org hasn't chosen one (`billing.tier`). */
  models?: string;
};

/** What kind of org this is (`personal` or `team`), where the app serves many. */
export const orgKind = (ctx: { resources: Resources }): string | undefined =>
  (ctx.resources.org as { kind?: string } | undefined)?.kind;

/**
 * Why an org of this kind can't be on a plan, in words, or nothing when it
 * can: a plan for personal orgs isn't a team's, and the other way round. An
 * org whose kind isn't known (an app that serves one) can be on any.
 */
export function unfit(terms: Pick<PlanTerms, "title" | "for">, kind?: string): string | undefined {
  if (!terms.for || !kind || terms.for === kind) return undefined;
  return terms.for === "team"
    ? `${terms.title} is for team orgs, and this is a personal one. Make a team org to move to it.`
    : `${terms.title} is for personal orgs, and this one is a team's.`;
}

export type CreditsSettings = {
  /**
   * Whether limits apply. Off, nothing starts: no plans, no trials, no
   * balances, and nobody's stopped, though staff can prepare orgs.
   */
  enforce: boolean;
  /** The plans there are, and the one an org starts on. */
  plans: Record<string, PlanTerms>;
  start: string;
  /** The month's limit an org starts with (USD); none: no limit. */
  budget?: number;
  /** The share of a budget or of its credits used when it's said to be running low. */
  warnAt: number;
  /** What's never stopped, by a call's `purpose`: the app's own upkeep, which follows turns. */
  free: string[];
  /** Amounts offered for buying credits (USD), and the least and most. */
  topUps: number[];
  topUpMin: number;
  topUpMax: number;
  /**
   * How an org pays, when something lets it (the Actions `stripe` names):
   * checking out, managing what it pays, and which plans can be sold to it
   * now (`sellable`: `{}` → plan names; none: every plan with a seat price).
   */
  pay?: { checkout: string; portal: string; sellable?: string };
  /** Real money: what came from a test mode stops counting. */
  live?: boolean;
};

export const DEFAULTS: CreditsSettings = {
  enforce: true,
  plans: { free: { title: "Free", credits: { once: 5 } } },
  start: "free",
  warnAt: 0.8,
  free: ["history", "memory"],
  topUps: [10, 25, 50, 100],
  topUpMin: 5,
  topUpMax: 2000,
};

export const settingsOf = (ctx: { resources: Resources }): CreditsSettings => ({
  ...DEFAULTS,
  ...(ctx.resources.billing as Partial<CreditsSettings> | undefined),
});
