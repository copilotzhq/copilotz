/**
 * A `<dialog>` shown modally while `open` (the page behind it inert, focus
 * kept inside and given back after), for `Dialog` and `Drawer`. Opened, focus
 * goes to the first thing to use in what it holds (past its header's close
 * button), or to that button when there's nothing else; or, with `focus:
 * "dialog"`, to the dialog itself (Tab then goes to its first control).
 * Escape, a press on the backdrop or `close()` all end in `onClose`. With
 * `keep` (something it started is under way), Escape and the backdrop wait:
 * its `cancel` event is refused and a press on the backdrop does nothing.
 * With `isolated`, it answers only its own `close` and `cancel` events: React
 * passes them up through its components, so without it a dialog shown inside
 * another (a confirmation over a form) closing would close the outer one too.
 */
import { type PointerEvent, type SyntheticEvent, useEffect, useRef } from "react";

/** What takes focus first: something to use, outside the header. */
const FIRST = ":is(input, textarea, select, button, a[href], [tabindex]):not(" +
  '.copilotz-dialog-head *, .copilotz-drawer-head *, :disabled, [tabindex="-1"], [hidden])';

export function useModal(
  open: boolean,
  onClose: () => void,
  { focus = "first", keep = false, isolated = false }: {
    focus?: "first" | "dialog";
    /** It stays open: Escape and a press on the backdrop wait (it's busy). */
    keep?: boolean;
    /** It answers only its own `close` and `cancel`, not a dialog's shown inside it. */
    isolated?: boolean;
  } = {},
) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (focus === "dialog") dialog.focus();
      else dialog.querySelector<HTMLElement>(FIRST)?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return {
    ref,
    events: {
      onClose: isolated
        ? (event: SyntheticEvent<HTMLDialogElement>) => {
          if (event.target === event.currentTarget) onClose();
        }
        : () => onClose(),
      // Escape, or the browser's own light dismiss: refused while it's kept open.
      ...(keep
        ? {
          onCancel: (event: SyntheticEvent<HTMLDialogElement>) => {
            if (!isolated || event.target === event.currentTarget) event.preventDefault();
          },
        }
        : {}),
      // Only a press that starts and ends on the backdrop (the dialog itself, outside its box).
      onPointerDown: (event: PointerEvent<HTMLDialogElement>) => {
        pressed.current = event.target === event.currentTarget;
      },
      onClick: (event: { target: unknown; currentTarget: HTMLDialogElement }) => {
        if (pressed.current && event.target === event.currentTarget && !keep) {
          event.currentTarget.close();
        }
        pressed.current = false;
      },
    },
  };
}
