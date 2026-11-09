/**
 * Billing (`@copilotz/billing`): what an org has to spend, and paying for it,
 * built on Copilotz's usage ledger (`usage`, in `copilotz/plugins/billing`),
 * whose prices it counts.
 *
 * - `credits`: an org's plan, credits and payments, its balance and budget,
 *   and the check that stops it at its limit (the `spending` resource
 *   whatever spends reads); staff change plans and give credits by hand.
 * - `stripe`: one way an org pays, by Stripe's Checkout and portal; what was
 *   paid lands by a signed webhook (`stripeWebhook`, in the runtime of the
 *   app's one address: the directory's, with many orgs).
 *
 * ```ts
 * import { usage } from "copilotz/plugins/billing";
 * import { credits, stripe, stripeWebhook } from "@copilotz/billing";
 *
 * plugins: [models, chat, usage, credits, stripe, stripeWebhook, …]
 * ```
 *
 * Their front end is `@copilotz/billing/web` (`creditsWeb`: the org page's
 * Billing, the note above where you type); their shapes,
 * `@copilotz/billing/contract`.
 */
export * from "./credits/mod.ts";
export { API_VERSION, EVENTS, stripe, stripeWebhook } from "./stripe/mod.ts";
export type { Seller, StripeSettings } from "./stripe/mod.ts";
