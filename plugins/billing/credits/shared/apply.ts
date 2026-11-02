/**
 * What comes from outside, whoever collected it: a payment, or a plan changed.
 * A person acting by hand and a payment provider's webhook both land here, so
 * the rest never knows the difference.
 */
import { type Context, invalid } from "../../../../runtime/mod.ts";
import type { Credit } from "../collections/credit.ts";
import type { Payment } from "../collections/payment.ts";
import type { Plan } from "../collections/plan.ts";
import { settingsOf } from "./settings.ts";
import { ensurePlan, forget } from "./standing.ts";

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
  at?: string;
};

/** Keeps a payment, and the credits it bought (taken back, for a refund). Once per `channel:ref`. */
export async function pay(ctx: Context, fact: PaymentFact): Promise<void> {
  const at = fact.at ?? new Date().toISOString();
  const id = `${fact.channel}:${fact.ref}`;
  const system = ctx.as();
  await system.db.collection<Payment>("payment").insertOne({ ...fact, _id: id, at } as Payment);
  if (fact.credits) {
    await system.db.collection<Credit>("credit").insertOne({
      _id: `purchase:${id}`,
      kind: fact.credits > 0 ? "purchase" : "adjustment",
      amount: round(fact.credits),
      at,
      ...(fact.note ? { note: fact.note } : {}),
      ...(fact.by ? { by: fact.by } : {}),
    });
  }
  await forget(ctx);
}

export type PlanFact = {
  /** One of the app's plans, or a contract's own name with its `terms`. */
  name?: string;
  terms?: Plan["terms"];
  seats?: number | null;
  channel?: string;
  customer?: string;
  subscription?: string;
  status?: string;
  /** Where its periods start (now, when its plan changes). */
  anchor?: string;
};

/** Changes the org's plan. What it had stays until it lapses; its new credits come at the next check. */
export async function changePlan(ctx: Context, fact: PlanFact): Promise<void> {
  const now = new Date().toISOString();
  const plan = await ensurePlan(ctx, now);
  const named = fact.name ? settingsOf(ctx).plans[fact.name] : undefined;
  const terms = fact.terms ?? named;
  if (fact.name && !terms) throw invalid(`There's no plan "${fact.name}".`);
  const moved = !!fact.name && fact.name !== plan.name;
  await ctx.as().db.collection<Plan>("billingPlan").updateOne({ _id: "plan" }, {
    $set: {
      ...(fact.name ? { name: fact.name } : {}),
      ...(terms ? { terms } : {}),
      ...(fact.channel ? { channel: fact.channel } : {}),
      ...(fact.customer ? { customer: fact.customer } : {}),
      ...(fact.subscription ? { subscription: fact.subscription } : {}),
      ...(fact.status ? { status: fact.status } : {}),
      ...(typeof fact.seats === "number" ? { seats: fact.seats } : {}),
      ...(fact.anchor || moved ? { anchor: fact.anchor ?? now } : {}),
    },
    ...(fact.seats === null ? { $unset: { seats: "" } } : {}),
  });
  await forget(ctx);
}
