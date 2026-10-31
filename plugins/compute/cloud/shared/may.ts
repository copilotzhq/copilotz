/**
 * Whether the person asking may make a cloud computer now, and why not: the
 * org's owners and admins (and platform staff) may, its members too when the
 * settings say (`create: "members"`), and anyone in their own personal org;
 * and only while the org's cloud spend this month is under its budget
 * (`budgetUsd`), when it has one.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { runs, standingOf } from "./people.ts";
import { settingsOf } from "./settings.ts";

export type May = { create: boolean; why?: "admins" | "budget" };

/** What cloud computers have cost the org this month, at their price (none without a ledger). */
async function spent(ctx: Context, now: string): Promise<number> {
  const totals = await ctx.as().db.collection("usage").query<{ price?: number }[]>("totals", {
    filter: { meter: "computer", at: { $gte: `${now.slice(0, 7)}-01T00:00:00.000Z` } },
    by: [],
  }).catch(() => []);
  return totals.reduce((sum, t) => sum + (t.price ?? 0), 0);
}

export async function mayCreate(ctx: Context): Promise<May> {
  const set = settingsOf(ctx);
  const me = await standingOf(ctx);
  const personal = (ctx.resources.org as { kind?: string } | undefined)?.kind === "personal";
  const may = runs(me) || (set.create === "members" && me.role !== "guest") ||
    (personal && me.role === "owner");
  if (!may) return { create: false, why: "admins" };
  if (set.budgetUsd !== undefined && await spent(ctx, new Date().toISOString()) >= set.budgetUsd) {
    return { create: false, why: "budget" };
  }
  return { create: true };
}
