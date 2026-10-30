/**
 * What this browser keeps for a front end between pages and visits (a panel
 * left open, a list folded, the tab last used): strings by key, in its local
 * storage, when it lets us (a private window may not; then it's kept for the
 * page only). Key it by the person (`copilotz-panel:ana`) when two may share a
 * browser.
 *
 * ```ts
 * const open = kept("copilotz-panel:ana") === "open";
 * keep("copilotz-panel:ana", "closed");
 * ```
 */

/** What was kept under `key`, or null. */
export function kept(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Keeps `value` under `key` for next time. */
export function keep(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch { /* Kept for this page only. */ }
}
