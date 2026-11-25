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

/** Gives the focus back to `opener` if the focus went with the dialog and `opener` is still there. */
export function giveBack(opener: Focusable | null | undefined): void {
  const document = globalThis.document;
  if (!document || !opener || opener === document.body || !opener.isConnected) return;
  const now = document.activeElement as Focusable | null;
  if (!now || now === document.body || !now.isConnected) opener.focus?.();
}

/**
 * While `open`: remembers what has the focus as it opens (a layout effect, before the dialog's
 * own effect moves it in), and gives it back when it closes or goes (a passive cleanup, after
 * the `<dialog>` is off the page, which then isn't inert).
 */
export function useReturnFocus(open: boolean): void {
  const opener = useRef<Focusable | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = focused();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    return () => giveBack(opener.current);
  }, [open]);
}
