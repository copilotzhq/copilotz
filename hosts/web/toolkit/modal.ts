/**
 * A `<dialog>` shown modally while `open` (the page behind it inert, focus
 * kept inside and given back after), for `Dialog` and `Drawer`. Opened, focus
 * goes to the first thing to use in what it holds (past its header's close
 * button), or to that button when there's nothing else. Escape, a press on
 * the backdrop or `close()` all end in `onClose`.
 */
import { type PointerEvent, useEffect, useRef } from "react";

/** What takes focus first: something to use, outside the header. */
const FIRST = ":is(input, textarea, select, button, a[href], [tabindex]):not(" +
  '.copilotz-dialog-head *, .copilotz-drawer-head *, :disabled, [tabindex="-1"], [hidden])';

export function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>(FIRST)?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return {
    ref,
    events: {
      onClose: () => onClose(),
      // Only a press that starts and ends on the backdrop (the dialog itself, outside its box).
      onPointerDown: (event: PointerEvent<HTMLDialogElement>) => {
        pressed.current = event.target === event.currentTarget;
      },
      onClick: (event: { target: unknown; currentTarget: HTMLDialogElement }) => {
        if (pressed.current && event.target === event.currentTarget) event.currentTarget.close();
        pressed.current = false;
      },
    },
  };
}
