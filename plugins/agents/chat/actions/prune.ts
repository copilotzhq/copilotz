/**
 * `chat.prune`: files uploaded to send (`chat.attach`) that no message sent
 * within a day go. Chat's schedule calls it every hour; nobody outside may.
 */
import { defineAction } from "../../../../runtime/mod.ts";

/** How long a draft waits to be sent. */
export const DRAFT_MS = 86_400_000;

export const pruneAction = defineAction({
  description: "Drops files uploaded to send that no message sent within a day",
  input: { type: "object", additionalProperties: false },
  record: false,
  run: async (ctx) => {
    const before = new Date(Date.now() - DRAFT_MS).toISOString();
    const { deletedCount } = await ctx.as().db.collection("file").deleteMany({
      draft: { $exists: true },
      at: { $lt: before },
    });
    return { gone: deletedCount };
  },
});
