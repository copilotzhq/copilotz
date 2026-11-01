/**
 * `chat.move`: moves a conversation to another space, with everything in
 * it: its messages, its files, and the subthreads agents opened from it.
 * Only a person does, who may write in both spaces (the access rules check
 * it): moving shows it to the space's members, which is theirs to decide.
 * Answers marked as drawing on other spaces keep their marks; forks stay
 * where they are. Not while agents are writing in it: a running turn writes
 * where the conversation was when it started (a waiting one, resumed, reads
 * it again).
 */
import { type Context, defineAction, people } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";

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
  allow: people,
  run: async (ctx, input) => {
    const found = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    if (!found) throw refused(`No conversation "${input.thread}" to move.`);
    if (found.in === input.to) return { moved: 0, to: input.to };
    const all = await within(ctx, input.thread);
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

/** The conversation and the subthreads hanging from it, all the way down: one read per level. */
async function within(ctx: Context, thread: string): Promise<string[]> {
  const all = [thread];
  for (let level = [thread]; level.length;) {
    const asked = await ctx.db.collection<Message>("message").find({
      thread: { $in: level },
      subthread: { $exists: true },
    });
    level = asked.map((m) => m.subthread!).filter((id) => !all.includes(id));
    all.push(...level);
  }
  return all;
}
