/**
 * What Stripe says, as what the app keeps. Whichever account it comes from:
 * a signature checked, then an event read as a fact for `billing.apply`, which
 * knows nothing of Stripe. Pure, apart from the clock and the crypto.
 */
import type { PaymentFact, PlanFact } from "../../credits/contract.ts";

const TOLERANCE_SECONDS = 300;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let differs = 0;
  for (let i = 0; i < a.length; i++) differs |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differs === 0;
};

/** `Stripe-Signature`, checked against the raw body: from this account, and recent. */
export async function verified(
  secret: string,
  payload: string,
  header: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((part) => part.split("=") as [string, string]);
  const at = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!at || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(at)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${payload}`)),
  );
  return signatures.some((signature) => same(signature, signed));
}

/** The events acted on: subscribe a webhook to these. */
export const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
];

/** What an event comes to for an org: facts for `billing.apply`; nothing when it isn't ours. */
export type Fact = { org: string; plan?: PlanFact; payment?: PaymentFact };

type Any = Record<string, any>; // deno-lint-ignore no-explicit-any

const idOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : (value as { id?: string } | null)?.id;

const main = (minor: number, currency: string) => // Currencies without cents are few, and none of this app's sellers charges in one.
(void currency, minor / 100);

/** An invoice's subscription and its metadata, wherever this API version puts them. */
const ofInvoice = (invoice: Any) => {
  const details = invoice.parent?.subscription_details ?? invoice.subscription_details ?? {};
  return {
    subscription: idOf(details.subscription ?? invoice.subscription),
    metadata: (details.metadata ?? {}) as Record<string, string>,
  };
};

/** Credits a charge bought, by its own metadata, taken back in proportion to what's returned. */
function takenBack(
  charge: Any,
  returned: number,
  seller: string,
  ref: string,
  note: string,
): Fact | null {
  const org = charge.metadata?.org;
  if (!org || !returned) return null;
  const credits = Number(charge.metadata?.credits ?? 0);
  return {
    org,
    payment: {
      channel: "stripe",
      seller,
      ref,
      amount: -main(returned, charge.currency),
      currency: charge.currency,
      purpose: "refund",
      ...(credits && charge.amount
        ? { credits: -Math.round(credits * returned / charge.amount * 1e8) / 1e8 }
        : {}),
      note,
    },
  };
}

export function factOf(
  event: { id: string; type: string; data: { object: Any; previous_attributes?: Any } },
  seller: { name: string; rate?: number },
  /** The plan an org goes back to when its subscription ends. */
  start: string,
): Fact | null {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // An async method (Pix, a transfer) can complete unpaid: its money comes with the second.
      if (object.payment_status !== "paid" && object.payment_status !== "no_payment_required") {
        return null;
      }
      const org = object.metadata?.org;
      if (!org) return null;
      const customer = idOf(object.customer);
      if (object.mode === "subscription") {
        return {
          org,
          plan: {
            name: object.metadata.plan,
            channel: "stripe",
            seller: seller.name,
            ...(customer ? { customer } : {}),
            ...(idOf(object.subscription) ? { subscription: idOf(object.subscription)! } : {}),
            status: "active",
          },
        };
      }
      return {
        org,
        ...(customer ? { plan: { customer, seller: seller.name } } : {}),
        payment: {
          channel: "stripe",
          seller: seller.name,
          ref: object.id,
          amount: main(object.amount_subtotal ?? object.amount_total ?? 0, object.currency),
          currency: object.currency,
          ...(seller.rate ? { rate: seller.rate } : {}),
          purpose: "credits",
          credits: Number(object.metadata.credits ?? 0),
        },
      };
    }
    case "invoice.paid": {
      const { metadata } = ofInvoice(object);
      if (!metadata.org) return null;
      return {
        org: metadata.org,
        plan: { status: "active" },
        ...(object.amount_paid
          ? {
            payment: {
              channel: "stripe",
              seller: seller.name,
              ref: object.id,
              amount: main(object.subtotal ?? object.amount_paid, object.currency),
              currency: object.currency,
              ...(seller.rate ? { rate: seller.rate } : {}),
              purpose: "seats" as const,
            },
          }
          : {}),
      };
    }
    case "invoice.payment_failed": {
      const { metadata } = ofInvoice(object);
      return metadata.org ? { org: metadata.org, plan: { status: "past_due" } } : null;
    }
    case "customer.subscription.updated":
      return object.metadata?.org
        ? { org: object.metadata.org, plan: { status: object.status } }
        : null;
    case "customer.subscription.deleted":
      return object.metadata?.org
        ? {
          org: object.metadata.org,
          plan: { name: start, status: "canceled", subscription: null },
        }
        : null;
    case "charge.refunded": {
      const before = event.data.previous_attributes?.amount_refunded ?? 0;
      return takenBack(
        object,
        object.amount_refunded - before,
        seller.name,
        `refund:${object.id}:${object.amount_refunded}`,
        "Refunded",
      );
    }
    default:
      return null;
  }
}

/** A dispute's credits, once its charge is known: it holds the money until it's decided. */
export const factOfDispute = (dispute: Any, charge: Any, seller: string): Fact | null =>
  takenBack(charge, dispute.amount, seller, `dispute:${dispute.id}`, "Disputed");
