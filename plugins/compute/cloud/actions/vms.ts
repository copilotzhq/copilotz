/**
 * The pool's VMs, given to computers (plugin `cloudPool`; run as the system,
 * by the cloud plugin wherever its computers are, or through `remotePool`):
 *
 * - `pool.take` `{ placement, size, computer, org? }` → `{ vm }`: a free VM
 *   of that size in that placement, claimed for the computer (only one take
 *   claims each), then taken out of its pool, which makes another. None
 *   free: the pool grows by one, and it waits for that VM. It's leased for
 *   `LEASE_MS`, renewed while the computer uses it (`pool.renew`). Failing
 *   before it's out of its pool, the VM is free again.
 * - `pool.serve` `{ vm, assign, org? }` → the VM's answer to `pool.assign`
 *   (it answers once the computer runs, or says why it couldn't).
 * - `pool.stop` `{ vm, computer, org? }` → its answer to `pool.release`, or
 *   `{ error }` when it gives none in time. Only its own computer's; from
 *   then on (`released`), the VM never connects again.
 * - `pool.drop` `{ vm, placement?, org? }`: the VM is deleted (its disks,
 *   attached or not, stay: they're never deleted with it), and gone.
 * - `pool.renew` `{ vms, org?, now? }`: the leases of those it gave go on.
 *
 * With `org` (an app of many orgs: `remotePool` adds it), only a VM taken
 * for that org is served, stopped, dropped or renewed.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import {
  POOL,
  POOL_KIND,
  type PoolAssign,
  type PoolRelease,
  type PoolTake,
  type PoolVm,
} from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { poolsOf, wantsOf } from "../shared/records.ts";
import { samePlace } from "../shared/settings.ts";
import { after, minutes, nowOf, poll } from "../shared/time.ts";

/** How long a VM given to a computer is its without a renewal. */
export const LEASE_MS = minutes(10);
/** How long a take waits for a VM when none was free. */
export const VM_MS = 150_000;
/**
 * How long a VM has to serve a computer (it answers once the computer's
 * connected: up to a minute for the disk to appear, formatting, up to a
 * minute to connect), and to stop serving it.
 */
const ASSIGN_MS = 150_000;
const RELEASE_MS = 90_000;

const failure = (message: string, code = "failed") => Object.assign(new Error(message), { code });

const placement = {
  type: "object",
  properties: {
    account: { type: "string" },
    project: { type: "string" },
    zone: { type: "string" },
  },
  required: ["project", "zone"],
  additionalProperties: false,
} as const;

/** The VM, assigned, when it's the org's (any org's without one). */
async function givenOf(ctx: Context, vm: string, org?: string): Promise<PoolVm> {
  const found = await poolsOf(ctx).findOne({ _id: vm });
  if (!found || (org !== undefined && found.org !== org)) {
    throw failure(`No such VM: ${vm}`, "not_found");
  }
  return found;
}

