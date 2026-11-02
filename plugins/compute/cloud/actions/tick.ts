/**
 * `cloud.tick` `{ now? }`, each minute (a schedule; `now` for tests):
 *
 * 1. **Idle release:** an awake computer unused for `warmMinutes` (and woken
 *    at least that long ago) is released, unless a person has it open (up to
 *    `viewMinutes` past its last use) or a job it doesn't keep is still
 *    running on it (a long build). One that isn't connected is released too:
 *    its VM died. With an org that can't spend, each is released all the same:
 *    its jobs stop, its disk stays, and it wakes again once the org can spend.
 * 2. **Metering:** each computer still awake, its VM's seconds since last.
 * 3. **Leases:** the VMs its computers have (waking, awake or releasing) are
 *    still theirs (`pool.renew`): the pool deletes a VM nobody renews.
 * 4. **Clean-up:** a wake stuck for 10 minutes is ended (its VM, unrenewed,
 *    goes with its lease).
 *
 * The pools' sizes are the pool's (`pool.tick`). Each step's failures are
 * logged; the others go on. Answers what it released.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { CloudComputer } from "../contract.ts";
import { stopped } from "../shared/may.ts";
import { meterVm } from "../shared/meter.ts";
import { recordsOf } from "../shared/records.ts";
import { type CloudSettings, settingsOf } from "../shared/settings.ts";
import { after, between, minutes, nowOf } from "../shared/time.ts";

const log = (what: string) => (error: unknown) =>
  console.error(`cloud: ${what}:`, error instanceof Error ? error.message : error);

/** How long a wake may take before it's ended. */
const STUCK_MS = minutes(10);

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

    // 1. Idle ones go, together (each takes seconds).
    const awake = await records.find({ state: "awake" });
    const spent = awake.length ? await stopped(ctx) : undefined;
    const idle: CloudComputer[] = [];
    for (const rec of awake) if (spent || !await keeps(ctx, rec, now, set)) idle.push(rec);
    const released = await Promise.all(
      idle.map((rec) =>
        ctx.call<{ released: boolean }>("cloud.release", {
          computer: rec._id,
          now,
          // Idle unless it's used meanwhile; an org that can't spend, either way.
          ...(rec.used && !spent ? { used: rec.used } : {}),
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

    // 3. The VMs its computers have are still theirs.
    const vms = (await records.find({ state: { $in: ["waking", "awake", "releasing"] } }))
      .flatMap((rec) => rec.vm ? [rec.vm] : []);
    if (vms.length) {
      await ctx.call("pool.renew", { vms, now }).catch(log("renewing its VMs' leases"));
    }

    // 4. Stuck wakes end.
    for (
      const rec of await records.find({ state: "waking", woke: { $lt: after(now, -STUCK_MS) } })
    ) {
      // Its VM, if it took one, serves nobody now: unrenewed, the pool deletes it.
      await records.updateOne({ _id: rec._id, state: "waking" }, {
        $set: { state: rec.snapshot ? "cold" : "asleep" },
        $unset: { vm: "" },
      });
    }
    return { released: released.filter(Boolean) };
  },
});
