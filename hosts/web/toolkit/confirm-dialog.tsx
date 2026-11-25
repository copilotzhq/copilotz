/**
 * Asking before going on: a question (`title`), what follows from it (`message`), Cancel, and a
 * button that confirms (`confirmLabel`; `danger` makes it a destructive one, for a delete).
 * `onConfirm` may be async: while it runs, its button is busy and the dialog can't be dismissed
 * (Escape, the backdrop and × wait). A failure shows its words in the dialog, which stays open
 * to try again or cancel. Once it's done, the dialog says `toast`, if given, and closes.
 *
 * Focus goes to the confirm button, so Enter confirms; with `danger` it goes to Cancel, so
 * Enter never deletes. It's an `alertdialog`, named by its title and described by its message,
 * and the focus goes back to what opened it. Its words are the toolkit's (`toolkit.confirm`,
 * `toolkit.delete`, `toolkit.cancel`, and `toolkit.notDone` for a failure that has none).
 *
 * Two ways to ask:
 *
 * - **`useConfirm()`**, from a handler: `const [dialog, confirm] = useConfirm()`, `{dialog}`
 *   drawn once in the same component, then `await confirm({ … })`: `true` once confirmed (and
 *   `onConfirm` done), `false` when cancelled. Questions show one at a time, in order. They
 *   belong to the component: when it goes (or stops drawing `{dialog}`), one still waiting is
 *   answered `false` and never shows again.
 * - **`ConfirmDialog`**, a component: a dialog View at an address, or one the screen's state
 *   opens. It's open while `open` (`true` by default), and `onClose` says it's done: cancelled,
 *   or confirmed and done. One element is one question: when what it asks about changes while
 *   it's open, give it a new `key` (the record's id).
 *
 * An operation that ends after its question is gone (the component went, the dialog closed, or
 * a new `key` replaced it) closes nothing: its outcome is a toast, `toast` when it's done, its
 * words (`destructive`) when it failed.
 *
 * ```tsx
 * const [dialog, confirm] = useConfirm();
 * const remove = (customer: Customer) =>
 *   confirm({
 *     title: `Delete ${customer.name}?`,
 *     message: "Their visits stay, under their name. This can't be undone.",
 *     danger: true,
 *     toast: "Customer deleted.",
 *     onConfirm: () => customers.deleteOne({ _id: customer._id }),
 *   });
 * return <>{rows}{dialog}</>;
 *
 * // A dialog View at /customers/12/delete:
 * <ConfirmDialog
 *   key={customer._id}
 *   title={`Delete ${customer.name}?`}
 *   danger
 *   onConfirm={() => customers.deleteOne({ _id: customer._id })}
 *   onClose={() => go("/customers")}
 * />
 * ```
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "./button.tsx";
import { type Questions, questions } from "./confirm-state.ts";
import { Dialog } from "./dialog.tsx";
import { wordsOf } from "./form-submit.ts";
import { Notice } from "./notice.tsx";
import { focused, giveBack, useReturnFocus } from "./return-focus.ts";
import { Stack } from "./stack.tsx";
import { Text } from "./text.tsx";
import { toast } from "./toast-state.ts";
import { say } from "./words.ts";

/** What a confirmation asks, and what confirming does. */
export type ConfirmOptions = {
  /** The question, which names the dialog: "Delete Ana Silva?" */
  title: ReactNode;
  /** What follows from it, which describes the dialog: "Her visits stay. This can't be undone." */
  message?: ReactNode;
  /** More, under the message: what's affected (a list). */
  children?: ReactNode;
  /** The confirm button's words: "Delete" with `danger`, "Confirm" otherwise. */
  confirmLabel?: ReactNode;
  /** The cancel button's words: "Cancel". */
  cancelLabel?: ReactNode;
  /** A destructive action: a destructive button, and Cancel has the focus, so Enter never does it. */
  danger?: boolean;
  /**
   * What confirming does, if anything. While it runs, the confirm button is busy and the dialog
   * can't be dismissed. A throw shows its words in the dialog, which stays open to try again or
   * cancel. Done, the dialog closes. Without it, confirming closes the dialog at once.
   */
  onConfirm?(): unknown;
  /** What a toast says once it's done: "Customer deleted." */
  toast?: ReactNode;
};

/** A `ConfirmDialog`'s props: the question, what confirming does, and whether it's open. */
export type ConfirmDialogProps = Omit<ConfirmOptions, "onConfirm"> & {
  /** Whether it's open: `true` by default, for a dialog View shown at an address. */
  open?: boolean;
  /** What confirming does (see `ConfirmOptions.onConfirm`). */
  onConfirm(): unknown;
  /**
   * It's done: cancelled (Cancel, Escape, the backdrop, ×), or confirmed and done. Called once.
   * Closing it yourself (`open={false}`, or not drawing it) calls nothing.
   */
  onClose(): void;
};

/**
 * Asks before a destructive action, as a component: a dialog View at an address, or one the
 * screen's state opens. One element is one question: give each its own `key`. For asking from
 * a handler, see `useConfirm`.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const open = props.open !== false;
  useReturnFocus(open);
  if (!open) return null;
  return (
    <Question
      question={props}
      onCancel={() => props.onClose()}
      onOutcome={(done, here) => {
        if (done && here) props.onClose();
      }}
      onDismissed={() => props.onClose()}
    />
  );
}

/**
 * Asks before going on, from a handler: `const [dialog, confirm] = useConfirm()`. Draw `{dialog}`
 * once in the same component; `await confirm({ title, danger: true, onConfirm })` resolves `true`
 * once confirmed (and `onConfirm` done), `false` when cancelled. Questions show one at a time,
 * in order. When the component unmounts, or stops drawing `{dialog}`, a question still waiting
 * resolves `false` and never shows again; one whose `onConfirm` runs resolves by how it ends.
 * Asking with no `{dialog}` ever drawn rejects: it's a mistake to fix. `confirm` is the same
 * function on every render.
 */
