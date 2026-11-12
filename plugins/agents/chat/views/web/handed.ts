/**
 * Text handed from one conversation's composer to another's, on this page:
 * a question typed in a contact's chat, moved to its staff notes before it
 * went where the contact reads it. It waits under the conversation it's for
 * until that composer takes it (now, or once it's shown), so handing it
 * over doesn't depend on which is drawn first.
 */
import { useSyncExternalStore } from "react";

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Hands `text` to the composer of `thread`, after anything handed there already. */
export function handDraft(thread: string, text: string): void {
  const before = drafts.get(thread);
  drafts.set(thread, before ? `${before}\n\n${text}` : text);
  changed();
}

/** What was handed to `thread`, taken: it's handed once. */
export function takeDraft(thread: string): string | undefined {
  const text = drafts.get(thread);
  if (text !== undefined) {
    drafts.delete(thread);
    changed();
  }
  return text;
}

/** What waits for `thread`'s composer, for a component: it draws again when something's handed. */
export function useHanded(thread?: string): string | undefined {
  const get = () => thread ? drafts.get(thread) : undefined;
  return useSyncExternalStore(subscribe, get, get);
}
