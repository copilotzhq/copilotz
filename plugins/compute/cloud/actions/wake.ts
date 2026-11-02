/**
 * `cloud.wake` `{ computer }`: a cloud computer, awake (run as the system;
 * the computers plugin calls it before work goes to a computer that's
 * offline, through the `computerWake` resource). Answers `{ state: "awake" }`
 * once it's connected, or null when it isn't a cloud computer.
 *
 * - Awake and connected: at once. Awake but not connected: a moment for it
 *   to come back, else its VM died: it's released by force, and woken anew.
 * - Waking or releasing: it waits for that to end, then goes on from there.
 * - Asleep or cold: this call wakes it (only one call does). Cold, its disk
 *   is made from its snapshot first. Then the pool gives it a VM of its size
 *   in its placement (`pool.take`), its disk is attached, and the VM is told
 *   to serve it (`pool.serve`), connecting to the app at its address (its
 *   org's): the first time, to format the disk and connect with a one-time
 *   code, as a person's computer would. Once it's connected, it's awake.
 * - Failing, the VM goes (`pool.drop`), the computer is back asleep (or
 *   cold), and the call fails saying why.
 * - An org that can't spend (the `spending` resource) doesn't wake one: the
 *   call fails saying so, before anything's touched.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { CloudComputer, PoolAssign, PoolTake } from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { stopped } from "../shared/may.ts";
import { meterStorage } from "../shared/meter.ts";
import { deviceOf } from "../shared/names.ts";
import { computerOf, onlineOf, recordsOf } from "../shared/records.ts";
import { appOf } from "../shared/settings.ts";
import { poll } from "../shared/time.ts";

/** How long a call waits for a wake or release already under way. */
const SETTLE_MS = 240_000;
/** How long its record has to say it's online, once its VM serves it. */
const CONNECT_MS = 60_000;
/** How long an awake computer that isn't connected has to come back before its VM is taken for dead. */
const BACK_MS = 15_000;

const failure = (message: string, code = "failed") => Object.assign(new Error(message), { code });

/** What a pool VM's answer says went wrong, if it does. */
const failedIn = (answer: unknown) => {
  const error = (answer as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  return error && typeof error.message === "string"
    ? failure(error.message, String(error.code ?? "failed"))
    : undefined;
};

const log = (what: string) => (error: unknown) =>
  console.error(`cloud: ${what}:`, error instanceof Error ? error.message : error);

export const wakeAction = defineAction({
  input: {
    type: "object",
    properties: { computer: { type: "string" } },
    required: ["computer"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const records = recordsOf(ctx);
    for (let round = 0; round < 6; round++) {
      const rec = await records.findOne({ _id: input.computer });
      if (!rec) return null;
      if (rec.state === "awake") {
        const back = await poll(
          async () => await onlineOf(ctx, rec._id) || undefined,
          BACK_MS,
          { signal: ctx.signal },
        );
        if (back) return { state: "awake" };
        // Its VM died (or doesn't answer): released by force, then woken on another.
        await ctx.call("cloud.release", { computer: rec._id, force: true });
        continue;
      }
      if (rec.state === "waking" || rec.state === "releasing") {
        const settled = await poll(
          async () => {
            const now = await records.findOne({ _id: rec._id });
            return !now || now.state !== rec.state ? true : undefined;
          },
          SETTLE_MS,
          { every: 500, signal: ctx.signal },
        );
        if (!settled) {
          throw failure("The computer is still waking: try again in a minute.", "waking");
        }
        continue;
      }
      const no = await stopped(ctx);
      if (no) throw failure(`The computer can't wake. ${no.message}`, no.why);
      // Asleep or cold: this call wakes it, unless another took it first.
      const { modifiedCount } = await records.updateOne(
        { _id: rec._id, state: rec.state },
        { $set: { state: "waking", woke: new Date().toISOString() } },
      );
      if (modifiedCount) return await wakeNow(ctx, rec);
    }
    throw failure("The computer couldn't wake: it kept changing. Try again.", "busy");
  },
});

/** Wakes one this call has claimed (it's `waking`), from asleep or cold. */
async function wakeNow(ctx: Context, rec: CloudComputer) {
  const records = recordsOf(ctx);
  const host = await hostFor(ctx, rec.placement);
  let vm: string | undefined;
  try {
    if (rec.state === "cold" && rec.snapshot) {
      await host.restore(rec.placement, rec.snapshot, rec.disk, rec.diskGb);
      // Its snapshot's time is metered as a snapshot's; from here, as a disk's.
      await meterStorage(ctx, rec, new Date().toISOString());
      await host.deleteSnapshot(rec.placement, rec.snapshot)
        .catch(log(`deleting ${rec.snapshot} once restored`));
      await records.updateOne({ _id: rec._id }, { $unset: { snapshot: "" } });
    }
    const take: PoolTake = { placement: rec.placement, size: rec.size, computer: rec._id };
    vm = (await ctx.call<{ vm: string }>("pool.take", take)).vm;
    await records.updateOne({ _id: rec._id }, { $set: { vm } });
    const device = deviceOf(rec._id);
    const seen = await host.attach(rec.placement, vm, rec.disk, device);
    // The first wake formats its disk and connects with a code; one told its secret already
    // (a first wake that failed late) has its state on its disk.
    let code: string | undefined;
    if (!rec.ready) {
      code = await ctx.call<{ code: string }>("computer.enrollment", { computer: rec._id })
        .then((r) => r.code, (error) => {
          if ((error as { code?: string }).code === "enrolled") return undefined;
          throw error;
        });
    }
    const name = (await computerOf(ctx, rec._id))?.name;
    const app = appOf(ctx.resources);
    const assign: PoolAssign = {
      computer: rec._id,
      device: seen || `/dev/disk/by-id/google-${device}`,
      ...(name ? { name } : {}),
      ...(code ? { format: true, code } : {}),
      ...(app ? { app } : {}),
    };
    const answer = await ctx.call("pool.serve", { vm, assign });
    const error = failedIn(answer);
    if (error) throw error;
    const online = await poll(
      async () => await onlineOf(ctx, rec._id) || undefined,
      CONNECT_MS,
      { signal: ctx.signal },
    );
    if (!online) throw failure("it didn't connect within a minute");
    const now = new Date().toISOString();
    await records.updateOne({ _id: rec._id }, {
      $set: { state: "awake", vm, woke: now, used: now, metered: now, ready: true },
    });
    return { state: "awake" as const };
  } catch (error) {
    if (vm) {
      // Taken: it served this computer (or nearly), so it goes.
      await host.detach(rec.placement, vm, rec.disk, true).catch(() => {});
      await ctx.call("pool.drop", { vm, placement: rec.placement })
        .catch(log(`deleting ${vm} after a failed wake`));
    }
    const now = await records.findOne({ _id: rec._id });
    await records.updateOne({ _id: rec._id }, {
      $set: { state: now?.snapshot ? "cold" : "asleep" },
      $unset: { vm: "" },
    });
    const message = error instanceof Error ? error.message : String(error);
    throw failure(`The computer couldn't wake: ${message}`, (error as { code?: string }).code);
  }
}
