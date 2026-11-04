/**
 * `voice.prune`: what's kept of calls goes after the plugin's `keep` days
 * (30, and 1 at least): each call's record that's over, erased, or no longer
 * holding a place (a call can't go on past it), with the number it had; and
 * a caller's link to their contact (`voice_phone`) when they haven't called
 * since. A call going on is never pruned. Time calls it, every day (the
 * plugin's `schedules`). Blocks stay until lifted, or their `until`.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { keepOf } from "../shared/settings.ts";

export const pruneAction = defineAction({
  description: "Removes calls' records older than the plugin's `keep` days, once they're over",
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    const now = Date.now();
    const before = new Date(now - keepOf(ctx) * 86_400_000).toISOString();
    const system = ctx.as();
    let pruned = 0;
    await system.transaction(async (tx) => {
      ({ deletedCount: pruned } = await tx.db.collection("voice_call").deleteMany({
        at: { $lt: before },
        $or: [
          { state: "over" },
          { erased: true },
          { until: { $lt: new Date(now).toISOString() } },
        ],
      }));
      await tx.db.collection("voice_phone").deleteMany({ at: { $lt: before } });
      await tx.db.collection("voice_blocked").deleteMany({
        until: { $lt: new Date(now).toISOString() },
      });
    });
    return { pruned };
  },
});
