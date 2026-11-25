/**
 * What a computer the app keeps (a cloud computer: one with `status`) costs
 * the person asking (`computer.cost`): an hour awake at its size's price,
 * how long it stays awake after its last use, its disk a month, how far the
 * org plan's credits go at that, and, for one of theirs, what this month
 * came to so far. Nothing is priced here: the prices are the app's (the
 * `computerWake` resource's `prices` query), the credits its plan's (the
 * `planCredits` resource), the month the usage ledger's (meter `computer`,
 * tagged with the computer: the records counting seconds are its time
 * awake). A new one is priced at the first size offered.
 */
import type { ReadContext } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { ComputerWake } from "./wake.ts";

/** What `computerWake.prices` answers (a cloud plugin's sizes query may say more). */
export type ComputerPrices = {
  /** Each size offered: USD an hour awake, at the asker's prices; null when nothing prices it. */
  sizes: { id: string; hour: number | null }[];
  /** A computer's disk: its GB, and USD per GB-month; null when nothing prices it. */
  disk: { gb: number; gbMonth: number | null };
  /** How long one stays awake after its last use (minutes). */
  warmMinutes: number;
};

/** What a computer the app keeps costs the person asking; with no `computer`, a new one. */
export type ComputerCost = {
  /** USD an hour awake. */
  hour: number;
  /** Minutes it stays awake after its last use. */
  warmMinutes: number;
  /** USD a month for its disk, kept while it sleeps; null when nothing prices it. */
  diskMonth: number | null;
  /** How far the org plan's credits go at this price, after a month's disk: about `hours`. */
  covers?: { hours: number; amount: number; every: "once" | "month" };
  /** One of theirs: this month so far (from the 1st, UTC), its seconds awake and their price (USD). */
  month?: { seconds: number; price: number };
};

/** What the org's plan gives in credits, as the `planCredits` resource's Action answers. */
type Credits = { amount: number; every: "once" | "month" };

/** A total of the ledger, as `usage.totals` answers a person. */
type Total = { quantities: Record<string, number>; price: number };

/** About how many: exact under 20, then to the nearest 5, and the nearest 10 from 100. */
const about = (count: number) =>
  count < 20
    ? Math.floor(count)
    : count < 100
    ? Math.round(count / 5) * 5
    : Math.round(count / 10) * 10;

/** A named query's answer, or undefined when it can't be asked (nothing declares it). */
const asked = <T>(ctx: ReadContext, named: string, params: unknown) => {
  const at = named.lastIndexOf(".");
  return Promise.resolve()
    .then(() => ctx.db.collection(named.slice(0, at)).query<T>(named.slice(at + 1), params))
    .catch(() => undefined);
};

async function creditsOf(ctx: ReadContext): Promise<Credits | undefined> {
  const source = ctx.resources.planCredits as { action?: string } | undefined;
  if (!source?.action) return undefined;
  const credits = await ctx.call<Credits | null>(source.action, {}).catch(() => null);
  return credits && credits.amount > 0 ? credits : undefined;
}

/** This month so far, for `computer`: its seconds awake and their price; undefined without a ledger. */
async function monthOf(ctx: ReadContext, computer: string) {
  const since = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const totals = await asked<Total[]>(ctx, "usage.totals", {
    filter: { meter: "computer", "tags.computer": computer, at: { $gte: since } },
    by: ["subject"],
    units: ["seconds"],
  });
  if (!totals) return undefined;
  const awake = totals.filter((t) => (t.quantities.seconds ?? 0) > 0);
  return {
    seconds: awake.reduce((sum, t) => sum + t.quantities.seconds, 0),
    price: awake.reduce((sum, t) => sum + t.price, 0),
  };
}

/**
 * What `computer` (one of the asker's, as `computers` reaches them) costs,
 * or a new one; null when the app prices none, or it isn't one it keeps
 * at a size it prices.
 */
export async function costOf(
  ctx: ReadContext,
  computers: { findOne(filter: { _id: string }): Promise<Computer | null> },
  computer?: string,
): Promise<ComputerCost | null> {
  const named = (ctx.resources.computerWake as ComputerWake | undefined)?.prices;
  if (!named?.includes(".")) return null;
  const mine = computer ? await computers.findOne({ _id: computer }) : undefined;
  if (computer && !mine?.status) return null;
  const prices = await asked<ComputerPrices>(ctx, named, {});
  const size = mine ? prices?.sizes.find((s) => s.id === mine.status?.size) : prices?.sizes[0];
  if (!prices || typeof size?.hour !== "number") return null;
  const hour = size.hour;
  const diskMonth = prices.disk.gbMonth === null ? null : prices.disk.gb * prices.disk.gbMonth;
  const [credits, month] = await Promise.all([
    creditsOf(ctx),
    mine ? monthOf(ctx, mine._id) : undefined,
  ]);
  const left = (credits?.amount ?? 0) - (diskMonth ?? 0);
  const hours = hour > 0 ? about(left / hour) : 0;
  return {
    hour,
    warmMinutes: prices.warmMinutes,
    diskMonth,
    ...(credits && hours > 0
      ? { covers: { hours, amount: credits.amount, every: credits.every } }
      : {}),
    ...(month ? { month } : {}),
  };
}
