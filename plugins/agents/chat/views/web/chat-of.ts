/**
 * The chat a page shows (its own, its notes', a subthread's), as a View reads
 * it: the chat's document, up through the threads it hangs from (see
 * `shared/chat-of.ts`); undefined while one is read, null when one can't be.
 * Archived, it says so for every page of it.
 */
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { Thread } from "../../collections/thread.ts";
import { hangsFrom } from "../../shared/chat-of.ts";

/** The most levels it goes up. */
const DEEPEST = 32;

export function chatDocOf(
  db: ViewContext<unknown>["db"],
  thread: Thread,
): Thread | null | undefined {
  let at = thread;
  for (let level = 0; level < DEEPEST; level++) {
    const up = hangsFrom(at);
    if (!up) return at;
    const next = db.collection<Thread>("thread").findOne({ _id: up }).value;
    if (!next) return next;
    at = next;
  }
  return at;
}
