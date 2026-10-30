/**
 * `cloud.daily` `{ now? }`, once a day (a schedule; `now` for tests):
 *
 * 1. **Storage metering:** each computer's disk GB-hours since last
 *    (`diskGb` × hours), or its snapshot's while it's cold (`diskGb` as the
 *    estimate).
 * 2. **Cold:** an asleep computer unused for `coldDays` has its disk
 *    snapshotted, then deleted: it's cold, and its next wake makes the disk
 *    again from the snapshot. While that happens it's `releasing`, so a wake
 *    waits for it.
 *
 * Answers how many it metered and which went cold.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { CloudComputer } from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { meterStorage } from "../shared/meter.ts";
import { snapshotOf } from "../shared/names.ts";
import { recordsOf, still } from "../shared/records.ts";
import { settingsOf } from "../shared/settings.ts";
import { between, nowOf } from "../shared/time.ts";

const log = (what: string) => (error: unknown) =>
  console.error(`cloud: ${what}:`, error instanceof Error ? error.message : error);

const DAY_MS = 86_400_000;

/** Its disk becomes a snapshot, unless it was used (or woken) since it was read. */
async function freeze(ctx: Context, rec: CloudComputer, now: string): Promise<boolean> {
  const records = recordsOf(ctx);
  const { modifiedCount } = await records.updateOne(
    { _id: rec._id, state: "asleep", ...still("used", rec.used) },
    { $set: { state: "releasing" } },
  );
  if (!modifiedCount) return false;
  const host = await hostFor(ctx, rec.placement);
  const snapshot = snapshotOf(rec._id, now);
  let made = false;
  try {
    await host.snapshot(rec.placement, rec.disk, snapshot);
    made = true;
    await host.deleteDisk(rec.placement, rec.disk);
  } catch (error) {
    // Its disk is still what it is: asleep, as it was.
    if (made) {
      await host.deleteSnapshot(rec.placement, snapshot).catch(log(`deleting ${snapshot}`));
    }
    await records.updateOne({ _id: rec._id }, { $set: { state: "asleep" } });
    throw error;
  }
  await records.updateOne({ _id: rec._id }, { $set: { state: "cold", snapshot } });
  return true;
}

export const dailyAction = defineAction({
  input: {
    type: "object",
    properties: { now: { type: "string" } },
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const now = nowOf(ctx, input.now);
    const set = settingsOf(ctx);
    const all = await recordsOf(ctx).find({});
    for (const rec of all) {
      await meterStorage(ctx, rec, now).catch(log(`metering ${rec._id}'s storage`));
    }
    const cold: string[] = [];
    for (const rec of all) {
      if (rec.state !== "asleep" || between(rec.used ?? rec.at, now) < set.coldDays * DAY_MS) {
        continue;
      }
      const done = await freeze(ctx, rec, now).catch((error) => {
        log(`making ${rec._id} cold`)(error);
        return false;
      });
      if (done) cold.push(rec._id);
    }
    return { metered: all.length, cold };
  },
});
