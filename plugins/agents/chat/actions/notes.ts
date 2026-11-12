/**
 * `chat.notes`: the notes beside a chat shared with someone outside its space
 * (a contact's): a thread of their own in the same space, where its people
 * work with agents about it (agents there reach all the space does, the chat
 * included), and that the one outside never sees. Made the first time it's
 * asked for, as the asker (the rules check they may write in the space), and
 * the same one ever after: asking again, or about the notes themselves,
 * answers with it. A chat nobody outside shares has none: everyone who sees
 * its notes would see it anyway.
 */
import { defineAction, failure, people } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { now } from "../shared/agents.ts";
import { notesFor, notesOf } from "../shared/notes.ts";
import { sharedWith } from "../../../access/spaces/contract.ts";

export const notesAction = defineAction({
  description: "The notes beside a chat shared outside its space, made the first time",
  input: {
    type: "object",
    properties: { thread: { type: "string", minLength: 1 } },
    required: ["thread"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const threads = ctx.db.collection<Thread>("thread");
    const asked = await threads.findOne({ _id: input.thread });
    if (!asked) throw failure("not_found", `No conversation "${input.thread}".`, { public: true });
    // Asked about the notes themselves: they're the answer.
    const chat = asked.about ? await threads.findOne({ _id: asked.about }) : asked;
    const about = asked.about ?? asked._id;
    const id = notesOf(about);
    if (asked.about || await threads.findOne({ _id: id })) return { thread: id, about };
    if (!chat?.in || !(await sharedWith(ctx, "thread", chat._id)).length) {
      throw failure(
        "invalid",
        "Only a chat shared outside its space keeps notes apart: everyone here sees it already.",
        { public: true },
      );
    }
    try {
      await threads.insertOne(notesFor(chat, now()));
    } catch (error) {
      // Made just now, by someone else asking at once.
      if ((error as { code?: string }).code !== "duplicate_key") throw error;
    }
    return { thread: id, about };
  },
});
