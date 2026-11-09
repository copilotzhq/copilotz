/**
 * Billing: what was used, what it cost, and what to charge for it. `usage` is
 * the ledger every metered use lands in, rated, and the port an app's pricing
 * plugs into: its `spending` check (whether an org may spend now) and the
 * `usage` resource's `spent` (each use's price, as it lands). What an org has
 * to spend and paying for it (credits, Stripe) are `@copilotz/billing`.
 *
 *   plugins: [models, chat, usage, …]
 */
import usage from "./usage/mod.ts";

export * from "./usage/mod.ts";
export { usage };
