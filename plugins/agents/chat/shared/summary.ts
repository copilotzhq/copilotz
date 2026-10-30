/**
 * A chat's summary, kept on its thread as messages come, so a list of chats
 * reads two things: its threads, then the messages they point at. It counts
 * its shared messages (`messages`), points at its first and latest
 * (`opened`, `latest`: ids, never what they say, so a message only some
 * may read, an answer drawn from a space others can't see, stays theirs:
 * the list reads it as its viewer), and says when it last moved (`at`). A
 * chat's first message writes it with the thread; each later one updates
 * it in the write that already touches the thread, or in one of its own
 * (an agent's reply). Private steps don't count.
 */
import type { Message } from "../collections/message.ts";
import { NO_ANSWER } from "./agents.ts";

/** What a message says, for a title or a preview: its text, else what its audio says, else its file. */
export const said = (m: Pick<Message, "text" | "files"> | null | undefined) => {
  if (!m) return undefined;
  if (m.text?.trim()) return m.text;
  const [file] = m.files ?? [];
  return file?.transcript || (file?.voice ? "Voice message" : file?.name);
};

type Writes = {
  db: {
    collection(name: string): {
      updateOne(filter: unknown, update: unknown, options?: unknown): Promise<unknown>;
    };
  };
};

/** The summary a thread starts with, written with its first message. */
export const startedWith = (m: Pick<Message, "_id" | "private">) =>
  m.private ? { messages: 0 } : { messages: 1, opened: m._id, latest: m._id };

/** What a later shared message changes in its thread's summary (an update's operators). */
export const movedBy = (m: Pick<Message, "_id" | "at">) => ({
  $inc: { messages: 1 },
  $set: { at: m.at, latest: m._id },
});

/** Counts a later shared message `m` in its thread's summary, in the transaction that writes it. */
export async function noted(tx: Writes, m: Message) {
  if (m.private) return;
  await tx.db.collection("thread").updateOne({ _id: m.thread }, movedBy(m), NO_ANSWER);
}
