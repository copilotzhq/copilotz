/**
 * `email.prune`: what's past goes: sign-ups never confirmed, codes and links
 * past their time, and counters whose window is over. The plugin's schedule
 * calls it every ten minutes; nobody outside may.
 */
import { defineAction } from "../../../../runtime/mod.ts";

export const pruneAction = defineAction({
  description: "Drops email sign-in's codes, links and counters that are past",
  input: { type: "object", additionalProperties: false },
  record: false,
  run: async (ctx) => {
    const db = ctx.as().db;
    const now = Date.now();
    const codes = await db.collection("email_code").deleteMany({
      until: { $lte: new Date(now).toISOString() },
    });
    await db.collection("email_rate").deleteMany({ until: { $lte: now } });
    return { gone: codes.deletedCount };
  },
});
