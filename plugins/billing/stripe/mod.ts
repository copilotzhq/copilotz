/**
 * Stripe: one way an org pays, for `credits`, which never asks it anything.
 * Checkout and the customer portal are Stripe's pages, so no card reaches the
 * app; what was paid lands by a signed webhook (`stripeWebhook`, its route
 * `POST /__stripe/<seller>`: routes/webhook.ts), as `billing.apply`.
 * One or more accounts sell (`sellers`): an org stays with whichever first took
 * its money, chosen by its billing country. A plan is offered to an org only
 * once its seller has a price for it (`billing.sellable`).
 *
 *   plugins: [usage, credits, stripe, stripeWebhook, …]
 *   resources: { stripe: { url, seller: "main", sellers: { main: { key, … } } } }
 *
 * With many orgs, the webhook is the directory's (one address per account),
 * and finds each org's runtime in the app's orgs:
 *
 *   directory's plugins: [identity, directory, stripeWebhook, …]
 *   resources: { stripe: { ...stripeSettings, orgs } }
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { checkoutAction, portalAction, seatsAction, sellableAction } from "./actions/checkout.ts";
import { factAction } from "./actions/fact.ts";
import { webhookRoute } from "./routes/webhook.ts";

export { EVENTS } from "./shared/events.ts";
export { API_VERSION } from "./shared/api.ts";
export type { Seller, StripeSettings } from "./shared/settings.ts";

export const stripe: Plugin = definePlugin({
  name: "stripe",
  requires: ["credits"],
  actions: {
    "billing.checkout": checkoutAction,
    "billing.portal": portalAction,
    "billing.sellable": sellableAction,
    "stripe.seats": seatsAction,
  },
  schedules: { "stripe.seats": { cron: "40 0 * * *", call: "stripe.seats", input: {} } },
  resources: {
    billing: {
      pay: { checkout: "billing.checkout", portal: "billing.portal", sellable: "billing.sellable" },
    },
  },
});

/**
 * Stripe's webhook, `POST /__stripe/<seller>`, where the app's accounts send
 * their events (see routes/webhook.ts): in the runtime of the app's one
 * address (the directory's, with many orgs), beside the `stripe` resource.
 */
export const stripeWebhook: Plugin = definePlugin({
  name: "stripe-webhook",
  actions: { "stripe.fact": factAction },
  routes: { "/__stripe/:seller": webhookRoute },
  resources: { stripe: {} },
});

export default stripe;
