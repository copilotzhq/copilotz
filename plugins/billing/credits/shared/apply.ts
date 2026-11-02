/**
 * What comes from outside, whoever collected it: a payment, a plan changed, a
 * period paid for. A person acting by hand and a payment provider's webhook both
 * land here, so the rest never knows the difference.
 *
 * News comes late and out of order, and an org can have had more than one
 * subscription, so news of a subscription (`of`) changes the org only while that
 * one is its own, what's older than what it knows changes nothing (`at`), and
 * one that ended (`ended`) never comes back.
 */
import { type Context, invalid } from "../../../../runtime/mod.ts";
import type { Credit } from "../collections/credit.ts";
import type { Payment } from "../collections/payment.ts";
import type { Plan } from "../collections/plan.ts";
import { settingsOf } from "./settings.ts";
import { ensurePlan, forget, termsFor } from "./standing.ts";

const round = (usd: number) => Math.round(usd * 1e8) / 1e8;

export type PaymentFact = {
  channel: string;
  ref: string;
  seller?: string;
  amount: number;
  currency: string;
  rate?: number;
  fee?: number;
  purpose: "seats" | "credits" | "contract" | "refund";
  credits?: number;
  note?: string;
  by?: string;
  sandbox?: boolean;
  at?: string;
};

/** Keeps a payment, and the credits it bought (taken back, for a refund). Once per `channel:ref`. */
export async function pay(ctx: Context, fact: PaymentFact): Promise<void> {
  const at = fact.at ?? new Date().toISOString();
  const id = `${fact.channel}:${fact.ref}`;
  const system = ctx.as();
  await system.db.collection<Payment>("payment").insertOne({ ...fact, _id: id, at } as Payment);
  if (fact.credits) {
    const back = fact.credits < 0;
    await system.db.collection<Credit>("credit").insertOne({
      _id: `purchase:${id}`,
      kind: back ? "adjustment" : "purchase",
      ...(back ? { takes: "purchase" } : {}),
      amount: round(fact.credits),
      at,
      ...(fact.note ? { note: fact.note } : {}),
      ...(fact.by ? { by: fact.by } : {}),
      ...(fact.sandbox ? { sandbox: true } : {}),
    } as Credit);
  }
  await forget(ctx);
}

export type PlanFact = {
  /** One of the app's plans, or a contract's own name with its `terms`. */
  name?: string;
  terms?: Plan["terms"];
  seats?: number | null;
  channel?: string;
  seller?: string;
  customer?: string;
  /** Null: it has none now. */
  subscription?: string | null;
  /** Null: nothing to say of its payments, as on a contract. */
  status?: string | null;
  /** Where its periods start (now, when its plan changes). */
  anchor?: string;
  /** The subscription this is news of, and when it happened. */
  of?: string;
  at?: string;
  /** A subscription that has ended. */
  ended?: string;
  sandbox?: boolean;
};

/** Changes the org's plan. What it had stays until it lapses. */
export async function changePlan(ctx: Context, fact: PlanFact): Promise<void> {
  const now = new Date().toISOString();
  const plan = await ensurePlan(ctx, now);
  const plans = ctx.as().db.collection<Plan>("billingPlan");
  if (fact.ended) {
    await plans.updateOne({ _id: "plan" }, { $addToSet: { ended: fact.ended } });
  }
  const ended = new Set([...(plan.ended ?? []), ...(fact.ended ? [fact.ended] : [])]);
  // News of a subscription that isn't its own now, or one that's over, leaves it as it is.
  const elsewhere = fact.of !== undefined && fact.of !== plan.subscription;
  const back = typeof fact.subscription === "string" && ended.has(fact.subscription);
  if (elsewhere || back) {
    await forget(ctx);
    return;
  }
  const stale = !!fact.at && !!plan.statusAt && fact.at < plan.statusAt && !fact.ended;
  const named = fact.name ? termsFor(ctx, fact.name) : undefined;
  const terms = fact.terms ?? named;
  if (fact.name && !terms) throw invalid(`There's no plan "${fact.name}".`);
  const moved = !!fact.name && fact.name !== plan.name;
  const unset = {
    ...(fact.seats === null ? { seats: "" } : {}),
    ...(fact.subscription === null ? { subscription: "" } : {}),
    ...(fact.status === null ? { status: "", statusAt: "" } : {}),
  };
  await plans.updateOne({ _id: "plan" }, {
    $set: {
      ...(fact.name ? { name: fact.name } : {}),
      ...(terms ? { terms } : {}),
      ...(fact.channel ? { channel: fact.channel } : {}),
      ...(fact.seller ? { seller: fact.seller } : {}),
      ...(fact.customer ? { customer: fact.customer } : {}),
      ...(fact.subscription ? { subscription: fact.subscription } : {}),
      ...(fact.status && !stale
        ? { status: fact.status, ...(fact.at ? { statusAt: fact.at } : {}) }
        : {}),
      ...(typeof fact.seats === "number" ? { seats: fact.seats } : {}),
      ...(fact.anchor || moved ? { anchor: fact.anchor ?? now } : {}),
      ...(fact.sandbox !== undefined ? { sandbox: fact.sandbox } : {}),
    },
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  });
  await forget(ctx);
}

/** A period someone paid for. */
export type PeriodFact = {
  plan: string;
  /** `YYYY-MM-DD`: its first day, and the first day its credits no longer count. */
  start: string;
  expires: string;
  seats: number;
  sandbox?: boolean;
};

/**
 * Its credits, as many as it paid for. For a plan a provider collects for, this
 * is when they come: the money first, so a card that fails gets none.
 */
export async function grantPeriod(ctx: Context, fact: PeriodFact): Promise<void> {
  const terms = settingsOf(ctx).plans[fact.plan];
  const credits = terms?.credits;
  const amount = (credits?.monthly ?? 0) + (credits?.perSeat ?? 0) * fact.seats;
  if (!amount) return;
  await ctx.as().db.collection<Credit>("credit").insertOne({
    _id: `plan:${fact.plan}:${fact.start}`,
    kind: "plan",
    amount,
    at: new Date().toISOString(),
    expires: fact.expires,
    note: terms.title,
    ...(fact.sandbox ? { sandbox: true } : {}),
  } as Credit);
  await forget(ctx);
}
