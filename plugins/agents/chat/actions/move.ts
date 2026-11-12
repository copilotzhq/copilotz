/**
 * `chat.move`: moves a conversation to another space, with everything in
 * it: its messages, its files, and the subthreads agents opened from it.
 * Only a person does, who may write in both spaces (the access rules check
 * it): moving shows it to the space's members, which is theirs to decide,
 * so it's a share, and front ends say first who'll see it and what it drew
 * on (`thread.moving`). Its answers' record of what they drew on (`drew`)
 * goes with them; its notes (`chat.notes`) go too, beside it still; forks
 * stay where they are. Not while agents are writing in it: a running turn
 * writes where the conversation was when it started (a waiting one,
 * resumed, reads it again).
 */
import { defineAction, inPerson } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { conversationOf } from "../shared/notes.ts";

const refused = (message: string, code = "forbidden") =>
  Object.assign(new Error(message), { code });

export const moveAction = defineAction({
  description: "Moves a conversation, with everything in it, to another space",
  input: {
    type: "object",
    properties: { thread: { type: "string" }, to: { type: "string" } },
    required: ["thread", "to"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const found = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    if (!found) throw refused(`No conversation "${input.thread}" to move.`);
    // A chat's notes stay beside it: they go where it goes.
    if (found.about) {
      throw refused("Staff notes go wherever their chat goes: move the chat.", "invalid");
    }
    if (found.in === input.to) return { moved: 0, to: input.to };
    const all = await conversationOf(ctx, input.thread);
    if (await ctx.db.collection("live").countDocuments({ thread: { $in: all } })) {
      throw refused(
        "Agents are writing in this conversation: wait for them, or stop them.",
        "busy",
      );
    }
    // All of it, or none: what they can't change would stay behind.
    const there = await ctx.as().db.collection("message").countDocuments({ thread: { $in: all } });
    await ctx.transaction(async (tx) => {
      const to = { $set: { in: input.to } };
      const threads = await tx.db.collection("thread").updateMany({ _id: { $in: all } }, to);
      const messages = await tx.db.collection("message").updateMany({ thread: { $in: all } }, to);
      await tx.db.collection("file").updateMany({ thread: { $in: all } }, to);
      if (threads.matchedCount < all.length || messages.matchedCount < there) {
        throw refused("Some of this conversation is out of your reach: it can't move.");
      }
    });
    return { moved: all.length, to: input.to };
  },
});
