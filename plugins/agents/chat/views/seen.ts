/**
 * What a page, a row or a terminal's list showed last of a chat, for
 * `chat.archive`'s `latest`: of the threads it showed (the chat, its notes or
 * a subthread open), the latest message of the one that moved last; null
 * when none had a message. Every front end says it the same way.
 */
import type { Thread } from "../collections/thread.ts";

export function seenOf(
  ...shown: (Pick<Thread, "latest" | "at"> | null | undefined)[]
): string | null {
  const said = shown.filter((t): t is Pick<Thread, "latest" | "at"> => !!t?.latest);
  said.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return said[0]?.latest ?? null;
}
