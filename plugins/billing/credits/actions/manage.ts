/**
 * Changing what an org has, each in person (never a key or an agent).
 *
 * Platform staff: `billing.setPlan`, `billing.grant` (gift credits, or take
 * some away), `billing.waive` (usage or seats, for a while or until lifted),
 * `billing.pay` (money that came in by hand). Recorded, so the log keeps who
 * did what. The org's owners and admins: `billing.budget` (its month's limit)
 * and `billing.redeem` (a gift code).
 *
 * `billing.apply`: for trusted code, what a payment provider says, called with
 * the provider's own id for it (`{ id: "stripe:evt_…" }`), so the same news
 * twice answers from the log.
 */
import {
  type Context,
  defineAction,
  failure,
  forbidden,
  inPerson,
  invalid,
  personOf,
} from "../../../../runtime/mod.ts";
import { runsOrg } from "../../../access/spaces/contract.ts";
import type { Credit } from "../collections/credit.ts";
import type { Plan } from "../collections/plan.ts";
import {
  changePlan,
  grantPeriod,
  pay,
  type PaymentFact,
  type PeriodFact,
  type PlanFact,
} from "../shared/apply.ts";
import { settingsOf } from "../shared/settings.ts";
import { endWaiver, ensurePlan, forget, planOf, refresh } from "../shared/standing.ts";

const DAY = "^\\d{4}-\\d{2}-\\d{2}$";

const staffOnly = (ctx: Context) => {
  if (ctx.actor?.staff !== true) throw forbidden("Only platform staff do this.");
};

async function runsIt(ctx: Context) {
  if (ctx.actor?.staff === true) return;
  const me = await ctx.call<{ role?: string | null }>("org.me", {});
  if (!runsOrg(me.role)) throw forbidden("Only the org's owners and admins do this.");
}

const by = (ctx: Context) => personOf(ctx.actor) ?? ctx.actor?.id;

const plans = (ctx: Context) => ctx.as().db.collection<Plan>("billingPlan");

const termsSchema = { type: "object" } as const;

export const setPlanAction = defineAction({
  description: "Puts the org on a plan, or a contract of its own terms",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      terms: termsSchema,
      seats: { type: ["integer", "null"], minimum: 0 },
      channel: { type: "string" },
      note: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    staffOnly(ctx);
    const { note: _note, ...fact } = input;
    // By hand now, whatever collected before: what it said of its payments no longer applies.
    await changePlan(ctx, {
      channel: "manual",
      status: null,
      subscription: null,
      ...fact,
    } as PlanFact);
    return {};
  },
});

