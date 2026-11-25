/**
 * Asking before going on, as state: what a `ConfirmDialog` does while what
 * it confirms runs (busy, then done or failed with its words), and the
 * questions `confirm()` asks from anywhere, outside React, which the page's
 * `<Toasts />` shows one at a time (see confirm-dialog.tsx).
 */
import type { ReactNode } from "react";
import { wordsOf } from "./form-submit.ts";
import { toastState } from "./toast-state.ts";

/** What a confirm dialog asks, and what confirming does. */
export type ConfirmOptions = {
  /** The question: "Delete Ana Silva?" */
  title: ReactNode;
  /** What follows from it, under the title: "Her visits are deleted too. This can't be undone." */
  message?: ReactNode;
  /** The confirm button's words: "Delete" with `danger`, "Confirm" otherwise, by default. */
  confirmLabel?: ReactNode;
  /** The cancel button's words: "Cancel" by default. */
  cancelLabel?: ReactNode;
  /** A destructive confirm button (a delete), and Cancel focused, so Enter doesn't do it. */
  danger?: boolean;
  /**
   * What confirming does, if anything: while it runs, its button is busy and the dialog stays
   * open; a failure shows its words and keeps it open; done, the dialog closes.
   */
  onConfirm?(): unknown;
  /** What a toast says once it's done (`"Customer deleted."`). */
  toast?: ReactNode;
  /** More, under the message: what's affected, a list. */
  children?: ReactNode;
};

/** A confirm dialog's state while what it confirms runs: busy, then its failure's words if any. */
export type Confirming = { busy: boolean; error?: string };

/**
 * Runs what confirming does: busy while it runs; `true` once it's done, or `false` with the
 * failure's words kept to show (`failed` when it has none).
 */
export async function runConfirm(
  run: (() => unknown) | undefined,
  set: (state: Confirming) => void,
  failed: string,
): Promise<boolean> {
  set({ busy: true });
  try {
    await run?.();
    set({ busy: false });
    return true;
  } catch (error) {
    set({ busy: false, error: wordsOf(error) ?? failed });
    return false;
  }
}

/** A question `confirm()` asked, waiting for its answer. */
export type Asked = { id: number; options: ConfirmOptions; answer(yes: boolean): void };

let asked: Asked[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = (next: Asked[]) => {
  asked = next;
  for (const listener of listeners) listener();
};

/** Listens for questions asked and answered (`useSyncExternalStore`'s subscribe). */
export const subscribeAsked = (listener: () => void): () => void => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The questions waiting, the first one shown (`useSyncExternalStore`'s snapshot). */
export const askedNow = (): Asked[] => asked;

/** None, as a page made on the server has. */
export const NONE_ASKED: Asked[] = [];

/**
 * Asks before going on, in a `ConfirmDialog` over the page, from anywhere: a row's button, a
 * handler, a plain function. Resolves `true` once confirmed (and its `onConfirm` done), `false`
 * when cancelled. It shows where `<Toasts />` is (the Copilotz shell has one; an app's own frame
 * draws it once), one question at a time; with none on the page it rejects, saying so.
 *
 * ```ts
 * await confirm({
 *   title: `Delete ${customer.name}?`,
 *   danger: true,
 *   toast: "Customer deleted.",
 *   onConfirm: () => ctx.db.collection("customer").deleteOne({ _id: customer._id }),
 * });
 * ```
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (toastState().shownBy === undefined) {
    return Promise.reject(
      new Error("confirm() shows its dialog where <Toasts /> is: draw it once in the app's frame."),
    );
  }
  // What had focus as it asked (the button pressed) has it back once it's answered, if it's there.
  const from = globalThis.document?.activeElement as
    | { focus?(): void; isConnected?: boolean }
    | null;
  return new Promise((resolve) => {
    const id = nextId++;
    const answer = (yes: boolean) => {
      if (!asked.some((a) => a.id === id)) return;
      emit(asked.filter((a) => a.id !== id));
      if (from?.isConnected) from.focus?.();
      resolve(yes);
    };
    emit([...asked, { id, options, answer }]);
  });
}
