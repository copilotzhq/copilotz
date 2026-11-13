/**
 * Whether the staff notes lane is open beside a chat shared outside its
 * space: one choice per person, kept in this browser, so whoever works with
 * notes open finds them open on the next chat too. The header's button, the
 * phone's switch, the lane's close and "Ask in staff notes" all change it,
 * wherever they are on the page, and everything showing it follows. Opened
 * by hand, the notes' box is where you type next; kept open, the chat's is.
 */
import { useSyncExternalStore } from "react";
import { keep, kept } from "../../../../../hosts/web/mod.ts";

const listeners = new Set<() => void>();
/** For a browser that keeps nothing (a private window): this page remembers. */
const page = new Map<string, boolean>();
/** Opened by someone just now (not as kept from before): where they type goes there. */
let asked = false;

const keyOf = (who: string) => `copilotz-chat-notes:${who}`;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Whether `who` has the lane open. */
export const notesOpen = (who: string): boolean => page.get(who) ?? kept(keyOf(who)) === "open";

export function setNotesOpen(who: string, open: boolean): void {
  page.set(who, open);
  asked = open;
  keep(keyOf(who), open ? "open" : "closed");
  for (const listener of listeners) listener();
}

/** Whether `who` has the lane open, for a component: it draws again when that changes. */
export function useNotesOpen(who: string): boolean {
  const get = () => notesOpen(who);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * Whether the lane was just opened by someone (their button, "Ask in staff
 * notes"), once: the notes' box takes the keys then, and not when the lane
 * shows as kept open, beside a chat whose own box has them.
 */
export function takeOpened(): boolean {
  const was = asked;
  asked = false;
  return was;
}
