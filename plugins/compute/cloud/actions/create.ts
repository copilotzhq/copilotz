/**
 * `cloud.create` `{ size, in?, name? }`: a cloud computer for the person
 * asking, in a space they may work in (their Personal space unless they
 * say), shared into others as any computer is. Who may: the org's owners and
 * admins (and platform staff), its members too when the settings say
 * (`create: "members"`), and anyone in their own personal org; and only
 * while the org's cloud spend this month is under its budget (`budgetUsd`),
 * when it has one. Its record and secret are made directly (`computer.provision`),
 * then its disk, in the first placement; its first wake formats it. Answers
 * `{ computer }`.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import { hostFor } from "../shared/host.ts";
import { diskOf } from "../shared/names.ts";
import { forbidden, invalid, runs, standingOf } from "../shared/people.ts";
import { recordsOf } from "../shared/records.ts";
import { settingsOf } from "../shared/settings.ts";

/** What cloud computers have cost the org this month, at their price (none without a ledger). */
async function spent(ctx: Context, now: string): Promise<number> {
  const totals = await ctx.as().db.collection("usage").query<{ price?: number }[]>("totals", {
    filter: { meter: "computer", at: { $gte: `${now.slice(0, 7)}-01T00:00:00.000Z` } },
    by: [],
  }).catch(() => []);
  return totals.reduce((sum, t) => sum + (t.price ?? 0), 0);
}

export const createAction = defineAction({
  description: "Makes a cloud computer, in a space (your Personal space unless you say)",
  input: {
    type: "object",
    properties: {
      size: { type: "string" },
      in: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 100 },
    },
    required: ["size"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const set = settingsOf(ctx);
    const size = set.sizes[input.size];
    if (!size) {
      throw invalid(`No size "${input.size}": ${Object.keys(set.sizes).join(", ") || "none"}`);
    }
    const me = await standingOf(ctx);
    const personal = (ctx.resources.org as { kind?: string } | undefined)?.kind === "personal";
    const may = runs(me) || (set.create === "members" && me.role !== "guest") ||
      (personal && me.role === "owner");
    if (!may) throw forbidden("Only the org's owners and admins make cloud computers here.");
    const now = new Date().toISOString();
    if (set.budgetUsd !== undefined && await spent(ctx, now) >= set.budgetUsd) {
      throw Object.assign(
        new Error("This month's budget for cloud computers is spent: no more can be made."),
        { code: "budget" },
      );
    }
    const placement = set.placements[0];
    if (!placement) throw invalid("The app has no placement for cloud computers.");
    const host = await hostFor(ctx, placement);
    const owner = ctx.actor!.id;
    const { id } = await ctx.call<{ id: string }>("computer.provision", {
      owner,
      name: input.name ?? `${size.label} cloud computer`,
      ...(input.in ? { in: input.in } : {}),
    });
    const disk = diskOf(id);
    try {
      await host.createDisk(placement, disk, set.diskGb);
    } catch (error) {
      // No disk, no computer.
      await ctx.as().call("computer.forget", { computer: id });
      throw error;
    }
    await recordsOf(ctx).insertOne({
      _id: id,
      owner,
      size: input.size,
      placement,
      disk,
      diskGb: set.diskGb,
      state: "asleep",
      ready: false,
      stored: now,
      at: now,
    });
    return { computer: id };
  },
});
