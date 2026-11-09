/**
 * The check, for whatever's about to spend (the `spending` resource names
 * these). All answer `{ ok }`, or `{ ok: false, why, message }`.
 *
 * - `billing.check` `{ purpose? }`: before a model call, a wake, a build. It
 *   reads `room`, which costs no database read. Memory can only say yes: when
 *   `room` is spent, or stale, what's due is written and it's worked out
 *   again from what's kept before anyone's stopped.
 * - `billing.may` `{}`: the same, for a read (the sizes on offer), which can't
 *   write: without a fresh `room` it says yes, and the real thing decides.
 * - `billing.spent` `{ price }`: the ledger, as it records a use: its price
 *   comes off `room`, in memory, before the record goes.
 * - `billing.priceList` `{}`: the list the org's plan names, for rating.
 * - `billing.tier` `{}`: the model tier the org's plan gives its agents (the
 *   `planTier` resource), or null: the plan it's on, or the one it would start
 *   on. A plan's terms are copied when an org moves to it; terms kept from
 *   before plans named a tier say what the app's plan of that name says now.
 */
import { defineAction } from "copilotz";
import { settingsOf } from "../shared/settings.ts";
import { planOf, refresh, rooms, type Verdict, verdictOf } from "../shared/standing.ts";

const OK: Verdict = { ok: true };

export const checkAction = defineAction({
  description: "Whether the org can spend now, and why not",
  record: false,
  input: {
    type: "object",
    properties: { purpose: { type: "string" } },
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const set = settingsOf(ctx);
    if (!set.enforce || (input.purpose && set.free.includes(input.purpose))) return OK;
    const now = new Date().toISOString();
    const room = await rooms(ctx).findOne({ _id: "room" });
    if (room && now < room.until && verdictOf(room).ok) return OK;
    try {
      return verdictOf(await refresh(ctx, now));
    } catch (error) {
      // Called from a read, which can't write: what's there answers, and nothing there says yes.
      if ((error as Error).message === "Queries are read-only") return room ? verdictOf(room) : OK;
      throw error;
    }
  },
});

export const mayAction = defineAction({
  description: "Whether the org can spend now, as far as a read can tell",
  record: false,
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    if (!settingsOf(ctx).enforce) return OK;
    const room = await rooms(ctx).findOne({ _id: "room" });
    return room && new Date().toISOString() < room.until ? verdictOf(room) : OK;
  },
});

export const spentAction = defineAction({
  description: "Takes a use's price off what the org can still spend",
  record: false,
  input: {
    type: "object",
    properties: { price: { type: "number" } },
    required: ["price"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    if (!settingsOf(ctx).enforce) return;
    await rooms(ctx).updateOne({ _id: "room" }, {
      $inc: { credits: -input.price, budget: -input.price },
    }).catch((error) => {
      // A use recorded from a read: its record goes, and the next working-out counts it.
      if ((error as Error).message !== "Queries are read-only") throw error;
    });
  },
});

export const priceListAction = defineAction({
  description: "The price list the org's plan names",
  record: false,
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => (await planOf(ctx))?.terms.prices ?? null,
});

export const tierAction = defineAction({
  description: "The model tier the org's plan gives its agents",
  record: false,
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    const set = settingsOf(ctx);
    const plan = await planOf(ctx);
    return plan?.terms.models ?? set.plans[plan?.name ?? set.start]?.models ?? null;
  },
});
