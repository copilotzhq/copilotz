/**
 * Archiving a chat (`chat.archive`) from a menu, its header's or a list's
 * row's: "Archive", or "Restore" once it's archived, done at once (it's
 * undone as easily); a refusal is said in a toast. Archiving says what the
 * person saw last (`latest`): the newest of what the page or row showed of the
 * chat and of the thread open (its notes, a subthread), or that it showed
 * nothing (`null`), so nothing new since is put away unseen.
 */
import { type MenuItem, message, toast } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

export { seenOf } from "../seen.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** What archiving or restoring a chat asks: the chat (or its notes), whether it's archived now. */
export type Archiving = {
  thread: string;
  /** Whether it's archived now: the item restores it. */
  archived: boolean;
  /**
   * The newest message shown (see `seenOf`), which archiving checks nothing
   * came after; null or left out, none was.
   */
  latest?: string | null;
};

/** The input `chat.archive` takes to do the opposite of what's so now. */
export const archiveInput = ({ thread, archived, latest }: Archiving) => ({
  thread,
  archived: !archived,
  ...(!archived ? { latest: latest ?? null } : {}),
});

/** A menu's item that archives a chat, or restores it. */
export function archiveItem(o: Archiving & { call: Call }): MenuItem {
  return {
    label: say(o.archived ? "restore" : "archive"),
    icon: o.archived ? "restore" : "archive",
    onSelect: () => {
      o.call("chat.archive", archiveInput(o)).catch((e) => toast(message(e), "destructive"));
    },
  };
}
