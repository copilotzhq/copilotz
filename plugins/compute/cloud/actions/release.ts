/**
 * `cloud.release` `{ computer, force?, used?, now? }`: an awake computer's
 * VM goes (run as the system: idle ones each minute, dead ones on a wake).
 * The VM is asked to stop serving it (`pool.release`: its jobs stop, those it
 * keeps are listed to start again, its disk is unmounted), its disk is
 * detached (by force when the VM didn't answer, or `force`), and the VM is
 * deleted: it never serves another. Its seconds since last metered are
 * metered, and it's asleep. `used`: only if it hasn't been used since then
 * (an idle release a call came between doesn't happen). Answers
 * `{ released }`.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { POOL, POOL_KIND, type PoolRelease } from "../contract.ts";
import { hostFor } from "../shared/host.ts";
import { meterVm } from "../shared/meter.ts";
import { poolsOf, recordsOf, still } from "../shared/records.ts";
import { nowOf } from "../shared/time.ts";

/** How long a VM has to stop its computer and unmount before it's detached by force. */
const RELEASE_MS = 90_000;

const log = (what: string) => (error: unknown) =>
  console.error(`cloud: ${what}:`, error instanceof Error ? error.message : error);

export const releaseAction = defineAction({
  input: {
    type: "object",
    properties: {
      computer: { type: "string" },
      force: { type: "boolean" },
      used: { type: "string" },
      now: { type: "string" },
    },
    required: ["computer"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const records = recordsOf(ctx);
    const { modifiedCount } = await records.updateOne(
      { _id: input.computer, state: "awake", ...(input.used ? still("used", input.used) : {}) },
      { $set: { state: "releasing" } },
    );
    if (!modifiedCount) return { released: false };
    const rec = (await records.findOne({ _id: input.computer }))!;
    const host = await hostFor(ctx, rec.placement);
    const vm = rec.vm;
    if (vm) {
      // Asked to stop, it answers once it's unmounted; a VM that doesn't is detached by force.
      let force = input.force === true;
      if (!force) {
        const answer = await ctx.workers.call(
          POOL_KIND,
          vm,
          POOL.release,
          { computer: rec._id } satisfies PoolRelease,
          { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(RELEASE_MS)]) },
        ).catch(() => ({ error: { message: "no answer" } }));
        force = !!(answer as { error?: unknown } | null)?.error;
      }
      await host.detach(rec.placement, vm, rec.disk, force).catch((error) =>
        force ? log(`detaching ${rec.disk}`)(error) : host.detach(rec.placement, vm, rec.disk, true)
          .catch(log(`detaching ${rec.disk} by force`))
      );
      // Deleted, a VM is gone for good; one that couldn't be is deleted again by the next tick.
      await host.deleteVm(rec.placement, vm)
        .then(() =>
          poolsOf(ctx).updateOne({ _id: vm }, {
            $set: { state: "gone", seen: new Date().toISOString() },
          })
        )
        .catch(log(`deleting ${vm}`));
    }
    await meterVm(ctx, rec, nowOf(ctx, input.now), "releasing");
    await records.updateOne({ _id: rec._id }, {
      $set: { state: "asleep" },
      $unset: { vm: "", metered: "" },
    });
    return { released: true };
  },
});
