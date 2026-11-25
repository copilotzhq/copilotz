/**
 * `chat.archive`: a conversation put away (`archived: true`) or brought back
 * (`false`), for everyone who sees it, as its title is. Put away, it's out of
 * the way: lists of chats leave it out (`thread.recent` answers it only when
 * asked for archived ones), and so do agents' `list_conversations`. Nothing
 * in it changes, and anyone may still open it. A new message in it, its
 * notes or a subthread brings it back, in that message's own commit.
 *
 * A person archives it (not an agent working for one, a key, a routine or a
 * contact), who may write where it is: the access rules check it, as for
 * `chat.rename`. Asked about a chat's staff notes or one of its subthreads,
 * it archives the chat, and answers with it: they go with it.
 *
 * Archiving one that's archived, or restoring one that isn't, changes
 * nothing. With `latest`, archiving is refused (`conflict`) when something
 * was said in `thread` after that message: nothing new is put away unseen.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { now } from "../shared/agents.ts";
import { chatOf } from "../shared/chat-of.ts";

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
       * The id of `thread`'s latest message as the person saw it (its
       * `latest`). Only archiving checks it; omitted, nothing is checked.
       */
      latest: { type: "string", minLength: 1 },
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
    return await ctx.transaction(async (tx) => {
      const threads = tx.db.collection<Thread>("thread");
      // Read again with the writer held: whatever was said before this is what it's checked on.
      const named = await threads.findOne({ _id: input.thread });
      const found = chat === input.thread ? named : await threads.findOne({ _id: chat });
      if (!named || !found) throw missing();
      if (input.archived && input.latest !== undefined && named.latest !== input.latest) {
        throw failure("conflict", "Something new was said in it: read it before you archive it.", {
          public: true,
        });
      }
      const answer = { thread: chat, archived: input.archived };
      if (!!found.archived === input.archived) return answer;
      const { matchedCount } = await threads.updateOne(
        { _id: chat },
        input.archived ? { $set: { archived: now() } } : { $unset: { archived: "" } },
      );
      if (!matchedCount) {
        throw failure("forbidden", "Only someone who may write in its space archives it.", {
          public: true,
        });
      }
      return answer;
    });
  },
});
