/**
 * `stripe.fact` `{ seller, event }`: what an event Stripe sent (its
 * signature already checked, by the webhook's route) comes to for an org, as
 * facts for `billing.apply`: `{ fact }`, or `{ fact: null }` when it isn't
 * ours (another product on the account) or keeps nothing. A dispute's
 * charge is asked of Stripe (through `ctx.fetch`). The plan an org goes back
 * to when its subscription ends is `billing.start` ("free" unless the app
 * says). The system's, and unrecorded: its input is Stripe's event, and what
 * it comes to lands in the org, as `billing.apply`, under the event's id.
 */
import { defineAction, invalid } from "../../../../runtime/mod.ts";
import { stripeCall } from "../shared/api.ts";
import { type Fact, factOf, factOfDispute } from "../shared/events.ts";
import { settingsOf } from "../shared/settings.ts";

export const factAction = defineAction({
  description: "What a Stripe event comes to for an org: facts for billing.apply, or none",
  record: false,
  input: {
    type: "object",
    properties: { seller: { type: "string" }, event: { type: "object" } },
    required: ["seller", "event"],
    additionalProperties: false,
  },
  run: async (ctx, input): Promise<{ fact: Fact | null }> => {
    const seller = settingsOf(ctx).sellers[input.seller];
    if (!seller) throw invalid(`No seller "${input.seller}"`);
    // deno-lint-ignore no-explicit-any
    const event = input.event as any;
    const named = { name: input.seller, ...(seller.rate ? { rate: seller.rate } : {}) };
    const start = (ctx.resources.billing as { start?: string } | undefined)?.start ?? "free";
    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
      const dispute = event.data.object;
      const charge = await stripeCall(
        { key: seller.key, fetch: ctx.fetch },
        "GET",
        `/v1/charges/${typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id}`,
      );
      return { fact: factOfDispute(event.type, dispute, charge, named) };
    }
    return { fact: factOf(event, named, start) };
  },
});
