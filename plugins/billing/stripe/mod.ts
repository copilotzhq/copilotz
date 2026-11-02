/**
 * Stripe: one way an org pays, for `credits`, which never asks it anything.
 * Checkout and the customer portal are Stripe's pages, so no card reaches the
 * app; what was paid lands by a signed webhook (webhook.ts, `billing.apply`).
 * One or more accounts sell (`sellers`): an org stays with whichever first took
 * its money, chosen by its billing country.
 *
 *   plugins: [usage, credits, stripe, …]
 *   resources: { stripe: { url, seller: "main", sellers: { main: { key, … } } } }
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { checkoutAction, portalAction, seatsAction } from "./actions/checkout.ts";

export { stripeWebhook } from "./webhook.ts";
export { EVENTS } from "./shared/events.ts";
export { API_VERSION } from "./shared/api.ts";
export type { Seller, StripeSettings } from "./shared/settings.ts";

export const stripe: Plugin = definePlugin({
  name: "stripe",
  requires: ["credits"],
  actions: {
    "billing.checkout": checkoutAction,
    "billing.portal": portalAction,
    "stripe.seats": seatsAction,
  },
  schedules: { "stripe.seats": { cron: "40 0 * * *", call: "stripe.seats", input: {} } },
  resources: { billing: { pay: { checkout: "billing.checkout", portal: "billing.portal" } } },
});

export default stripe;
