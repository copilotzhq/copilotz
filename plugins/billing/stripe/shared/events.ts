/**
 * What Stripe says, as what the app keeps. Whichever account it comes from:
 * a signature checked, then an event read as a fact for `billing.apply`, which
 * knows nothing of Stripe. Pure, apart from the clock and the crypto.
 */
import type { PaymentFact, PeriodFact, PlanFact } from "../../credits/contract.ts";

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
  "charge.dispute.closed",
];

/** What an event comes to for an org: facts for `billing.apply`; nothing when it isn't ours. */
export type Fact = { org: string; plan?: PlanFact; payment?: PaymentFact; period?: PeriodFact };

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;

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

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** A period's credits last a day past its end: its renewal's invoice comes hours into that day. */
const dayAfter = (seconds: number) => day(seconds + 86400);

/**
 * What an invoice paid for, when it's a period of a plan: as many seats as it
 * charged for. Those added midway pay a part, and get their credits from the next.
 */
function periodOfInvoice(invoice: Any, plan: string | undefined): PeriodFact | undefined {
  if (!plan) return undefined;
  if (
    invoice.billing_reason !== "subscription_create" &&
    invoice.billing_reason !== "subscription_cycle"
  ) return undefined;
  const line = (invoice.lines?.data ?? []).find((l: Any) => l.quantity && l.period);
  if (!line) return undefined;
  return {
    plan,
    start: day(line.period.start),
    expires: dayAfter(line.period.end),
    seats: line.quantity,
    ...(invoice.livemode === false ? { sandbox: true } : {}),
  };
}

/**
 * Money going back or coming back on a charge that bought credits, by its own
 * metadata: its credits in proportion. Charges for seats carry no such metadata,
 * and are for staff to put right.
 */
function creditsMoved(
  charge: Any,
  amount: number,
  seller: { name: string; rate?: number },
  ref: string,
  note: string,
): Fact | null {
  const org = charge.metadata?.org;
  if (!org || !amount) return null;
  if (charge.metadata?.seller && charge.metadata.seller !== seller.name) return null;
  const credits = Number(charge.metadata?.credits ?? 0);
  return {
    org,
    payment: {
      channel: "stripe",
      seller: seller.name,
      ref,
      amount: main(amount, charge.currency),
      currency: charge.currency,
      ...(seller.rate ? { rate: seller.rate } : {}),
      purpose: "refund",
      ...(credits && charge.amount
        ? { credits: Math.round(credits * amount / charge.amount * 1e8) / 1e8 }
        : {}),
      note,
      ...(charge.livemode === false ? { sandbox: true } : {}),
    },
  };
}

export function factOf(
  event: {
    id: string;
    type: string;
    created?: number;
    livemode?: boolean;
    data: { object: Any; previous_attributes?: Any };
  },
  seller: { name: string; rate?: number },
  /** The plan an org goes back to when its subscription ends. */
  start: string,
): Fact | null {
  const object = event.data.object;
  const at = event.created ? new Date(event.created * 1000).toISOString() : undefined;
  const when = at ? { at } : {};
  const test = event.livemode === false ? { sandbox: true } : {};
  const ours = (metadata: Record<string, string> | undefined) =>
    !!metadata?.org && (!metadata.seller || metadata.seller === seller.name);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // An async method (Pix, a transfer) can complete unpaid: its money comes with the second.
      if (object.payment_status !== "paid" && object.payment_status !== "no_payment_required") {
        return null;
      }
      if (!ours(object.metadata)) return null;
      const org = object.metadata.org;
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
            ...when,
            sandbox: event.livemode === false,
          },
        };
      }
      return {
        org,
        ...(customer
          ? { plan: { customer, seller: seller.name, sandbox: event.livemode === false } }
          : {}),
        payment: {
          channel: "stripe",
          seller: seller.name,
          ref: object.id,
          amount: main(object.amount_subtotal ?? object.amount_total ?? 0, object.currency),
          currency: object.currency,
          ...(seller.rate ? { rate: seller.rate } : {}),
          purpose: "credits",
          credits: Number(object.metadata.credits ?? 0),
          ...test,
        },
      };
    }
    case "invoice.paid": {
      const { metadata, subscription } = ofInvoice(object);
      if (!ours(metadata)) return null;
      const period = periodOfInvoice(object, metadata.plan);
      return {
        org: metadata.org,
        ...(subscription ? { plan: { of: subscription, status: "active", ...when } } : {}),
        ...(period ? { period } : {}),
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
              ...test,
            },
          }
          : {}),
      };
    }
    case "invoice.payment_failed": {
      const { metadata, subscription } = ofInvoice(object);
      return ours(metadata) && subscription
        ? { org: metadata.org, plan: { of: subscription, status: "past_due", ...when } }
        : null;
    }
    case "customer.subscription.updated":
      return ours(object.metadata)
        ? { org: object.metadata.org, plan: { of: object.id, status: object.status, ...when } }
        : null;
    case "customer.subscription.deleted":
      return ours(object.metadata)
        ? {
          org: object.metadata.org,
          plan: {
            of: object.id,
            ended: object.id,
            name: start,
            status: "canceled",
            subscription: null,
            ...when,
          },
        }
        : null;
    case "charge.refunded": {
      // Disputed, the dispute took it back already.
      if (object.disputed) return null;
      const before = event.data.previous_attributes?.amount_refunded ?? 0;
      return creditsMoved(
        object,
        -(object.amount_refunded - before),
        seller,
        `refund:${object.id}:${object.amount_refunded}`,
        "Refunded",
      );
    }
    default:
      return null;
  }
}

/**
 * A dispute's credits, once its charge is known: opened, they go, as it holds the
 * money until it's decided; won, they come back.
 */
export function factOfDispute(
  type: string,
  dispute: Any,
  charge: Any,
  seller: { name: string; rate?: number },
): Fact | null {
  if (type === "charge.dispute.created") {
    return creditsMoved(charge, -dispute.amount, seller, `dispute:${dispute.id}`, "Disputed");
  }
  return dispute.status === "won"
    ? creditsMoved(charge, dispute.amount, seller, `dispute-won:${dispute.id}`, "Dispute won")
    : null;
}
