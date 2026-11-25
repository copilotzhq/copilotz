/**
 * The chat a thread belongs to: a conversation's own thread, the one lists of
 * chats show and `chat.archive` puts away. Staff notes belong to the chat
 * they're about (`about`); a subthread (`send_message`'s, `<message>:sub`)
 * to the chat it hangs from, up every level. Any other thread is a chat of
 * its own: a fork (`chat.fork`), replies held from one (`held`), one a
 * hand-over opened in another space.
 *
 * Only notes and subthreads hang from another thread, and their ids say so:
 * notes are `<chat>:notes` (notes.ts), a subthread `<message>:sub`. So a
 * thread whose id is neither is a chat, read for nothing: working out the
 * chat of a chat, its notes or a chat's subthread reads nothing; a subthread
 * further down reads one thread a level.
 */
import type { Collection } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import { notesOf } from "./notes.ts";

/** A subthread's id: the message that opened it, `<message>:sub` (see send.ts). */
export const subthreadOf = (message: string): string => `${message}:sub`;

/** What a thread says of where it hangs from. */
export type Hangs = Pick<Thread, "_id" | "about" | "parent" | "fork">;

type Reads = { collection<T>(name: string): Pick<Collection<T>, "findOne"> };

/** The most levels of subthreads it goes up (a thread whose parents loop stops there). */
const DEEPEST = 32;

const SUB = subthreadOf("");
const NOTES = notesOf("");

/** Whether the thread `id` may hang from another: only notes' and subthreads' ids do. */
const mayHang = (id: string) => id.endsWith(SUB) || id.endsWith(NOTES);

/**
 * The thread `thread` hangs from: the chat its notes are about, the thread a
 * subthread opens from; none for a chat (a fork included).
 */
export const hangsFrom = (thread: Hangs): string | undefined =>
  thread.about ??
    (thread.fork && thread.parent?.message && thread._id === subthreadOf(thread.parent.message)
      ? thread.parent.thread
      : undefined);

/**
 * The id of the chat `thread` belongs to: its own for a chat, its chat's for
 * notes or a subthread. Read with `db`, the system's: only where threads hang
 * from, which never changes, and nothing anyone is shown. No read for a chat,
 * its notes or a chat's subthread; one for each level further down.
 */
export async function chatOf(db: Reads, thread: Hangs): Promise<string> {
  let at = thread;
  for (let level = 0; level < DEEPEST; level++) {
    if (at.about) return at.about;
    const up = hangsFrom(at);
    if (!up) return at._id;
    if (!mayHang(up)) return up;
    const next = await db.collection<Thread>("thread").findOne({ _id: up });
    if (!next) return up;
    at = next;
  }
  return at._id;
}

/**
 * The chat the thread `id` belongs to: a chat's is its own, read for nothing;
 * notes' or a subthread's, read first. The id itself when there's no such
 * thread.
 */
export async function chatOfId(db: Reads, id: string): Promise<string> {
  if (!mayHang(id)) return id;
  const thread = await db.collection<Thread>("thread").findOne({ _id: id });
  return thread ? await chatOf(db, thread) : id;
}
