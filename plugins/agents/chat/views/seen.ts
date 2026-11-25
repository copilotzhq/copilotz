/**
 * What a front end was shown last of a conversation, for `chat.archive`'s
 * `latest`: the newest message in what it drew (an agent's private steps
 * aside), or null when it drew none. Every front end passes it the same way.
 */
import type { Message } from "../collections/message.ts";

export function newestOf(...drawn: Pick<Message, "_id" | "at" | "private">[][]): string | null {
  let newest: Pick<Message, "_id" | "at"> | undefined;
  for (const m of drawn.flat()) if (!m.private && (!newest || m.at > newest.at)) newest = m;
  return newest?._id ?? null;
}