export function useConfirm(): [
  dialog: ReactNode,
  confirm: (question: ConfirmOptions) => Promise<boolean>,
] {
  const [asked] = useState(() => questions<ConfirmOptions>());
  useEffect(() => {
    asked.open();
    return () => asked.close();
  }, [asked]);
  const confirm = useCallback(
    (question: ConfirmOptions) => asked.ask(question, focused()),
    [asked],
  );
  const dialog = useMemo(() => <ConfirmHost asked={asked} />, [asked]);
  return [dialog, confirm];
}

/** Where `useConfirm`'s questions show: the first one waiting, if this host is the first drawn. */
function ConfirmHost({ asked }: { asked: Questions<ConfirmOptions> }): ReactNode {
  const [token] = useState(() => ({}));
  useLayoutEffect(() => asked.host(token), [asked, token]);
  const queue = useSyncExternalStore(asked.subscribe, asked.queue, asked.queue);
  const shows = useSyncExternalStore(
    asked.subscribe,
    () => asked.shower() === token,
    () => false,
  );
  const first = shows ? queue[0] : undefined;
  useEffect(() => {
    if (!first) return;
    // The last question answered: the focus goes back to what had it as it was asked.
    return () => {
      if (!asked.queue().length) giveBack(first.opener);
    };
  }, [first, asked]);
  if (!first) return null;
  return (
    <Question
      key={first.id}
      question={first.options}
      onCancel={() => asked.settle(first.id, false)}
      onRunning={(yes) => asked.running(first.id, yes)}
      onOutcome={(done, here) => {
        // A failure shown in the dialog waits for a try again, or a cancel.
        if (done || !here) asked.settle(first.id, done);
      }}
      onDismissed={() => asked.drop(first.id)}
    />
  );
}

/** One question, for as long as it's shown: what it asks, and what its operation is doing. */
function Question(
  props: {
    question: ConfirmOptions;
    /** Cancelled while nothing runs: Cancel, Escape, the backdrop, ×. */
    onCancel(): void;
    /** Its operation ended, done or not, and whether its question was still shown. */
    onOutcome(done: boolean, here: boolean): void;
    /** The browser closed it while its operation runs: it goes on, out of view. */
    onDismissed(): void;
    onRunning?(yes: boolean): void;
  },
): ReactNode {
  const { question } = props;
  const id = useId();
  const [state, setState] = useState<{ busy: boolean; error?: ReactNode }>({ busy: false });
  const latest = useRef(props);
  latest.current = props;
  const running = useRef(false);
  /** Shown, and not dismissed: what its operation's end may still act on. */
  const here = useRef(false);
  useLayoutEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  // The focus on the safe button: Cancel for a delete, Confirm otherwise; again after a failure.
  const safe = question.danger ? "cancel" : "confirm";
  useEffect(() => {
    if (!state.busy) document.getElementById(`${id}-${safe}`)?.focus();
  }, [state, id, safe]);

  const confirmIt = async () => {
    if (running.current) return;
    running.current = true;
    const asked = latest.current.question;
    latest.current.onRunning?.(true);
    setState({ busy: true });
    let done = true;
    let failure: unknown;
    try {
      await asked.onConfirm?.();
    } catch (error) {
      done = false;
      failure = error;
    }
    running.current = false;
    const now = latest.current;
    now.onRunning?.(false);
    const shown = here.current;
    if (done) {
      setState({ busy: false });
      if (now.question.toast) toast(now.question.toast, "success");
    } else {
      const words = wordsOf(failure) ?? say("notDone");
      setState({ busy: false, error: shown ? words : undefined });
      if (!shown) toast(words, "destructive");
    }
    now.onOutcome(done, shown);
  };
  const cancel = () => {
    if (!running.current) latest.current.onCancel();
  };
  const closed = () => {
    if (!running.current) return latest.current.onCancel();
    here.current = false;
    latest.current.onDismissed();
  };

  const body = question.message || question.children || state.error;
  return (
    <Dialog
      open
      onClose={closed}
      title={question.title}
      size="sm"
      role="alertdialog"
      busy={state.busy}
      aria-describedby={question.message ? `${id}-message` : undefined}
      bare
      footer={
        <>
          <Button id={`${id}-cancel`} onClick={cancel} disabled={state.busy}>
            {question.cancelLabel ?? say("cancel")}
          </Button>
          <Button
            id={`${id}-confirm`}
            variant={question.danger ? "destructive" : "primary"}
            loading={state.busy}
            onClick={() => void confirmIt()}
          >
            {question.confirmLabel ?? say(question.danger ? "delete" : "confirm")}
          </Button>
        </>
      }
    >
      {body
        ? (
          <div className="copilotz-dialog-body">
            <Stack gap="md">
              {question.message
                ? <Text as="p" id={`${id}-message`}>{question.message}</Text>
                : null}
              {question.children}
              {state.error ? <Notice tone="destructive" role="alert">{state.error}</Notice> : null}
            </Stack>
          </div>
        )
        : null}
    </Dialog>
  );
}
