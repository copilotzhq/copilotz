/**
 * The credits plugin's contract: what a way of paying may import, the shapes of
 * what it tells `billing.apply`. The rest it reaches by name: `billing.plan`
 * (the org's plan, started if need be) and `billing.apply` (a payment, or a plan
 * changed), and its own Actions through `resources.billing.pay`.
 */
export type { PaymentFact, PlanFact } from "./shared/apply.ts";
export type { Plan } from "./collections/plan.ts";
export type { PlanTerms } from "./shared/settings.ts";
