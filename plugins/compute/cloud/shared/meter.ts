/**
 * Cloud computers' use, in the usage ledger (`usage.record`, meter
 * `computer`), when the app has one: a VM's seconds by size, from when it
 * was last metered; a disk's or a snapshot's GB-hours, from when its storage
 * was. Each moves its mark first (only one caller meters a stretch), then
 * records it. An app without the billing plugin records nothing; any other
 * failure is logged, and that stretch isn't recorded again.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { type CloudComputer, SUBJECTS } from "../contract.ts";
import { recordsOf, still } from "./records.ts";
import { after, between, LEASE_MS } from "./time.ts";

export type CloudUse = {
  subject: string;
  quantities: Record<string, number>;
  tags: Record<string, string>;
  at: string;
};

export async function meter(ctx: Context, use: CloudUse): Promise<void> {
  if (!Object.values(use.quantities).some((n) => n > 0)) return;
  try {
    await ctx.call("usage.record", { meter: "computer", ...use });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Unknown action "usage.record"')) return;
    console.error(`cloud: couldn't record ${use.subject} for ${use.tags.computer}:`, message);
  }
}

const tagsOf = (rec: CloudComputer) => ({ computer: rec._id, person: rec.owner });

/**
 * A VM's whole seconds from its mark (`metered`, else when it woke) to `now`;
 * the mark moves by as much, so the part of a second left counts next time.
 * Ticks come each minute while its org is open. A longer gap means they
 * stopped (the org closed), and nobody renewed its VM's lease then, so it's
 * counted to the lease's end at most, and the mark moves to `now`.
 * `state`: only while it's still so (awake, for a tick; releasing, for a release).
 */
export async function meterVm(
  ctx: Context,
  rec: CloudComputer,
  now: string,
  state: CloudComputer["state"],
): Promise<void> {
  const from = rec.metered ?? rec.woke;
  if (!from) return;
  const gap = between(from, now);
  const lapsed = gap > LEASE_MS;
  const seconds = Math.floor((lapsed ? LEASE_MS : gap) / 1000);
  if (seconds <= 0) return;
  const { modifiedCount } = await recordsOf(ctx).updateOne(
    { _id: rec._id, state, ...still("metered", rec.metered) },
    { $set: { metered: lapsed ? now : after(from, seconds * 1000) } },
  );
  if (!modifiedCount) return;
  await meter(ctx, {
    subject: SUBJECTS.vm(rec.size),
    quantities: { seconds },
    tags: tagsOf(rec),
    at: now,
  });
}

/**
 * Its storage's GB-hours from its mark (`stored`, else when it was made) to
 * `now`: its disk's, or its snapshot's while it's cold (its disk's size, as
 * an estimate).
 */
export async function meterStorage(ctx: Context, rec: CloudComputer, now: string): Promise<void> {
  const from = rec.stored ?? rec.at;
  const hours = between(from, now) / 3_600_000;
  if (hours <= 0) return;
  const { modifiedCount } = await recordsOf(ctx).updateOne(
    { _id: rec._id, ...still("stored", rec.stored) },
    { $set: { stored: now } },
  );
  if (!modifiedCount) return;
  await meter(ctx, {
    subject: rec.state === "cold" ? SUBJECTS.snapshot : SUBJECTS.disk,
    quantities: { gbHours: Math.round(rec.diskGb * hours * 1e6) / 1e6 },
    tags: tagsOf(rec),
    at: now,
  });
}
