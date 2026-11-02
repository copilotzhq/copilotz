/**
 * Whether the person asking may make a cloud computer now, and why not: anyone
 * in the org but its guests, while it can spend. Cost is kept by what the org
 * may spend (the `spending` resource: its credits and budget, when the app has
 * them), not by who's asking.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { standingOf } from "./people.ts";

export type May = { create: boolean; why?: "guests" | "credits" | "budget"; message?: string };

type Spending = { check?: string; may?: string };
type Verdict = { ok: boolean; why?: "credits" | "budget"; message?: string };

/**
 * Why the org can't spend now, or nothing. `check`: from work about to spend,
 * which can write what's due first; `may`: from a read, which can't.
 */
export async function stopped(ctx: Context, ask: "check" | "may" = "check"): Promise<
  { why: "credits" | "budget"; message: string } | undefined
> {
  const action = (ctx.resources.spending as Spending | undefined)?.[ask];
  if (!action) return undefined;
  const verdict = await ctx.as().call<Verdict>(action, {});
  return verdict.ok ? undefined : {
    why: verdict.why ?? "credits",
    message: verdict.message ?? "This org can't spend right now.",
  };
}

export async function mayCreate(ctx: Context, ask: "check" | "may" = "may"): Promise<May> {
  const me = await standingOf(ctx);
  if (!me.staff && (!me.role || me.role === "guest")) return { create: false, why: "guests" };
  const no = await stopped(ctx, ask);
  return no ? { create: false, ...no } : { create: true };
}
