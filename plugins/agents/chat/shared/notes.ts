/**
 * Notes beside a conversation: for a chat shared with someone outside its
 * space (a contact), a thread of its own in the same space where its people
 * work with agents about it, with all the space reaches, and that the one
 * outside never sees. It's a document apart, not hidden messages in the
 * chat: who sees what stays per document. One per chat (its id is the chat's,
 * `<chat>:notes`), made the first time it's asked for (`chat.notes`), and
 * linked both ways: the notes say what they're about (`about`), and the
 * chat's notes are found by its id.
 */
import type { ReadContext } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";

/** The id of a chat's notes: one per chat, so asking twice, or at once, finds the same. */
export const notesOf = (thread: string): string => `${thread}:notes`;

/** What notes about `chat` are called where conversations are listed. */
export const notesTitle = (chat: Pick<Thread, "title">): string =>
  `Staff notes: ${chat.title ?? "a conversation"}`.slice(0, 120);

/** Notes about `chat`, as they're first written: in its space, answered by its agents. */
export const notesFor = (chat: Thread, at: string): Thread => ({
  _id: notesOf(chat._id),
  about: chat._id,
  title: notesTitle(chat),
  agents: chat.agents ?? [],
  ...(chat.in ? { in: chat.in } : {}),
  messages: 0,
  at,
});

type Reads = Pick<ReadContext, "db">;

/**
 * A conversation and everything that goes with it, all the way down: the
 * subthreads hanging from it (one read per level) and its notes, with
 * theirs. What moves with it, and what's erased with it.
 */
export async function conversationOf(ctx: Reads, thread: string): Promise<string[]> {
  const notes = notesOf(thread);
  const own = await ctx.db.collection<Thread>("thread").findOne({ _id: notes });
  const all = [thread, ...(own ? [notes] : [])];
  for (let level = [...all]; level.length;) {
    const asked = await ctx.db.collection<Message>("message").find({
      thread: { $in: level },
      subthread: { $exists: true },
    });
    level = asked.map((m) => m.subthread!).filter((id) => !all.includes(id));
    all.push(...level);
  }
  return all;
}
