/**
 * `chat.rename`: a conversation's new title, as its people see it in their
 * lists, its header and the palette. A person names it (not an agent working
 * for one), who may write in its space: the access rules check it. Its notes
 * (`chat.notes`), titled as it is, take the new title too; asking about them
 * renames the chat. A name someone gave stays: an agent that may name a chat
 * it started (a routine's run, `renamable`) no longer does.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { notesOf } from "../shared/notes.ts";
import { LONGEST_TITLE } from "../shared/types.ts";

export const renameAction = defineAction({
  description: "Renames a conversation",
  input: {
    type: "object",
    properties: {
      thread: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1, maxLength: LONGEST_TITLE },
    },
    required: ["thread", "title"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title) throw failure("invalid", "A title says something.", { public: true });
    const asked = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    if (!asked) throw failure("not_found", `No conversation "${input.thread}".`, { public: true });
    // Notes are titled as their chat: renaming them renames it.
    const thread = asked.about ?? asked._id;
    await ctx.transaction(async (tx) => {
      const threads = tx.db.collection("thread");
      const renamed = await threads.updateOne(
        { _id: thread },
        { $set: { title }, $unset: { renamable: "" } },
      );
      if (!renamed.matchedCount) {
        throw failure("forbidden", "Only someone who may write in its space renames it.", {
          public: true,
        });
      }
      await threads.updateOne({ _id: notesOf(thread), about: thread }, { $set: { title } });
    });
    return { thread, title };
  },
});
