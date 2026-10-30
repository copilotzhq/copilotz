/**
 * `cloud.tick` `{ now? }`, each minute (a schedule; `now` for tests):
 *
 * 1. **Idle release:** an awake computer unused for `warmMinutes` (and woken
 *    at least that long ago) is released, unless a person has it open (up to
 *    `viewMinutes` past its last use) or a job it doesn't keep is still
 *    running on it (a long build). One that isn't connected is released too:
 *    its VM died.
 * 2. **Metering:** each computer still awake, its VM's seconds since last.
 * 3. **Pool sizing:** each placement's pool of each size is asked to keep
 *    the floor for this hour (in its time zone) plus the wakes of the last 2
 *    minutes (those expected before a replacement is ready), up to `max`.
 * 4. **Clean-up:** VMs gone for 10 minutes are forgotten; a VM serving no
 *    computer any more (its deletion failed) is deleted again; a wake stuck
 *    for 10 minutes is ended.
 *
 * Each step's failures are logged; the others go on. Answers what it did.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { CloudComputer } from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { meterVm } from "../shared/meter.ts";
import { poolsOf, recordsOf } from "../shared/records.ts";
import { type CloudSettings, type Floor, samePlace, settingsOf } from "../shared/settings.ts";
import { after, between, hourIn, minutes, nowOf } from "../shared/time.ts";

const log = (what: string) => (error: unknown) =>
  console.error(`cloud: ${what}:`, error instanceof Error ? error.message : error);

/** How far back wakes count toward the pool: about as long as a replacement VM takes. */
const WAKES_MS = minutes(2);
/** How long a VM that went is remembered, and how long a wake may take before it's ended. */
const GONE_MS = minutes(10);

/** A job as a computer lists it (the computers plugin's `computer.running`). */
type Running = { jobs: { keep?: boolean }[] };

/** Why an awake computer stays awake now, or undefined: it's idle. */
async function keeps(
  ctx: Context,
  rec: CloudComputer,
  now: string,
  set: CloudSettings,
): Promise<string | undefined> {
  const warm = minutes(set.warmMinutes);
  const used = rec.used ?? rec.woke ?? rec.at;
  if (between(rec.woke ?? rec.at, now) < warm) return "woke";
  if (between(used, now) < warm) return "used";
  if (
    rec.viewed && between(rec.viewed, now) < warm &&
    between(used, now) < minutes(set.viewMinutes)
  ) return "viewed";
  try {
    const { jobs } = await ctx.call<Running>("computer.running", { computer: rec._id });
    if (jobs.some((job) => !job.keep)) return "jobs";
  } catch (error) {
    // Not connected: its VM died, so it's released. Anything else: it's asked again next time.
    if ((error as { code?: string }).code !== "offline") {
      log(`asking ${rec._id} what it runs`)(error);
      return "unknown";
    }
  }
  return undefined;
}

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

export const tickAction = defineAction({
  input: {
    type: "object",
    properties: { now: { type: "string" } },
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const now = nowOf(ctx, input.now);
    const set = settingsOf(ctx);
    const records = recordsOf(ctx);
    const pools = poolsOf(ctx);

    // 1. Idle ones go, together (each takes seconds).
    const awake = await records.find({ state: "awake" });
    const idle: CloudComputer[] = [];
    for (const rec of awake) if (!await keeps(ctx, rec, now, set)) idle.push(rec);
    const released = await Promise.all(
      idle.map((rec) =>
        ctx.call<{ released: boolean }>("cloud.release", {
          computer: rec._id,
          now,
          ...(rec.used ? { used: rec.used } : {}),
        }).then((r) => r.released ? rec._id : undefined, (error) => {
          log(`releasing ${rec._id}`)(error);
          return undefined;
        })
      ),
    );

    // 2. What's still awake, metered to now.
    for (const rec of await records.find({ state: "awake" })) {
      await meterVm(ctx, rec, now, "awake").catch(log(`metering ${rec._id}`));
    }

    // 3. Each pool, the size it should be now.
    const recent = await records.find({ woke: { $gte: after(now, -WAKES_MS) } });
    const sized: Record<string, number> = {};
    for (const placement of set.placements) {
      for (const size of Object.keys(set.sizes)) {
        try {
          const wakes = recent.filter((r) => r.size === size && samePlace(r.placement, placement));
          const desired = Math.min(
            set.pool.max,
            floorAt(set.pool.floor, placement.zone, size, now) + wakes.length,
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

    // 4. VMs gone a while are forgotten; VMs serving nobody are deleted again; stuck wakes end.
    await pools.deleteMany({ state: "gone", seen: { $lt: after(now, -GONE_MS) } });
    for (const vm of await pools.find({ state: "assigned" })) {
      const rec = vm.computer ? await records.findOne({ _id: vm.computer }) : null;
      if (rec && (rec.vm === vm._id || rec.state === "waking")) continue;
      const host = await hostFor(ctx, vm.placement);
      await host.deleteVm(vm.placement, vm._id)
        .then(() => pools.updateOne({ _id: vm._id }, { $set: { state: "gone", seen: now } }))
        .catch(log(`deleting ${vm._id}, which serves nobody`));
    }
    for (
      const rec of await records.find({ state: "waking", woke: { $lt: after(now, -GONE_MS) } })
    ) {
      // Its VM, if it took one, serves nobody now: the next tick deletes it.
      await records.updateOne({ _id: rec._id, state: "waking" }, {
        $set: { state: rec.snapshot ? "cold" : "asleep" },
        $unset: { vm: "" },
      });
    }
    return { released: released.filter(Boolean), pools: sized };
  },
});
