/**
 * The credits plugin's contract: what a way of paying may import, the shapes of
 * what it tells `billing.apply`, and whether an org's kind fits a plan
 * (`unfit`, `orgKind`). The rest it reaches by name: `billing.plan` (the org's
 * plan, started if need be) and `billing.apply` (a payment, or a plan
 * changed), and its own Actions through `resources.billing.pay`. What model
 * tier the org's plan gives its agents, others ask through the `planTier`
 * resource it fills (`billing.tier`).
 */
import type { Plan } from "./collections/plan.ts";

export type { PaymentFact, PeriodFact, PlanFact } from "./shared/apply.ts";
export type { Plan } from "./collections/plan.ts";
export type { PlanTerms } from "./shared/settings.ts";
export { orgKind, unfit } from "./shared/settings.ts";

/**
 * How many seats are charged for: its people, or its fixed number, less those
 * waived while that lasts. A waiver naming nobody waives every seat.
 */
export function billableSeats(
  plan: Pick<Plan, "seats" | "waived">,
  people: number,
  now: string,
): number {
  const total = plan.seats ?? people;
  const waived = plan.waived?.seats;
  if (!waived || (waived.until && waived.until <= now)) return total;
  return waived.people?.length ? Math.max(total - waived.people.length, 0) : 0;
}
