/**
 * The chat a thread belongs to: a conversation's own thread, the one lists of
 * chats show and `chat.archive` puts away. Staff notes belong to the chat
 * they're about (`about`); a subthread (`send_message`'s, `<message>:sub`)
 * to the chat it hangs from, up every level. Any other thread is a chat of
 * its own: a fork (`chat.fork`), replies held from one (`held`), one a
 * hand-over opened in another space.
 */
import type { Collection } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";

/** A subthread's id: the message that opened it, `<message>:sub` (see send.ts). */
export const subthreadOf = (message: string): string => `${message}:sub`;

/** What a thread says of where it hangs from. */
export type Hangs = Pick<Thread, "_id" | "about" | "parent" | "fork">;

type Reads = { collection<T>(name: string): Pick<Collection<T>, "findOne"> };

/** The most levels of subthreads it goes up (a thread whose parents loop stops there). */
const DEEPEST = 32;

/**
 * The id of the chat `thread` belongs to: its own for a chat, its chat's for
 * notes or a subthread. Read with `db`, the system's: only where threads hang
 * from, which never changes, and nothing anyone is shown. No read for a chat
 * or its notes; one for each level of subthread.
 */
export async function chatOf(db: Reads, thread: Hangs): Promise<string> {
  let at = thread;
  for (let level = 0; level < DEEPEST; level++) {
    if (at.about) return at.about;
    const parent = at.fork && at.parent?.message && at._id === subthreadOf(at.parent.message)
      ? at.parent.thread
      : undefined;
    if (!parent) return at._id;
    const up = await db.collection<Thread>("thread").findOne({ _id: parent });
    if (!up) return parent;
    at = up;
  }
  return at._id;
}

/** The chat the thread `id` belongs to, read first; the id itself when there's no such thread. */
export async function chatOfId(db: Reads, id: string): Promise<string> {
  const thread = await db.collection<Thread>("thread").findOne({ _id: id });
  return thread ? await chatOf(db, thread) : id;
}
