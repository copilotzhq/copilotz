/**
 * Pool VMs connecting (the `pool` worker kind, plugin `cloudPool`), run as
 * the system:
 *
 * - `pool.admit`: who one is, from its credential (`pool:<credential>`:
 *   the host's verify gets `<credential>`, `gce:<jwt>` or `local:<token>`), as
 *   the host verifies it: a VM of a placement the app has, in one of its
 *   sizes' pools, never taken: one that's new, free, or free and went
 *   (`gone` with no computer). A VM serving a computer (assigned) connects
 *   again as itself (its socket dropped: Cloud Run ends them hourly), still
 *   that computer's: an agent with root on it, minting its identity tokens,
 *   can only pose as that same VM, never given another computer, and only
 *   ever told to stop serving its own. Once told to stop (`released`), or
 *   gone after serving one, it never is again. Answers `{ id: vm }`, or
 *   null.
 * - `pool.ready` / `pool.gone`: it's connected (free, unless it serves a
 *   computer: it stays assigned), or it went (gone, unless it serves one:
 *   that computer's own connection says whether it's alive).
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Placement } from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { poolsOf as pools } from "../shared/records.ts";
import { audienceOf, placeKey, samePlace, settingsOf } from "../shared/settings.ts";

/** The size whose pool in this placement has `vm`, if any does. */
async function sizeOf(ctx: Context, placement: Placement, vm: string) {
  const host = await hostFor(ctx, placement);
  for (const size of Object.keys(settingsOf(ctx).sizes)) {
    const { vms } = await host.pool(placement, size);
    if (vms.includes(vm)) return size;
  }
  return undefined;
}

/** A VM came or went: seen now, and free or gone unless it serves a computer (it stays its). */
async function seen(ctx: Context, vm: string, state: "free" | "gone") {
  const now = new Date().toISOString();
  const { matchedCount } = await pools(ctx).updateOne(
    { _id: vm, computer: { $exists: false } },
    { $set: { state, seen: now } },
  );
  if (!matchedCount) await pools(ctx).updateOne({ _id: vm }, { $set: { seen: now } });
  return null;
}

export const poolAdmitAction = defineAction({
  input: {
    type: "object",
    properties: { secret: { type: "string" } },
    required: ["secret"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const set = settingsOf(ctx);
    // Each account's host is asked once; the first that knows the VM says who it is.
    const accounts = new Map(set.placements.map((p) => [p.account ?? "", p]));
    const audience = audienceOf(ctx);
    let who: { vm: string; placement: Placement } | null = null;
    for (const placement of accounts.values()) {
      const host = await hostFor(ctx, placement);
      who = await host.verify(input.secret, audience).catch(() => null);
      if (who) break;
    }
    if (!who || !set.placements.some((p) => samePlace(p, who!.placement))) return null;
    const known = await pools(ctx).findOne({ _id: who.vm });
    if (known && placeKey(known.placement) !== placeKey(who.placement)) return null;
    // Serving its computer, it's let in again as itself (out of its pool now), until it's released.
    if (known?.state === "assigned") return known.released ? null : { id: who.vm };
    // Gone after serving a computer whose agents may have been root on it: never again.
    if (known?.computer) return null;
    // Still in its pool (a VM taken from it isn't, even once forgotten here).
    const size = await sizeOf(ctx, who.placement, who.vm);
    if (!size || (known && known.size !== size)) return null;
    const now = new Date().toISOString();
    if (!known) {
      // Not connected yet: `ready` makes it free.
      await pools(ctx).insertOne({
        _id: who.vm,
        placement: who.placement,
        size,
        state: "gone",
        at: now,
        seen: now,
      });
    }
    return { id: who.vm };
  },
});

export const poolReadyAction = defineAction({
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: (ctx, input) => seen(ctx, input.id, "free"),
});

export const poolGoneAction = defineAction({
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: (ctx, input) => seen(ctx, input.id, "gone"),
});
