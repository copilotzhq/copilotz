/// <reference lib="dom" />
/**
 * What someone wrote and hasn't saved, kept in this browser per person and
 * document, so a closed tab or a lost connection loses nothing: the text and
 * title, and the version they started from (with its text, to merge with
 * what others saved since). Gone once it's saved.
 */

export type Draft = {
  base: number;
  baseText: string;
  baseTitle: string;
  text: string;
  title: string;
  at: string;
};

const key = (viewer: string, document: string) => `copilotz-document-draft:${viewer}:${document}`;

/** The draft kept for a document, if there's one. */
export function draftOf(viewer: string, document: string): Draft | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key(viewer, document));
    const draft = raw ? JSON.parse(raw) as Draft : undefined;
    return draft && typeof draft.text === "string" && typeof draft.base === "number"
      ? draft
      : undefined;
  } catch {
    return undefined;
  }
}

export function keepDraft(viewer: string, document: string, draft: Draft): void {
  try {
    globalThis.localStorage?.setItem(key(viewer, document), JSON.stringify(draft));
  } catch { /* Kept in the page only: storage is full, or not ours to use. */ }
}

export function dropDraft(viewer: string, document: string): void {
  try {
    globalThis.localStorage?.removeItem(key(viewer, document));
  } catch { /* Nothing kept. */ }
}