export const grantAction = defineAction({
  description: "Gives the org credits, or takes some away",
  input: {
    type: "object",
    properties: {
      amount: { type: "number" },
      reason: { type: "string", minLength: 1 },
      expires: { type: "string", pattern: DAY },
    },
    required: ["amount", "reason"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    staffOnly(ctx);
    if (!input.amount) throw invalid("Say how much.");
    const now = new Date().toISOString();
    await ensurePlan(ctx, now);
    const id = await ctx.as().db.collection<Credit>("credit").insertOne({
      _id: `grant:${crypto.randomUUID()}`,
      kind: input.amount > 0 ? "gift" : "adjustment",
      amount: input.amount,
      at: now,
      reason: input.reason,
      ...(input.expires ? { expires: input.expires } : {}),
      ...(by(ctx) ? { by: by(ctx)! } : {}),
    });
    await forget(ctx);
    return { credit: id.insertedId };
  },
});

export const waiveAction = defineAction({
  description: "Waives the org's usage or seats, or lifts that",
  input: {
    type: "object",
    properties: {
      what: { type: "string", enum: ["usage", "seats"] },
      /** To stop waiving it. */
      lift: { type: "boolean" },
      reason: { type: "string", minLength: 1 },
      until: { type: "string" },
      people: { type: "array", items: { type: "string" } },
    },
    required: ["what"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    staffOnly(ctx);
    const now = new Date().toISOString();
    const plan = await ensurePlan(ctx, now);
    if (input.lift) {
      if (input.what === "usage") await endWaiver(ctx, plan, now);
      else await plans(ctx).updateOne({ _id: "plan" }, { $unset: { "waived.seats": "" } });
    } else {
      if (!input.reason) throw invalid("Say why it's waived.");
      if (input.until && input.until <= now) throw invalid("That's already past.");
      // Waiving usage again keeps when it began, so all of it is given back when it ends.
      const from = plan.waived?.[input.what]?.from ?? now;
      await plans(ctx).updateOne({ _id: "plan" }, {
        $set: {
          waived: {
            ...plan.waived,
            [input.what]: {
              from,
              reason: input.reason,
              ...(input.until ? { until: input.until } : {}),
              ...(by(ctx) ? { by: by(ctx)! } : {}),
              ...(input.what === "seats" && input.people?.length ? { people: input.people } : {}),
            },
          },
        },
      });
    }
    await forget(ctx);
    return {};
  },
});

const paymentProperties = {
  ref: { type: "string", minLength: 1 },
  amount: { type: "number" },
  currency: { type: "string", minLength: 3, maxLength: 3 },
  rate: { type: "number", exclusiveMinimum: 0 },
  fee: { type: "number", minimum: 0 },
  purpose: { type: "string", enum: ["seats", "credits", "contract", "refund"] },
  credits: { type: "number" },
  note: { type: "string" },
} as const;

export const payAction = defineAction({
  description: "Keeps money that came in by hand, and the credits it bought",
  input: {
    type: "object",
    properties: paymentProperties,
    required: ["ref", "amount", "currency", "purpose"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    staffOnly(ctx);
    await ensurePlan(ctx, new Date().toISOString());
    await pay(ctx, {
      channel: "manual",
      ...input,
      currency: input.currency.toLowerCase(),
      ...(by(ctx) ? { by: by(ctx)! } : {}),
    } as PaymentFact);
    return {};
  },
});

export const budgetAction = defineAction({
  description: "Sets the org's limit for a month, or removes it",
  input: {
    type: "object",
    properties: { usd: { type: ["number", "null"], minimum: 0 } },
    required: ["usd"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsIt(ctx);
    await ensurePlan(ctx, new Date().toISOString());
    await plans(ctx).updateOne({ _id: "plan" }, { $set: { budget: input.usd } });
    await forget(ctx);
    return { budget: input.usd };
  },
});

/** How an org claims a code from the directory (`hosts/orgs`). */
type Claiming = {
  claimCode?(code: string, person: string): Promise<{
    id: string;
    amount: number;
    expires?: string;
    note?: string;
  }>;
};

export const redeemAction = defineAction({
  description: "Adds a gift code's credits to the org",
  // A code is in no event.
  record: false,
  input: {
    type: "object",
    properties: { code: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["code"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsIt(ctx);
    const port = ctx.resources.directory as Claiming | undefined;
    if (!port?.claimCode) throw failure("no_codes", "This app doesn't take gift codes.");
    const person = by(ctx) ?? "";
    const claimed = await port.claimCode(input.code, person);
    const now = new Date().toISOString();
    await ensurePlan(ctx, now);
    // Claiming again for this org is the same code: the same `_id`, so it lands once.
    await ctx.as().db.collection<Credit>("credit").insertOne({
      _id: `gift:${claimed.id}`,
      kind: "gift",
      amount: claimed.amount,
      at: now,
      ...(claimed.expires ? { expires: claimed.expires } : {}),
      ...(claimed.note ? { note: claimed.note } : {}),
      ...(person ? { by: person } : {}),
    });
    await forget(ctx);
    return { amount: claimed.amount, ...(claimed.expires ? { expires: claimed.expires } : {}) };
  },
});

export const applyAction = defineAction({
  description: "What a payment provider says: a payment, or a plan changed",
  input: {
    type: "object",
    properties: {
      payment: { type: "object" },
      plan: { type: "object" },
      period: { type: "object" },
    },
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    await ensurePlan(ctx, new Date().toISOString());
    if (input.plan) await changePlan(ctx, input.plan as PlanFact);
    if (input.payment) await pay(ctx, input.payment as PaymentFact);
    if (input.period) await grantPeriod(ctx, input.period as PeriodFact);
    return {};
  },
});

export const planAction = defineAction({
  description: "The org's plan, started if it hasn't one",
  record: false,
  input: { type: "object", additionalProperties: false },
  run: (ctx) => ensurePlan(ctx, new Date().toISOString()),
});

export const settleAction = defineAction({
  description: "Writes what's come due: the trial, this period's credits, a waiver that ended",
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    // Nothing starts for an org until something needs it, nor with limits off.
    if (!settingsOf(ctx).enforce || !await planOf(ctx)) return {};
    await refresh(ctx, ctx.scheduled?.at ?? new Date().toISOString());
    return {};
  },
});
