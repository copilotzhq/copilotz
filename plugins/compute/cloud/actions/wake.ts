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
 *   is made from its snapshot first. Then a free VM of its size in its
 *   placement is taken (none free: its pool grows by one, and it waits for
 *   that VM), its disk is attached, and the VM is told to serve it
 *   (`pool.assign`): the first time, to format the disk and connect with a
 *   one-time code, as a person's computer would. Once it's connected, it's
 *   awake.
 * - Failing, the VM goes (or goes back, if it was never taken), the computer
 *   is back asleep (or cold), and the call fails saying why.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import {
  type CloudComputer,
  type CloudHost,
  POOL,
  POOL_KIND,
  type PoolAssign,
} from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { meterStorage } from "../shared/meter.ts";
import { deviceOf } from "../shared/names.ts";
import { computerOf, onlineOf, poolsOf, recordsOf } from "../shared/records.ts";
import { samePlace } from "../shared/settings.ts";
import { poll } from "../shared/time.ts";

/** How long a call waits for a wake or release already under way. */
const SETTLE_MS = 240_000;
/**
 * How long a VM has to serve it (`pool.assign` answers once the computer's
 * connected: up to a minute for the disk to appear, formatting, up to a
 * minute to connect), and then how long its record has to say it's online.
 */
const ASSIGN_MS = 150_000;
const CONNECT_MS = 60_000;
/** How long a wake waits for a VM when none was free. */
const VM_MS = 150_000;
/** How long an awake computer that isn't connected has to come back before its VM is taken for dead. */
const BACK_MS = 15_000;

/** `pool.assign`'s input; the first wake's code too (the computer connects with it). */
type Assign = PoolAssign & { code?: string };

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
  const pools = poolsOf(ctx);
  const host = await hostFor(ctx, rec.placement);
  let vm: string | undefined;
  let taken = false;
  try {
    if (rec.state === "cold" && rec.snapshot) {
      await host.restore(rec.placement, rec.snapshot, rec.disk, rec.diskGb);
      // Its snapshot's time is metered as a snapshot's; from here, as a disk's.
      await meterStorage(ctx, rec, new Date().toISOString());
      await host.deleteSnapshot(rec.placement, rec.snapshot)
        .catch(log(`deleting ${rec.snapshot} once restored`));
      await records.updateOne({ _id: rec._id }, { $unset: { snapshot: "" } });
    }
    vm = await takeVm(ctx, host, rec);
    await records.updateOne({ _id: rec._id }, { $set: { vm } });
    await host.take(rec.placement, rec.size, vm);
    taken = true;
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
    const assign: Assign = {
      computer: rec._id,
      device: seen || `/dev/disk/by-id/google-${device}`,
      ...(name ? { name } : {}),
      ...(code ? { format: true, code } : {}),
    };
    const answer = await ctx.workers.call(POOL_KIND, vm, POOL.assign, assign, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ASSIGN_MS)]),
    });
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
    if (vm && !taken) {
      // Never taken from its pool: free again, for another wake.
      await pools.updateOne(
        { _id: vm, computer: rec._id },
        { $set: { state: "free" }, $unset: { computer: "" } },
      ).catch(log(`freeing ${vm}`));
    } else if (vm) {
      // Taken: it served this computer (or nearly), so it goes.
      await host.detach(rec.placement, vm, rec.disk, true).catch(() => {});
      await host.deleteVm(rec.placement, vm)
        .then(() => pools.updateOne({ _id: vm }, { $set: { state: "gone" } }))
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

/**
 * A free VM of its size in its placement, taken for it (only one wake takes
 * each). None free: its pool grows by one, and it waits for one to connect.
 */
async function takeVm(ctx: Context, host: CloudHost, rec: CloudComputer): Promise<string> {
  const pools = poolsOf(ctx);
  const claim = async () => {
    const free = await pools.find({ state: "free", size: rec.size }, { sort: { at: 1 } });
    for (const vm of free.filter((v) => samePlace(v.placement, rec.placement))) {
      const { modifiedCount } = await pools.updateOne(
        { _id: vm._id, state: "free" },
        { $set: { state: "assigned", computer: rec._id } },
      );
      if (modifiedCount) return vm._id;
    }
    return undefined;
  };
  const found = await claim();
  if (found) return found;
  const { target } = await host.pool(rec.placement, rec.size);
  await host.resize(rec.placement, rec.size, target + 1);
  const started = await poll(claim, VM_MS, { every: 500, signal: ctx.signal });
  if (!started) throw failure(`no VM was free, and none started within ${VM_MS / 1000} s`);
  return started;
}
