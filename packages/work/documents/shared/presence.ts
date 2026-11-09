/** Who has a document open: how long an entry lasts without word from its page, and its `_id`. */

/** How long an entry lasts without word from its page (a hidden tab's timers slow to a minute). */
export const STALE_MS = 90_000;

/** How often an open page says it's still there. */
export const BEAT_MS = 25_000;

/** An entry's `_id`: the document, who, and their page. */
export const presenceId = (document: string, who: string, page: string) =>
  `${document}|${who}|${page}`;
