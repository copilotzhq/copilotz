/**
 * `chat.erase`: a chat, gone with everything in it (its messages, files,
 * what's being written, and the subthreads hanging from it), for erasing
 * someone's personal data (LGPD, GDPR). Trusted code only: it calls this
 * once it decided whose data goes (`contact.forget`).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";

export const eraseAction = defineAction({
  description: "Erases a chat and everything in it",
  input: {
    type: "object",
    properties: { thread: { type: "string" } },
    required: ["thread"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const messages = ctx.db.collection<Message>("message");
    // The chat and the subthreads hanging from it, all the way down: one read per level.
    const all = [input.thread];
    for (let level = [input.thread]; level.length;) {
      const hanging = await messages.find({ thread: { $in: level }, subthread: { $exists: true } });
      level = hanging.map((m) => m.subthread!).filter((id) => !all.includes(id));
      all.push(...level);
    }
    await ctx.transaction(async (tx) => {
      for (const collection of ["message", "file", "live", "wait"]) {
        await tx.db.collection(collection).deleteMany({ thread: { $in: all } });
      }
      await tx.db.collection("thread").deleteMany({ _id: { $in: all } });
    });
    return { erased: all.length };
  },
});
