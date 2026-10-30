/**
 * Usage across an org, for those who run it, where the app serves many orgs.
 * `usage.totals` gives a person their own usage; these give an org's owners
 * and admins (and platform staff) everyone's, after asking the org who's
 * calling (spaces' `org.me`). Anyone else gets their own, as `usage.totals`
 * gives it. Each says whose it is (`all`).
 *
 * - `usage.org`: totals as `usage.totals` sums them (`{ filter, by, units }`):
 *   by day, person (`tags.person`), agent (`tags.agent`), model (`subject`).
 * - `usage.calls`: the latest uses, newest first (`{ filter, limit }`).
 *
 * Both only read, so neither is recorded.
 */
import { type Context, defineAction, type Filter } from "../../../../runtime/mod.ts";
import type { UsageRecord } from "../collections/usage.ts";
import { rollupsOf } from "../shared/settings.ts";
import { totals, UNITS } from "../shared/totals.ts";
import { personOf } from "../shared/use.ts";

const forbidden = (message: string) => Object.assign(new Error(message), { code: "forbidden" });

/** Whether the caller runs the org: an owner or an admin there, or platform staff. */
async function runsOrg(ctx: Context): Promise<boolean> {
  const me = await ctx.call<{ role?: string | null; staff?: boolean }>("org.me", {})
    // An app without org roles has nobody who runs one.
    .catch(() => undefined);
  return !!me && (me.staff === true || me.role === "owner" || me.role === "admin");
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
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const all = await runsOrg(ctx);
    const person = personOf(ctx.actor);
    if (!all && !person) throw forbidden("Only people see usage.");
    // The ledger is read as the system: everyone's once the org says they run it, else theirs.
    const system = ctx.as();
    const asked = (input.filter ?? {}) as Filter;
    return {
      totals: await totals(
        system.db.collection<UsageRecord>("usage"),
        {
          filter: all ? asked : { ...asked, "tags.person": person! },
          by: input.by ?? [],
          units: input.units ?? UNITS,
        },
        { db: system.db, rollups: rollupsOf(ctx) },
      ),
      all,
    };
  },
});

export const usageCallsAction = defineAction({
  description:
    "The latest uses (model calls and the rest), newest first: everyone's for the org's " +
    "owners and admins, your own for others",
  record: false,
  input: {
    type: "object",
    properties: {
      filter,
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const all = await runsOrg(ctx);
    const person = personOf(ctx.actor);
    if (!all && !person) throw forbidden("Only people see usage.");
    const asked = (input.filter ?? {}) as Filter;
    const found = await ctx.as().db.collection<UsageRecord>("usage").find(
      // Uses only (adjustments correct a rating; they aren't calls); yours unless you run it.
      { ...asked, kind: { $exists: false }, ...(all ? {} : { "tags.person": person! }) },
      { sort: { at: -1 }, limit: input.limit ?? 20 },
    );
    return {
      calls: found.map((r) => ({
        _id: r._id,
        meter: r.meter,
        subject: r.subject,
        quantities: r.quantities,
        ...(r.tags ? { tags: r.tags } : {}),
        ...(r.cost !== undefined ? { cost: r.cost } : {}),
        ...(r.unpriced?.length ? { unpriced: r.unpriced } : {}),
        at: r.at,
      })),
      all,
    };
  },
});
