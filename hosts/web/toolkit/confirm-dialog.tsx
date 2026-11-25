/**
 * Asking before going on: a question (`title`), what follows from it (`message`), Cancel, and a
 * button that confirms (`confirmLabel`; `danger` makes it a destructive one, for a delete).
 * `onConfirm` may be async: while it runs, its button is busy and the dialog can't be dismissed.
 * A failure shows its words in the dialog, which stays open to try again or cancel. Done, the
 * dialog says `toast`, if given, and closes. Focus goes to Confirm, or with `danger` to Cancel,
 * so Enter never deletes; it's an `alertdialog`, and the focus goes back to what opened it.
 *
 * - **`useConfirm()`**, from a handler: `const [dialog, confirm] = useConfirm()`, `{dialog}`
 *   drawn once in the same component, then `await confirm({ … })`. Questions show one at a time;
 *   when the component goes, one still waiting is answered `false` and never shows again.
 * - **`ConfirmDialog`**, a component: a dialog View at an address, or one the screen's state
 *   opens. One element is one question: give it the `key` of what it asks about.
 *
 * A question ends once, and takes no more actions; its actions use what it was last drawn with on
 * the screen. An operation that ends after its question is gone closes nothing: a toast says how
 * it ended.
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
  /** What confirming does: busy while it runs; a throw's words stay shown, to try again. */
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
  /** It's done (cancelled, or confirmed and done): once. Closing it yourself, never. */
  onClose(): void;
};

/** Asks before going on, as a component: one element is one question, so give it a `key`. */
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
    />
  );
}

/**
 * Asks from a handler: draw `{dialog}` once, then `await confirm({ … })`, `true` once confirmed
 * and done, `false` when cancelled or when the component goes. With no `{dialog}` ever drawn, it
 * rejects. `confirm` is the same function on every render.
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
  const shows = useSyncExternalStore(asked.subscribe, () => asked.shower() === token, () => false);
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
    />
  );
}

/** One question while it's shown: it ends once; its actions use the props last committed. */
function Question(
  props: {
    question: ConfirmOptions;
    /** Cancelled while nothing runs: Cancel, Escape, the backdrop, ×. */
    onCancel(): void;
    /** Its operation ended, done or not, and whether its question was still shown. */
    onOutcome(done: boolean, here: boolean): void;
    onRunning?(yes: boolean): void;
  },
): ReactNode {
  const { question } = props;
  const id = useId();
  const [state, setState] = useState<{ busy: boolean; error?: ReactNode; ended?: true }>({
    busy: false,
  });
  /** The props as last committed: what the person sees. */
  const committed = useRef(props);
  useLayoutEffect(() => {
    committed.current = props;
  });
  /** Asking, running what confirming does, or ended. */
  const phase = useRef<"open" | "busy" | "done">("open");
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The focus on the safe button: Cancel for a delete, Confirm otherwise; again after a failure.
  const safe = question.danger ? "cancel" : "confirm";
  useEffect(() => {
    if (!state.busy && !state.ended) document.getElementById(`${id}-${safe}`)?.focus();
  }, [state, id, safe]);

  const confirmIt = async () => {
    if (phase.current !== "open") return;
    phase.current = "busy";
    const asked = committed.current;
    asked.onRunning?.(true);
    setState({ busy: true });
    let failure: { error: unknown } | undefined;
    try {
      await asked.question.onConfirm?.();
    } catch (error) {
      failure = { error };
    }
    const now = committed.current;
    now.onRunning?.(false);
    const here = mounted.current;
    if (!failure) {
      phase.current = "done";
      setState({ busy: false, ended: true });
      if (now.question.toast) toast(now.question.toast, "success");
    } else {
      const words = wordsOf(failure.error) ?? say("notDone");
      phase.current = "open";
      setState({ busy: false, error: here ? words : undefined });
      if (!here) toast(words, "destructive");
    }
    now.onOutcome(!failure, here);
  };
  const cancel = () => {
    if (phase.current !== "open") return;
    phase.current = "done";
    setState((now) => ({ ...now, ended: true }));
    committed.current.onCancel();
  };

  const body = question.message || question.children || state.error;
  return (
    <Dialog
      open
      // While it runs, a close is waited out: the operation's end answers it.
      onClose={cancel}
      title={question.title}
      size="sm"
      role="alertdialog"
      busy={state.busy}
      isolated
      aria-describedby={question.message ? `${id}-message` : undefined}
      bare
      footer={
        <>
          <Button id={`${id}-cancel`} onClick={cancel} disabled={state.busy || state.ended}>
            {question.cancelLabel ?? say("cancel")}
          </Button>
          <Button
            id={`${id}-confirm`}
            variant={question.danger ? "destructive" : "primary"}
            loading={state.busy}
            disabled={state.ended}
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
