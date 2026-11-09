/**
 * Billing's contract (`@copilotz/billing/contract`): credits', what a payment
 * provider tells it (`PaymentFact`, `PeriodFact`, `PlanFact`), a plan's terms
 * and how they're read, for plugins built on it. The rest is reached by name,
 * through the runtime (`billing.apply`, `billing.state`…).
 */
export * from "./credits/contract.ts";
