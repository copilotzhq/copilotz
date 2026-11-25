/**
 * The focus back where it was once a dialog is gone: `ConfirmDialog`, `useConfirm` and
 * `RecordDialog` take their `<dialog>` off the page when they close, so the browser doesn't give
 * it back itself. What had the focus as the dialog opened has it again, if it's still on the
 * page and nothing else took the focus meanwhile.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Focusable } from "./confirm-state.ts";

/** What has the focus now, if anything does. */
export const focused = (): Focusable | null =>
  (globalThis.document?.activeElement as Focusable | null | undefined) ?? null;

/**
 * Gives the focus back to `opener`, once a dialog is gone: only if the focus went with it (it's
 * on the page's body, or on something no longer there) and `opener` is still on the page.
 */
export function giveBack(opener: Focusable | null | undefined): void {
  const document = globalThis.document;
  if (!document || !opener || opener === document.body || !opener.isConnected) return;
  const now = document.activeElement as Focusable | null;
  if (!now || now === document.body || !now.isConnected) opener.focus?.();
}

/** Whether the focus is nowhere: on the page's body, or on something no longer there. */
const lost = (now: Focusable | null) =>
  !now || now === globalThis.document?.body || !now.isConnected;

/**
 * The opener of a dialog that went in this very commit: one that takes its place (a new `key`)
 * opens with the focus already gone with it, and gives the focus back, in the end, there.
 */
let handoff: Focusable | null = null;

/**
 * While `open`: remembers what has the focus as it opens (in a layout effect, before the
 * dialog's own effect moves it in), and gives it back when it closes or goes (in a passive
 * cleanup, after the `<dialog>` is off the page, which then isn't inert). A dialog that opens as
 * another goes (a new `key`) takes that one's opener.
 */
export function useReturnFocus(open: boolean): void {
  const opener = useRef<Focusable | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const now = focused();
    opener.current = lost(now) && handoff ? handoff : now;
    return () => {
      // A dialog going: one opening in the same commit takes its opener.
      const mine = opener.current;
      handoff = mine;
      queueMicrotask(() => {
        if (handoff === mine) handoff = null;
      });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    return () => giveBack(opener.current);
  }, [open]);
}
