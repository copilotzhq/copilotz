/**
 * Where an org stands: its plan, credits and spending worked out from what's
 * kept, what's due written, and `room`, the short form every check reads.
 *
 * `settle` writes what's come due, and only it does: the trial, this period's
 * credits, a waiver that ended. Each has an `_id` of its own, so running it
 * twice changes nothing.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Credit } from "../collections/credit.ts";
import type { Plan } from "../collections/plan.ts";
import type { Room } from "../collections/room.ts";
import { settingsOf } from "./settings.ts";
import { monthOf, periodOf, walk, type Walked } from "./walk.ts";

/** What stands for "no limit" in `room`: taking prices off it never gets near zero. */
export const NO_LIMIT = 1e15;
const HOUR = 3_600_000;
const PLAN = "plan";
const ROOM = "room";

const plans = (ctx: Context) => ctx.as().db.collection<Plan>("billingPlan");
const credits = (ctx: Context) => ctx.as().db.collection<Credit>("credit");
export const rooms = (ctx: Context) => ctx.as().db.collection<Room>("billingRoom");

export const planOf = (ctx: Context) => plans(ctx).findOne({ _id: PLAN });

/**
 * The org's plan, started on the app's first one the first time it's needed. A
 * trial is one a person: the personal org they get once. A team's starts without.
 * While limits are off, its clock doesn't start (`counting`).
 */
export async function ensurePlan(ctx: Context, now: string): Promise<Plan> {
  const had = await planOf(ctx);
  if (had) return had;
  const set = settingsOf(ctx);
  const first = set.plans[set.start] ?? { title: set.start };
  const team = (ctx.resources.org as { kind?: string } | undefined)?.kind === "team";
  const { once: _once, ...kept } = first.credits ?? {};
  const plan = {
    _id: PLAN,
    name: set.start,
    terms: team && first.credits ? { ...first, credits: kept } : first,
    since: now,
    anchor: now,
    channel: "manual",
    ...(set.enforce ? { counting: true } : {}),
    at: now,
  };
  try {
    await plans(ctx).insertOne(plan);
  } catch (error) {
    // Another executor made it just now; else it's that it can't be written from here.
    const found = await planOf(ctx);
    if (found) return found;
    throw error;
  }
  return plan as Plan;
}

/** People who count as seats: the org's, guests apart. An app without org roles has one. */
export const seatsOf = async (ctx: Context, plan: Plan): Promise<number> =>
  plan.seats ??
    await ctx.as().call<number>("org.seats", {}).catch(() => 1);

/** What's been charged by day since `from`, and before `to` if it says (USD). */
async function chargedByDay(ctx: Context, from: string, to?: string) {
  const totals = await ctx.as().db.collection("usage").query<
    { key: { day: string }; price?: number }[]
  >("totals", { filter: { at: { $gte: from, ...(to ? { $lt: to } : {}) } }, by: ["day"] });
  return Object.fromEntries(totals.map((t) => [t.key.day, t.price ?? 0]));
}

/** What counts of what it was given: from a test mode, not once the app is live. */
const counted = (ctx: Context, history: Credit[]) =>
  settingsOf(ctx).live ? history.filter((c) => !c.sandbox) : history;

/**
 * A usage waiver's end: what it let through is given back, so it doesn't count
 * afterwards. Not what was charged, but what the balance lost by it: credits that
 * would have lapsed anyway aren't given back for good.
 */
export async function endWaiver(ctx: Context, plan: Plan, at: string): Promise<void> {
  const waived = plan.waived?.usage;
  if (!waived) return;
  const history = counted(ctx, await credits(ctx).find({}));
  const spent = await chargedByDay(ctx, plan.since);
  const from = waived.from > plan.since ? waived.from : plan.since;
  const during = await chargedByDay(ctx, from, at);
  const without = Object.fromEntries(
    Object.entries(spent).map(([day, price]) => [day, price - (during[day] ?? 0)]),
  );
  const today = at.slice(0, 10);
  const amount = walk(history, without, today).balance - walk(history, spent, today).balance;
  if (amount > 0) {
    await credits(ctx).insertOne({
      _id: `waived:${waived.from}`,
      kind: "waived",
      amount: Math.round(amount * 1e8) / 1e8,
      at,
      note: "Usage waived",
      reason: waived.reason,
      ...(waived.by ? { by: waived.by } : {}),
    } as Credit);
  }
  await plans(ctx).updateOne({ _id: PLAN }, { $unset: { "waived.usage": "" } });
}

/** Writes what's come due. */
export async function settle(ctx: Context, now: string): Promise<Plan> {
  let plan = await ensurePlan(ctx, now);
  // Limits have just come on for it: what it used before they did doesn't count.
  if (!plan.counting) {
    await plans(ctx).updateOne({ _id: PLAN }, { $set: { since: now, counting: true } });
    plan = (await planOf(ctx))!;
  }
  const kept = new Set((await credits(ctx).find({})).map((c) => c._id));
  const grant = async (
    doc: { _id: string; kind: Credit["kind"]; amount: number; expires?: string; note?: string },
  ) => {
    if (kept.has(doc._id) || !doc.amount) return;
    kept.add(doc._id);
    await credits(ctx).insertOne({ at: now, ...doc } as Credit);
  };
  const terms = plan.terms.credits;
  if (terms?.once) {
    await grant({ _id: "trial", kind: "trial", amount: terms.once, note: plan.terms.title });
  }
  // A plan a provider collects for gets its credits when a period is paid for (`grantPeriod`).
  const byHand = !plan.channel || plan.channel === "manual";
  if (byHand && (terms?.monthly || terms?.perSeat)) {
    const period = periodOf(plan.anchor, now);
    const id = `plan:${plan.name}:${period.start}`;
    if (!kept.has(id)) {
      const seats = terms.perSeat ? await seatsOf(ctx, plan) : 0;
      await grant({
        _id: id,
        kind: "plan",
        amount: (terms.monthly ?? 0) + (terms.perSeat ?? 0) * seats,
        expires: period.end,
        note: plan.terms.title,
      });
    }
  }
  const until = plan.waived?.usage?.until;
  if (until && until <= now) {
    await endWaiver(ctx, plan, until);
    plan = (await planOf(ctx))!;
  }
  return plan;
}

