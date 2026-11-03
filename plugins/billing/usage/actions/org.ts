/**
 * Usage across an org, for those who run it, where the app serves many orgs.
 * `usage.totals` gives a person their own usage; these give an org's owners
 * and admins (and platform staff) everyone's, after asking the org who's
 * calling (spaces' `org.me`). Anyone else gets their own, as `usage.totals`
 * gives it. Each says whose it is (`all`).
 *
 * - `usage.org`: totals as `usage.totals` sums them (`{ filter, by, units }`):
 *   by day or month, category (agents, computers, apps), space
 *   (`tags.space`), person (`tags.person`), agent (`tags.agent`), model
 *   (`subject`); with the names of what it groups by, where the caller
 *   reaches them (`names`: a space's, say).
 * - `usage.activity` (activity.ts): the latest things done, newest first.
 *
 * People see prices: what they're charged. What it cost (and so the margin)
 * only platform staff see; each says whether it shows them (`costs`). Both
 * only read, so neither is recorded.
 */
import {
  type Context,
  defineAction,
  type Filter,
  forbidden,
  people,
  personOf,
} from "../../../../runtime/mod.ts";
import type { UsageRecord } from "../collections/usage.ts";
import { named } from "../shared/names.ts";
import { categoriesOf, rollupsOf } from "../shared/settings.ts";
import { priceOnly, totals, UNITS } from "../shared/totals.ts";
import { runsOrg } from "../../../access/spaces/contract.ts";

/**
 * What the caller sees: everyone's (`all`) when they run the org (an owner or
 * an admin there, or platform staff), and costs only as staff. Anyone else
 * sees their own: `mine` is the filter that keeps them to it.
 */
export async function sight(
  ctx: Context,
): Promise<{ all: boolean; costs: boolean; mine: Filter }> {
  const me = await ctx.call<{ role?: string | null; staff?: boolean }>("org.me", {})
    // An app without org roles has nobody who runs one.
    .catch(() => undefined);
  const staff = me?.staff === true;
  const all = staff || runsOrg(me?.role);
  const person = personOf(ctx.actor);
  if (!all && !person) throw forbidden("Only people see usage.");
  return { all, costs: staff, mine: all ? {} : { "tags.person": person! } };
}

const filter = { type: "object" } as const;

export const orgUsageAction = defineAction({
  description: "Usage totals across the whole org, for its owners and admins; your own for others",
  record: false,
  input: {
    type: "object",
    properties: {
      filter,
      by: { type: "array", items: { type: "string" } },
      units: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const { all, costs, mine } = await sight(ctx);
    // The ledger is read as the system: everyone's once the org says they run it, else theirs.
    const system = ctx.as();
    const by = input.by ?? [];
    const found = await totals(
      system.db.collection<UsageRecord>("usage"),
      { filter: { ...(input.filter ?? {}) as Filter, ...mine }, by, units: input.units ?? UNITS },
      { db: system.db, rollups: rollupsOf(ctx), categories: categoriesOf(ctx) },
    );
    // What it's grouped by, named as the caller reads it.
    const names = await named(
      ctx,
      Object.fromEntries(by.map((field) => [field, found.map((t) => t.key[field])])),
    );
    return { totals: costs ? found : found.map(priceOnly), all, costs, names };
  },
});
