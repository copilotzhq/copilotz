/**
 * Stripe's webhook, for the host that serves many orgs: the same address for
 * every org, per account, so it's the app's, not an org's. `POST <path>/<seller>`:
 * the signature checked against that seller's secret, the event read as a fact,
 * and handed to its org as `billing.apply`, under the event's own id, so an event
 * sent twice answers from the org's log. Anything that can be tried again answers
 * 500, and Stripe does.
 */
import type { Runtime } from "../../../runtime/mod.ts";
import { stripeCall } from "./shared/api.ts";
import { factOf, factOfDispute, verified } from "./shared/events.ts";
import type { StripeSettings } from "./shared/settings.ts";

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function stripeWebhook(options: {
  settings: StripeSettings;
  /** An org's runtime, opened if it has to be. */
  runtime(org: string): Promise<Runtime | undefined>;
  /** The plan an org goes back to when its subscription ends. */
  start: string;
}): (request: Request, sellerName: string) => Promise<Response> {
  return async (request, sellerName) => {
    const seller = options.settings.sellers[sellerName];
    if (!seller) return answer(404, { error: "No such seller" });
    const payload = await request.text();
    if (!await verified(seller.webhookSecret, payload, request.headers.get("stripe-signature"))) {
      return answer(400, { error: "Bad signature" });
    }
    const event = JSON.parse(payload);
    const named = { name: sellerName, ...(seller.rate ? { rate: seller.rate } : {}) };
    try {
      let fact = factOf(event, named, options.start);
      if (event.type === "charge.dispute.created") {
        const dispute = event.data.object;
        const charge = await stripeCall(
          { key: seller.key, fetch: options.settings.fetch },
          "GET",
          `/v1/charges/${typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id}`,
        );
        fact = factOfDispute(dispute, charge, sellerName);
      }
      // Not ours (another product on the account), or nothing to keep: received all the same.
      if (!fact) return answer(200, { ignored: event.type });
      const runtime = await options.runtime(fact.org);
      // An org that's gone won't come back, so there's nothing to try again.
      if (!runtime) return answer(200, { ignored: "no such org" });
      const { org: _, ...facts } = fact;
      await runtime.call("billing.apply", facts, { id: `stripe:${event.id}` });
      return answer(200);
    } catch (error) {
      console.error(
        `stripe: ${event.type} (${event.id}):`,
        error instanceof Error ? error.message : error,
      );
      return answer(500, { error: "Try again" });
    }
  };
}