export const takeAction = defineAction({
  input: {
    type: "object",
    properties: {
      placement,
      size: { type: "string" },
      computer: { type: "string" },
      org: { type: "string" },
    },
    required: ["placement", "size", "computer"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const want = input as PoolTake;
    const pools = poolsOf(ctx);
    const host = await hostFor(ctx, want.placement);
    const claim = async () => {
      const free = await pools.find({ state: "free", size: want.size }, { sort: { at: 1 } });
      for (const vm of free.filter((v) => samePlace(v.placement, want.placement))) {
        const now = new Date().toISOString();
        const { modifiedCount } = await pools.updateOne(
          { _id: vm._id, state: "free" },
          {
            $set: {
              state: "assigned",
              computer: want.computer,
              ...(want.org !== undefined ? { org: want.org } : {}),
              taken: now,
              until: after(now, LEASE_MS),
            },
          },
        );
        if (modifiedCount) return vm._id;
      }
      return undefined;
    };
    let vm = await claim();
    if (!vm) {
      // Its pool grows by one for it; until the take ends, the pool's sizing counts it.
      const { insertedId: wanted } = await wantsOf(ctx).insertOne({
        placement: want.placement,
        size: want.size,
        computer: want.computer,
        at: new Date().toISOString(),
      });
      try {
        const { target } = await host.pool(want.placement, want.size);
        await host.resize(want.placement, want.size, target + 1);
        vm = await poll(claim, VM_MS, { every: 500, signal: ctx.signal });
      } finally {
        await wantsOf(ctx).deleteOne({ _id: wanted }).catch(() => {});
      }
      if (!vm) throw failure(`no VM was free, and none started within ${VM_MS / 1000} s`);
    }
    try {
      await host.take(want.placement, want.size, vm);
    } catch (error) {
      // Still in its pool: free again, for another take.
      await pools.updateOne(
        { _id: vm, computer: want.computer },
        { $set: { state: "free" }, $unset: { computer: "", org: "", taken: "", until: "" } },
      ).catch(() => {});
      throw error;
    }
    return { vm };
  },
});

export const serveAction = defineAction({
  input: {
    type: "object",
    properties: { vm: { type: "string" }, assign: { type: "object" }, org: { type: "string" } },
    required: ["vm", "assign"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const assign = input.assign as PoolAssign;
    const vm = await givenOf(ctx, input.vm, input.org);
    if (vm.state !== "assigned" || vm.computer !== assign.computer) {
      throw failure(`${input.vm} wasn't taken for ${assign.computer}`, "invalid");
    }
    return await ctx.workers.call(POOL_KIND, input.vm, POOL.assign, assign, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ASSIGN_MS)]),
    });
  },
});

export const stopAction = defineAction({
  input: {
    type: "object",
    properties: { vm: { type: "string" }, computer: { type: "string" }, org: { type: "string" } },
    required: ["vm", "computer"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const vm = await givenOf(ctx, input.vm, input.org);
    // Only ever told to stop serving its own computer; told once, it never connects again.
    if (vm.computer !== input.computer) {
      throw failure(`${input.vm} doesn't serve ${input.computer}`, "invalid");
    }
    if (!vm.released) {
      await poolsOf(ctx).updateOne({ _id: input.vm }, {
        $set: { released: new Date().toISOString() },
      });
    }
    // Asked to stop, it answers once it's unmounted; one that doesn't says nothing.
    return await ctx.workers.call(
      POOL_KIND,
      input.vm,
      POOL.release,
      { computer: input.computer } satisfies PoolRelease,
      { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(RELEASE_MS)]) },
    ).catch(() => ({ error: { message: "no answer", code: "unavailable" } }));
  },
});

export const dropAction = defineAction({
  input: {
    type: "object",
    properties: { vm: { type: "string" }, placement, org: { type: "string" } },
    required: ["vm"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const known = await poolsOf(ctx).findOne({ _id: input.vm });
    if (known && input.org !== undefined && known.org !== input.org) {
      throw failure(`No such VM: ${input.vm}`, "not_found");
    }
    const where = known?.placement ?? input.placement;
    if (!where) return { dropped: false };
    const host = await hostFor(ctx, where);
    await host.deleteVm(where, input.vm);
    // Deleted, a VM is gone for good; forgotten a while later (`pool.tick`).
    if (known) {
      await poolsOf(ctx).updateOne({ _id: input.vm }, {
        $set: { state: "gone", seen: new Date().toISOString() },
      });
    }
    return { dropped: true };
  },
});

export const renewAction = defineAction({
  record: false,
  input: {
    type: "object",
    properties: {
      vms: { type: "array", items: { type: "string" } },
      org: { type: "string" },
      now: { type: "string" },
    },
    required: ["vms"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    if (!input.vms.length) return { renewed: 0 };
    const until = after(nowOf(ctx, input.now), LEASE_MS);
    const { modifiedCount } = await poolsOf(ctx).updateMany(
      {
        _id: { $in: input.vms },
        state: "assigned",
        ...(input.org !== undefined ? { org: input.org } : {}),
      },
      { $set: { until } },
    );
    return { renewed: modifiedCount };
  },
});
