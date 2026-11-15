/**
 * Text handed to a conversation's composer from elsewhere on this page: a
 * question typed in a contact's chat, moved to its staff notes before it went
 * where the contact reads it; or an app's own front end putting words where
 * the person types (a reply it suggests, a template picked), through chat's
 * contract (`handDraft`). It waits under the conversation it's for until that
 * composer takes it (now, or once it's shown), so handing it over doesn't
 * depend on which is drawn first. Plain code, no React: the composer follows
 * it with `onHanded`.
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/**
 * Hands `text` to the composer of conversation `thread` on this page, after
 * anything handed there already: typed in after what's there, ready to send
 * or change. The person sends it; nothing goes by itself.
 *
 * ```ts
 * import { handDraft } from "copilotz/plugins/agents/contract";
 * handDraft(ctx.hints.thread, "Your order 12 left today.");
 * ```
 */
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

/** What waits for `thread`'s composer, not taken yet. */
export const handedTo = (thread?: string): string | undefined =>
  thread ? drafts.get(thread) : undefined;

/** Hears that something was handed or taken, until the function it returns is called. */
export function onHanded(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
