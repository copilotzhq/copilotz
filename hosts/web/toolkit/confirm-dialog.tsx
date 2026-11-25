/**
 * Asking before going on: a question (`title`), what follows from it
 * (`message`), Cancel, and a button that confirms (`confirmLabel`;
 * `danger` makes it a destructive one, for a delete). `onConfirm` may be
 * async: while it runs, its button is busy and the dialog stays open
 * (Escape and the backdrop wait); a failure shows its words in the dialog,
 * which stays open to try again or cancel; once it's done, the dialog
 * closes (`onClose`), with a `toast` if given. Cancel, Escape and the
 * backdrop close it too.
 *
 * Focus goes to the confirm button, so Enter confirms; with `danger` it
 * goes to Cancel, so Enter never deletes. It's an `alertdialog`, named by
 * its title and described by its message. Its words are the toolkit's
 * (`toolkit.confirm`, `toolkit.delete`, `toolkit.cancel`, and
 * `toolkit.notDone` for a failure that has none).
 *
 * As a component it's controlled: open while `open` (`true` by default, for
 * a dialog View shown at an address). `confirm(options)` asks the same from
 * anywhere, a row's button or a handler, with no state of its own: it shows
 * where `<Toasts />` is and resolves `true` once confirmed and done.
 *
 * ```tsx
 * <ConfirmDialog
 *   title={`Delete ${customer.name}?`}
 *   message="Their visits stay, under their name. This can't be undone."
 *   danger
 *   toast="Customer deleted."
 *   onConfirm={() => ctx.db.collection("customer").deleteOne({ _id: customer._id })}
 *   onClose={() => go("/customers")}
 * />
 * ```
 */
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "./button.tsx";
import {
  askedNow,
  type Confirming,
  type ConfirmOptions,
  NONE_ASKED,
  runConfirm,
  subscribeAsked,
} from "./confirm-state.ts";
import { Dialog } from "./dialog.tsx";
import { Notice } from "./notice.tsx";
import { Stack } from "./stack.tsx";
import { Text } from "./text.tsx";
import { toast } from "./toast-state.ts";
import { say } from "./words.ts";

export { confirm, type ConfirmOptions } from "./confirm-state.ts";

/** A `ConfirmDialog`'s props: what it asks, what confirming does, and where it's open. */
export type ConfirmDialogProps = Omit<ConfirmOptions, "onConfirm"> & {
  /** Whether it's open: `true` by default, for a dialog View shown at an address. */
  open?: boolean;
  /** What confirming does: busy while it runs, kept open with its words if it fails. */
  onConfirm(): unknown;
  /** It closes: cancelled (Cancel, Escape, the backdrop), or confirmed and done. */
  onClose(): void;
};

export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  return props.open === false ? null : <Question {...props} />;
}

function Question({ onConfirm, onClose, toast: done, ...asked }: ConfirmDialogProps): ReactNode {
  const [state, setState] = useState<Confirming>({ busy: false });
  const running = useRef<symbol | undefined>(undefined);
  const id = useId();
  useLayoutEffect(() => {
    // Activity can reconnect this question after its pending confirmation was dropped.
    setState((previous) => previous.busy ? { busy: false } : previous);
    return () => {
      running.current = undefined;
    };
  }, []);
  const confirmIt = async () => {
    if (running.current) return;
    const question = Symbol();
    running.current = question;
    const finished = await runConfirm(onConfirm, (state) => {
      if (running.current === question) setState(state);
    }, say("notDone"));
    if (running.current !== question) return;
    running.current = undefined;
    if (!finished) return;
    if (done) toast(done, "success");
    onClose();
  };
  return (
    <ConfirmView
      {...asked}
      id={id}
      open
      busy={state.busy}
      error={state.error}
      onConfirm={confirmIt}
      onCancel={onClose}
    />
  );
}

/**
 * What a confirm dialog draws, for a state: busy (its confirm button waiting, the dialog kept
 * open), and a failure's words. `ConfirmDialog` keeps the state; tests draw it as it is.
 */
export function ConfirmView(
  {
    id,
    open,
    title,
    message,
    confirmLabel,
    cancelLabel,
    danger = false,
    busy,
    error,
    children,
    onConfirm,
    onCancel,
  }: Omit<ConfirmOptions, "onConfirm" | "toast"> & {
    id: string;
    open: boolean;
    busy: boolean;
    error?: string;
    onConfirm(): void;
    onCancel(): void;
  },
): ReactNode {
  useEffect(() => {
    if (!busy && error) document.getElementById(`${id}-${danger ? "cancel" : "confirm"}`)?.focus();
  }, [id, busy, error, danger]);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      role="alertdialog"
      busy={busy}
      aria-describedby={message ? `${id}-message` : undefined}
      footer={
        <>
          <Button
            id={`${id}-cancel`}
            onClick={onCancel}
            disabled={busy}
            data-autofocus={danger ? "" : undefined}
          >
            {cancelLabel ?? say("cancel")}
          </Button>
          <Button
            id={`${id}-confirm`}
            variant={danger ? "destructive" : "primary"}
            loading={busy}
            onClick={onConfirm}
            data-autofocus={danger ? undefined : ""}
          >
            {confirmLabel ?? say(danger ? "delete" : "confirm")}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {message ? <Text as="p" id={`${id}-message`}>{message}</Text> : null}
        {children}
        {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      </Stack>
    </Dialog>
  );
}

/** The first question `confirm()` is waiting on, over the page: `<Toasts />` draws it. */
export function ConfirmQuestions(): ReactNode {
  const waiting = useSyncExternalStore(subscribeAsked, askedNow, () => NONE_ASKED);
  const id = useId();
  const first = waiting[0];
  if (!first) return null;
  return (
    <ConfirmView
      key={first.id}
      id={id}
      open
      {...first.state}
      {...first.options}
      onConfirm={() => first.answer(true)}
      onCancel={() => first.answer(false)}
    />
  );
}
