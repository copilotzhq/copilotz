/**
 * `voice.prune`: what's kept of calls goes after the plugin's `keep` days
 * (30): each call's record, with the number it had, and a caller's link to
 * their contact (`voice_phone`) when they haven't called since. Time calls
 * it, every day (the plugin's `schedules`). Blocks stay until lifted.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { keepOf } from "../shared/settings.ts";

export const pruneAction = defineAction({
  description: "Removes calls' records older than the plugin's `keep` days",
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    const before = new Date(Date.now() - keepOf(ctx) * 86_400_000).toISOString();
    const system = ctx.as();
    let pruned = 0;
    await system.transaction(async (tx) => {
      ({ deletedCount: pruned } = await tx.db.collection("voice_call").deleteMany({
        at: { $lt: before },
      }));
      await tx.db.collection("voice_phone").deleteMany({ at: { $lt: before } });
    });
    return { pruned };
  },
});
