/**
 * `voice.prune`: what's kept of calls goes after their number's `keep` days
 * (30, and 1 at least; 30 for a number the app no longer declares): each call's record that's over, erased, or no longer
 * holding a place (a call can't go on past it), with the number it had; and
 * a caller's link to their contact (`voice_phone`) when they haven't called
 * since. A call going on is never pruned. Time calls it, every day (the
 * plugin's `schedules`). Blocks stay until lifted, or their `until`.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { KEEP, numbersOf } from "../shared/settings.ts";

export const pruneAction = defineAction({
  description: "Removes calls' records older than their number's `keep` days, once they're over",
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => {
    const now = Date.now();
    const over = new Date(now).toISOString();
    const declared = numbersOf(ctx);
    // Each number keeps its calls its own days; any other (no longer declared) keeps the default.
    const keeps: [Record<string, unknown>, number][] = [
      ...Object.entries(declared).map(([name, number]): [Record<string, unknown>, number] => [
        { line: name },
        number.keep ?? KEEP,
      ]),
      [{ line: { $nin: Object.keys(declared) } }, KEEP],
    ];
    const system = ctx.as();
    let pruned = 0;
    await system.transaction(async (tx) => {
      for (const [whose, days] of keeps) {
        const before = new Date(now - days * 86_400_000).toISOString();
        const { deletedCount } = await tx.db.collection("voice_call").deleteMany({
          ...whose,
          at: { $lt: before },
          $or: [{ state: "over" }, { erased: true }, { until: { $lt: over } }],
        });
        pruned += deletedCount;
        await tx.db.collection("voice_phone").deleteMany({ ...whose, at: { $lt: before } });
      }
      await tx.db.collection("voice_blocked").deleteMany({ until: { $lt: over } });
    });
    return { pruned };
  },
});
