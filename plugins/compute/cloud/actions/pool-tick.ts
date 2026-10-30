/**
 * `pool.tick` `{ now? }`, each minute where the pools are (plugin
 * `cloudPool`; a schedule; `now` for tests):
 *
 * 1. **Sizing:** each placement's pool of each size is asked to keep the
 *    floor for this hour (in its time zone) plus the VMs taken in the last 2
 *    minutes (those expected before a replacement is ready), up to `max`.
 * 2. **Leases:** a VM given to a computer whose lease ran out (nobody renewed
 *    it: its computer was released and the VM's deletion failed, a wake
 *    ended halfway, the runtime that took it is gone) is deleted. Its disk
 *    stays: disks are never deleted with a VM. Its computer, if it still
 *    thinks it's awake, wakes again on another.
 * 3. **Clean-up:** VMs gone for 10 minutes are forgotten.
 *
 * Each step's failures are logged; the others go on. Answers the pools'
 * sizes and the VMs whose lease ran out.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { hostFor } from "../shared/host.ts";
import { poolsOf } from "../shared/records.ts";
import { type Floor, samePlace, settingsOf } from "../shared/settings.ts";
import { after, hourIn, minutes, nowOf } from "../shared/time.ts";
import { LEASE_MS } from "./vms.ts";

const log = (what: string) => (error: unknown) =>
  console.error(`cloud pool: ${what}:`, error instanceof Error ? error.message : error);

/** How far back takes count toward the pool: about as long as a replacement VM takes. */
const TAKES_MS = minutes(2);
/** How long a VM that went is remembered. */
const GONE_MS = minutes(10);

/** A pool's floor now: the largest count of the floors that apply to it at this hour, else 0. */
export function floorAt(floors: Floor[], zone: string, size: string, now: string): number {
  let count = 0;
  for (const f of floors) {
    if ((f.size && f.size !== size) || (f.zone && f.zone !== zone)) continue;
    const hour = hourIn(now, f.tz);
    const within = f.from <= f.to ? hour >= f.from && hour < f.to : hour >= f.from || hour < f.to;
    if (within) count = Math.max(count, f.count);
  }
  return count;
}

export const poolTickAction = defineAction({
  input: {
    type: "object",
    properties: { now: { type: "string" } },
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const now = nowOf(ctx, input.now);
    const set = settingsOf(ctx);
    const pools = poolsOf(ctx);

    // 1. Each pool, the size it should be now.
    const recent = await pools.find({ taken: { $gte: after(now, -TAKES_MS) } });
    const sized: Record<string, number> = {};
    for (const placement of set.placements) {
      for (const size of Object.keys(set.sizes)) {
        try {
          const takes = recent.filter((vm) =>
            vm.size === size && samePlace(vm.placement, placement)
          );
          const desired = Math.min(
            set.pool.max,
            floorAt(set.pool.floor, placement.zone, size, now) + takes.length,
          );
          const host = await hostFor(ctx, placement);
          const { target } = await host.pool(placement, size);
          if (target !== desired) await host.resize(placement, size, desired);
          sized[`${placement.zone}/${size}`] = desired;
        } catch (error) {
          log(`sizing ${placement.zone}'s ${size} pool`)(error);
        }
      }
    }

    // 2. VMs whose lease ran out go.
    const lapsed: string[] = [];
    for (const vm of await pools.find({ state: "assigned" })) {
      if ((vm.until ?? after(vm.taken ?? vm.at, LEASE_MS)) > now) continue;
      console.error(
        `cloud pool: ${vm._id}'s lease ran out (${vm.computer ?? "no computer"}${
          vm.org ? ` of ${vm.org}` : ""
        }): deleting it`,
      );
      try {
        const host = await hostFor(ctx, vm.placement);
        await host.deleteVm(vm.placement, vm._id);
        await pools.updateOne({ _id: vm._id }, { $set: { state: "gone", seen: now } });
        lapsed.push(vm._id);
      } catch (error) {
        log(`deleting ${vm._id}`)(error);
      }
    }

    // 3. VMs gone a while are forgotten.
    await pools.deleteMany({ state: "gone", seen: { $lt: after(now, -GONE_MS) } });
    return { pools: sized, lapsed };
  },
});