export type Standing = {
  plan: Plan | null;
  walked: Walked;
  history: Credit[];
  /** Spent this month, and the month's limit (none: no limit). */
  month: { start: string; end: string; spent: number; limit?: number };
  /** This period, on a plan with periods. */
  period?: { start: string; end: string };
  waivedUsage: boolean;
};

/**
 * The month's limit: what its people chose; none if they chose none; else what
 * its plan starts with, so a team's grows with its seats and doesn't stop it with
 * credits left; else the app's.
 */
async function limitOf(ctx: Context, plan: Plan): Promise<number | undefined> {
  if (plan.budget === null) return undefined;
  if (typeof plan.budget === "number") return plan.budget;
  const perSeat = plan.terms.budget?.perSeat;
  if (perSeat) return perSeat * await seatsOf(ctx, plan);
  return settingsOf(ctx).budget;
}

/** Where the org stands now, from what's kept. */
export async function standingOf(ctx: Context, now: string): Promise<Standing> {
  const plan = await planOf(ctx);
  const history = counted(ctx, await credits(ctx).find({}, { sort: { at: -1 } }));
  const today = now.slice(0, 10);
  const month = monthOf(now);
  // Not started yet (limits off): nothing has counted.
  const spent = plan?.counting ? await chargedByDay(ctx, plan.since) : {};
  const limit = plan ? await limitOf(ctx, plan) : undefined;
  const usageWaiver = plan?.waived?.usage;
  return {
    plan,
    walked: walk(history, spent, today),
    history,
    month: {
      ...month,
      spent: Object.entries(spent).filter(([day]) => day >= month.start)
        .reduce((sum, [, price]) => sum + price, 0),
      ...(limit !== undefined ? { limit } : {}),
    },
    ...(plan && (plan.terms.credits?.monthly || plan.terms.credits?.perSeat)
      ? { period: periodOf(plan.anchor, now) }
      : {}),
    waivedUsage: !!usageWaiver && (!usageWaiver.until || usageWaiver.until > now),
  };
}

/** The soonest a date changes what `room` should say. */
function untilOf(standing: Standing, now: string): string {
  const days = [
    standing.month.end,
    standing.period?.end,
    ...standing.walked.buckets.map((bucket) => bucket.expires),
  ].filter((day): day is string => !!day).map((day) => `${day}T00:00:00.000Z`);
  const times = [
    ...days,
    standing.plan?.waived?.usage?.until,
    new Date(new Date(now).getTime() + HOUR).toISOString(),
  ].filter((at): at is string => !!at);
  return times.sort()[0];
}

/** `room`, worked out from where it stands. */
function roomFrom(ctx: Context, standing: Standing, now: string): Room {
  const { warnAt } = settingsOf(ctx);
  const { limit, spent } = standing.month;
  const granted = standing.walked.buckets.reduce((sum, bucket) => sum + bucket.amount, 0);
  return {
    _id: ROOM,
    credits: standing.waivedUsage ? NO_LIMIT : standing.walked.balance,
    budget: limit === undefined ? NO_LIMIT : limit - spent,
    ...(limit !== undefined ? { limit, lowBudget: limit * (1 - warnAt) } : {}),
    ...(standing.waivedUsage ? {} : { lowCredits: granted * (1 - warnAt) }),
    until: untilOf(standing, now),
  };
}

/** Settles, works out `room` again, and keeps it. */
export async function refresh(ctx: Context, now: string): Promise<Room> {
  await settle(ctx, now);
  const room = roomFrom(ctx, await standingOf(ctx, now), now);
  await rooms(ctx).replaceOne({ _id: ROOM }, room, { upsert: true });
  return room;
}

/** Something changed what's left: the next check works it out again. */
export const forget = (ctx: Context) => rooms(ctx).deleteOne({ _id: ROOM });

export type Verdict = { ok: true } | { ok: false; why: "credits" | "budget"; message: string };

const usd = (amount: number) => `$${amount % 1 ? amount.toFixed(2) : amount}`;

/** Where it's changed, as a link where the words are shown as a message. */
const BILLING = "[Billing](/org?tab=billing)";

/** What a check answers for `room`, in the words people see when it stops them. */
export function verdictOf(room: Room): Verdict {
  if (room.credits <= 0) {
    return {
      ok: false,
      why: "credits",
      message: `This org is out of credits. Its owners and admins can add more in ${BILLING}.`,
    };
  }
  if (room.budget <= 0) {
    const limit = room.limit !== undefined ? `its ${usd(room.limit)} budget` : "its budget";
    return {
      ok: false,
      why: "budget",
      message:
        `This org has reached ${limit} for the month. Its owners and admins can raise it in ${BILLING}.`,
    };
  }
  return { ok: true };
}
