/**
 * `cloud.destroy` `{ computer }`: a cloud computer goes for good, by its
 * owner or the org's admins. A wake or release under way ends first; awake,
 * it's released. Its storage is metered to now, its disk and snapshot are
 * deleted, and the computer is forgotten everywhere it was (`computer.forget`).
 * Answers `{ destroyed: true }`.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { hostFor } from "../shared/host.ts";
import { meterStorage } from "../shared/meter.ts";
import { forbidden, notFound, personOf, runs, standingOf } from "../shared/people.ts";
import { recordsOf } from "../shared/records.ts";
import { poll } from "../shared/time.ts";

export const destroyAction = defineAction({
  description: "Destroys a cloud computer: its disk and snapshot are deleted, and it's forgotten",
  input: {
    type: "object",
    properties: { computer: { type: "string" } },
    required: ["computer"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const records = recordsOf(ctx);
    const found = await records.findOne({ _id: input.computer });
    if (!found) throw notFound("No such cloud computer");
    if (found.owner !== personOf(ctx.actor) && !runs(await standingOf(ctx))) {
      throw forbidden("Only its owner, or the org's owners and admins, destroy it.");
    }
    // Asleep or cold, it's this call's: nothing wakes it meanwhile.
    for (let round = 0;; round++) {
      const rec = await records.findOne({ _id: input.computer });
      if (!rec) return { destroyed: true };
      if (rec.state === "awake") await ctx.call("cloud.release", { computer: rec._id });
      else if (rec.state === "waking" || rec.state === "releasing") {
        await poll(
          async () => {
            const now = await records.findOne({ _id: rec._id });
            return !now || now.state !== rec.state ? true : undefined;
          },
          240_000,
          { every: 500, signal: ctx.signal },
        );
      } else {
        const { modifiedCount } = await records.updateOne(
          { _id: rec._id, state: rec.state },
          { $set: { state: "releasing" } },
        );
        if (modifiedCount) break;
      }
      if (round > 5) throw Object.assign(new Error("It's busy: try again."), { code: "busy" });
    }
    const rec = (await records.findOne({ _id: input.computer }))!;
    const was = rec.snapshot ? "cold" : "asleep";
    try {
      await meterStorage(ctx, { ...rec, state: was }, new Date().toISOString());
      const host = await hostFor(ctx, rec.placement);
      if (was !== "cold") await host.deleteDisk(rec.placement, rec.disk);
      if (rec.snapshot) await host.deleteSnapshot(rec.placement, rec.snapshot);
    } catch (error) {
      // Kept as it was, to destroy again.
      await records.updateOne({ _id: rec._id }, { $set: { state: was } });
      throw error;
    }
    await ctx.as().call("computer.forget", { computer: rec._id });
    await records.deleteOne({ _id: rec._id });
    return { destroyed: true };
  },
});
