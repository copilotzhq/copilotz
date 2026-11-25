/**
 * `chat.archive`: a conversation put away (`archived: true`) or brought back
 * (`false`), for everyone who sees it, as its title is. Put away, it's out of
 * the way: lists of chats leave it out (`thread.recent` answers it only when
 * asked for archived ones), and so do agents' `list_conversations`. Nothing
 * in it changes, and anyone may still open it. A new message in it, its
 * notes or a subthread brings it back, in that message's own commit.
 *
 * A person archives it (not an agent working for one, a key, a routine or a
 * contact), who may write where it is: the access rules check it first, as
 * for `chat.rename`. Asked about a chat's staff notes or one of its
 * subthreads, it archives the chat, and answers with it: they go with it.
 * Archiving one that's archived, or restoring one that isn't, changes
 * nothing.
 *
 * With `latest`, the newest message the person was shown, archiving is
 * refused (`conflict`) when anything in the conversation is newer: the chat,
 * its notes, its subthreads at every level. Nothing new is put away unseen.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { now } from "../shared/agents.ts";
import { chatOf } from "../shared/chat-of.ts";
import { conversationOf } from "../shared/notes.ts";

export const archiveAction = defineAction({
  description: "Archives a conversation, or brings it back",
  input: {
    type: "object",
    properties: {
      /** The chat, its staff notes or one of its subthreads. */
      thread: { type: "string", minLength: 1 },
      /** True puts it away, false brings it back. */
      archived: { type: "boolean" },
      /**
       * The newest message the person was shown of the conversation, by id;
       * `null` when they were shown none. Only archiving checks it; omitted,
       * nothing is checked.
       */
      latest: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    },
    required: ["thread", "archived"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const missing = () =>
      failure("not_found", `No conversation "${input.thread}".`, { public: true });
    const asked = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    if (!asked) throw missing();
    // Its notes and subthreads go with it: it's the chat that's put away.
    const chat = await chatOf(ctx.as().db, asked);
    // What it's made of, read as the system (where threads hang from, nothing shown): a subthread
    // opened since comes with an opening newer than what they were shown, checked below anyway.
    const all = input.archived && input.latest !== undefined
      ? await conversationOf(ctx.as(), chat)
      : [];
    return await ctx.transaction(async (tx) => {
      const threads = tx.db.collection<Thread>("thread");
      const found = await threads.findOne({ _id: chat });
      if (!found) throw missing();
      // The write asks the rules first: one that changes nothing records nothing, and a refusal
      // after it leaves it unwritten.
      const { matchedCount } = await threads.updateOne(
        { _id: chat },
        input.archived
          ? { $set: { archived: found.archived ?? now() } }
          : { $unset: { archived: "" } },
      );
      if (!matchedCount) {
        throw failure("forbidden", "Only someone who may write in its space archives it.", {
          public: true,
        });
      }
      if (input.archived && !found.archived && input.latest !== undefined) {
        // Anything said there after what they were shown (a message as old counts as shown).
        const messages = tx.db.collection<Message>("message");
        const shown = input.latest ? await messages.findOne({ _id: input.latest }) : null;
        const [newer] = await messages.find({
          thread: { $in: all },
          private: { $ne: true },
          ...(shown ? { at: { $gt: shown.at } } : {}),
        }, { limit: 1, projection: { _id: 1 } });
        if (newer) {
          throw failure(
            "conflict",
            "Something new arrived in this conversation: open it to see it, then archive it.",
            { public: true },
          );
        }
      }
      return { thread: chat, archived: input.archived };
    });
  },
});
