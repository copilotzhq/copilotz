/**
 * What people see of where the org stands.
 *
 * - `billing.state` `{}`: for the Billing section. Its people see whether work
 *   can go on and why not; its owners and admins, the plan, balance, month,
 *   credits and payments; platform staff, also the plans there are to set.
 *   With limits off (`enforce`), only staff see anything, and nothing starts.
 * - `billing.notice` `{}`: what to say above the composer, if anything: that
 *   the org can't spend (to everyone), or is running low (to those who can act
 *   on it).
 *
 * Both only read and settle what's due, so neither is recorded.
 */
import { type Context, defineAction, people } from "../../../../runtime/mod.ts";
import { runsOrg } from "../../../access/spaces/contract.ts";
import type { Payment } from "../collections/payment.ts";
import { settingsOf } from "../shared/settings.ts";
import { NO_LIMIT, refresh, rooms, seatsOf, standingOf, verdictOf } from "../shared/standing.ts";

async function sight(ctx: Context) {
  const me = await ctx.call<{ role?: string | null; staff?: boolean }>("org.me", {})
    .catch(() => undefined);
  const staff = me?.staff === true || ctx.actor?.staff === true;
  return { staff, runs: staff || runsOrg(me?.role) };
}

export const stateAction = defineAction({
  description: "Where the org stands: whether it can spend; its plan and credits for who runs it",
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => {
    const { staff, runs } = await sight(ctx);
    const set = settingsOf(ctx);
    const now = new Date().toISOString();
    if (!set.enforce && !staff) return { on: false, runs, staff };
    const room = set.enforce ? await refresh(ctx, now) : undefined;
    const verdict = room ? verdictOf(room) : { ok: true as const };
    if (!runs) return { on: true, runs, staff, ...verdict };
    const s = await standingOf(ctx, now);
    const seats = s.plan ? await seatsOf(ctx, s.plan) : undefined;
    const payments = await ctx.as().db.collection<Payment>("payment").find({}, {
      sort: { at: -1 },
      limit: 50,
    });
    const low = !!room && (
      (room.lowCredits !== undefined && room.credits < room.lowCredits) ||
      (room.lowBudget !== undefined && room.budget < room.lowBudget)
    );
    return {
      on: set.enforce,
      runs,
      staff,
      ...verdict,
      low,
      plan: s.plan && {
        name: s.plan.name,
        terms: s.plan.terms,
        since: s.plan.since,
        channel: s.plan.channel,
        ...(s.plan.status ? { status: s.plan.status } : {}),
        ...(s.plan.customer ? { customer: s.plan.customer } : {}),
        ...(s.plan.subscription ? { subscription: s.plan.subscription } : {}),
        ...(typeof s.plan.seats === "number" ? { fixedSeats: s.plan.seats } : {}),
        ...(s.plan.waived ? { waived: s.plan.waived } : {}),
      },
      ...(seats !== undefined ? { seats } : {}),
      ...(s.period ? { period: s.period } : {}),
      balance: s.walked.balance,
      buckets: s.walked.buckets,
      debt: s.walked.debt,
      waived: s.waivedUsage,
      month: s.month,
      history: s.history.slice(0, 100),
      payments,
      ...(staff ? { plans: set.plans } : {}),
    };
  },
});

export const noticeAction = defineAction({
  description: "What to say above the composer about what the org can spend, if anything",
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => {
    if (!settingsOf(ctx).enforce) return null;
    const now = new Date().toISOString();
    const kept = await rooms(ctx).findOne({ _id: "room" });
    const room = kept && now < kept.until ? kept : await refresh(ctx, now);
    const { runs } = await sight(ctx);
    const verdict = verdictOf(room);
    if (!verdict.ok) return { tone: "stop", why: verdict.why, text: verdict.message, runs };
    if (!runs) return null;
    if (room.lowCredits !== undefined && room.credits < room.lowCredits) {
      return { tone: "low", why: "credits", left: Math.max(room.credits, 0), runs };
    }
    if (
      room.lowBudget !== undefined && room.budget < room.lowBudget && room.budget < NO_LIMIT
    ) {
      return { tone: "low", why: "budget", left: Math.max(room.budget, 0), runs };
    }
    return null;
  },
});
