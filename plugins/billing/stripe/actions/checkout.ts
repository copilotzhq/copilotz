/**
 * Paying, as owners and admins of an org do, in person. Each answers `{ url }`,
 * a page of Stripe's: card details never reach the app.
 *
 * - `billing.checkout` `{ credits, country? }`: buy credits, once (USD);
 * - `billing.checkout` `{ plan, country? }`: subscribe to a plan, a seat each;
 * - `billing.portal` `{}`: manage what's being paid: card, invoices, cancelling.
 *
 * What was bought lands by the webhook, not here: a person can close the page,
 * and only the webhook is signed.
 */
import {
  type Context,
  defineAction,
  failure,
  forbidden,
  inPerson,
  invalid,
} from "../../../../runtime/mod.ts";
import { runsOrg } from "../../../access/spaces/contract.ts";
import type { Plan, PlanTerms } from "../../credits/contract.ts";
import { stripeCall } from "../shared/api.ts";
import { sellerFor, settingsOf } from "../shared/settings.ts";

async function runsIt(ctx: Context) {
  if (ctx.actor?.staff === true) return;
  const me = await ctx.call<{ role?: string | null }>("org.me", {});
  if (!runsOrg(me.role)) throw forbidden("Only the org's owners and admins do this.");
}

const planOf = (ctx: Context) => ctx.as().call<Plan>("billing.plan", {});

const orgOf = (ctx: Context) => {
  const org = ctx.resources.org as { id?: string } | undefined;
  if (!org?.id) throw invalid("This app doesn't sell by org.");
  return org.id;
};

export const checkoutAction = defineAction({
  description: "A page where the org buys credits, or subscribes to a plan",
  record: false,
  input: {
    type: "object",
    properties: {
      credits: { type: "number", exclusiveMinimum: 0 },
      plan: { type: "string" },
      country: { type: "string", minLength: 2, maxLength: 2 },
    },
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsIt(ctx);
    const org = orgOf(ctx);
    const set = settingsOf(ctx);
    const plan = await planOf(ctx);
    const chosen = sellerFor(set, plan.seller, input.country);
    if (!chosen) throw failure("no_seller", "Paying isn't set up here yet.");
    const [name, seller] = chosen;
    const back = (paid: string) => `${set.url}/org?tab=billing&paid=${paid}`;
    const common = {
      ...(plan.customer ? { customer: plan.customer } : {}),
      client_reference_id: org,
      cancel_url: `${set.url}/org?tab=billing`,
    };
    const call = (params: Record<string, unknown>) =>
      stripeCall<{ url: string }>(
        { key: seller.key, fetch: set.fetch },
        "POST",
        "/v1/checkout/sessions",
        {
          ...common,
          ...params,
        },
      );
    if (input.plan) {
      const { plans } = ctx.resources.billing as { plans: Record<string, PlanTerms> };
      const terms = plans[input.plan];
      const price = seller.prices[input.plan];
      if (!terms || !price) throw invalid(`The plan "${input.plan}" can't be bought here.`);
      if (plan.subscription && plan.status !== "canceled") {
        throw failure("subscribed", "This org already has a subscription: manage it instead.");
      }
      const seats = Math.max(await ctx.as().call<number>("org.seats", {}).catch(() => 1), 1);
      const metadata = { org, plan: input.plan, seller: name };
      const { url } = await call({
        mode: "subscription",
        integration_identifier: "compass_plan_qwhtzkvb",
        line_items: [{ price, quantity: seats }],
        allow_promotion_codes: true,
        metadata,
        subscription_data: { metadata },
        success_url: back("plan"),
      });
      return { url };
    }
    if (!input.credits) throw invalid("Say how many credits.");
    const credits = Math.round(input.credits * 100) / 100;
    if (seller.currency !== "usd" && !seller.rate) {
      throw failure("no_seller", "Paying isn't set up here yet.");
    }
    const unit = Math.ceil(credits / (seller.rate ?? 1) * 100);
    const metadata = { org, purpose: "credits", credits: String(credits), seller: name };
    const { url } = await call({
      mode: "payment",
      integration_identifier: "compass_credits_nmrplsjd",
      line_items: [{
        quantity: 1,
        price_data: { currency: seller.currency, unit_amount: unit, product: seller.credits },
      }],
      ...(plan.customer ? {} : { customer_creation: "always" }),
      invoice_creation: { enabled: true },
      metadata,
      payment_intent_data: { metadata },
      success_url: back("credits"),
    });
    return { url };
  },
});

export const portalAction = defineAction({
  description: "A page where the org manages what it pays: card, invoices, cancelling",
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: inPerson,
  run: async (ctx) => {
    await runsIt(ctx);
    const set = settingsOf(ctx);
    const plan = await planOf(ctx);
    const chosen = sellerFor(set, plan.seller);
    if (!chosen || !plan.customer) {
      throw failure("not_paying", "There's nothing to manage yet: nothing has been paid.");
    }
    const { url } = await stripeCall<{ url: string }>(
      { key: chosen[1].key, fetch: set.fetch },
      "POST",
      "/v1/billing_portal/sessions",
      { customer: plan.customer, return_url: `${set.url}/org?tab=billing` },
    );
    return { url };
  },
});

export const seatsAction = defineAction({
  description: "Brings a subscription's seats to the org's people, each day",
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    const set = settingsOf(ctx);
    const plan = await ctx.as().db.collection<{
      subscription?: string;
      seller?: string;
      status?: string;
      seats?: number;
      waived?: { seats?: { people?: string[] } };
    }>("billingPlan").findOne({ _id: "plan" });
    if (!plan?.subscription || plan.status !== "active" || !plan.seller) return {};
    const seller = set.sellers[plan.seller];
    if (!seller) return {};
    const people = plan.seats ?? await ctx.as().call<number>("org.seats", {}).catch(() => 1);
    const seats = Math.max(people - (plan.waived?.seats?.people?.length ?? 0), 1);
    const key = { key: seller.key, fetch: set.fetch };
    const subscription = await stripeCall<{
      items: { data: { id: string; quantity: number }[] };
    }>(key, "GET", `/v1/subscriptions/${plan.subscription}`);
    const item = subscription.items.data[0];
    if (!item || item.quantity === seats) return {};
    await stripeCall(key, "POST", `/v1/subscription_items/${item.id}`, { quantity: seats });
    return { seats };
  },
});
