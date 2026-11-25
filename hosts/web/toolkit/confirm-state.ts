/**
 * `useConfirm`'s questions, as state (see confirm-dialog.tsx): the questions one component
 * asked, in order, shown one at a time where it draws its `{dialog}`. Each is answered once.
 * They belong to the component that asks: when it goes, or its `{dialog}` does, a question
 * still waiting is answered no and never shows again, and one whose operation runs is answered
 * by how that ends.
 */

/** What can have the focus back once a question is answered. */
export type Focusable = { focus?(): void; isConnected?: boolean };

/** A question asked and not yet answered. */
export type Asked<O> = {
  id: number;
  options: O;
  /** What had the focus as it was asked (the button pressed). */
  opener: Focusable | null;
};

/** One component's questions. */
export type Questions<O> = {
  /** Asks: the answer, once given. No `{dialog}` ever drawn: a mistake, rejected at once. */
  ask(options: O, opener?: Focusable | null): Promise<boolean>;
  /** The questions shown or waiting, in order (`useSyncExternalStore`'s snapshot). */
  queue(): readonly Asked<O>[];
  /** Listens for changes (`useSyncExternalStore`'s subscribe). */
  subscribe(listener: () => void): () => void;
  /** A `{dialog}` is drawn; gives back what takes it away. The first one drawn shows them. */
  host(token: object): () => void;
  /** The `{dialog}` that shows the questions. */
  shower(): object | undefined;
  /** A question's operation started, or ended: running, it waits for its end to be answered. */
  running(id: number, yes: boolean): void;
  /** Answers a question (once) and takes it away. */
  settle(id: number, yes: boolean): void;
  /** Takes a question out of view: waiting, it's answered no; running, its end answers it. */
  drop(id: number): void;
  /** The component is there (again). */
  open(): void;
  /** The component went: its questions are answered no, and later ones at once. */
  close(): void;
};

export function questions<O>(): Questions<O> {
  let queue: readonly Asked<O>[] = [];
  let closed = false;
  let drawn = false;
  let nextId = 1;
  const hosts: object[] = [];
  const answers = new Map<number, (yes: boolean) => void>();
  const busy = new Set<number>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const remove = (id: number) => {
    if (!queue.some((q) => q.id === id)) return false;
    queue = queue.filter((q) => q.id !== id);
    return true;
  };
  const settle = (id: number, yes: boolean) => {
    const answer = answers.get(id);
    answers.delete(id);
    busy.delete(id);
    const removed = remove(id);
    answer?.(yes);
    if (removed) emit();
  };
  /** Every question out of view: those waiting are answered no. */
  const dropAll = () => {
    const waiting = queue.filter((q) => !busy.has(q.id));
    queue = [];
    for (const q of waiting) {
      const answer = answers.get(q.id);
      answers.delete(q.id);
      answer?.(false);
    }
    emit();
  };

  return {
    ask(options, opener = null) {
      if (closed || (!hosts.length && drawn)) return Promise.resolve(false);
      if (!hosts.length) {
        return Promise.reject(
          new Error(
            "useConfirm() shows its questions where its dialog is: render {dialog} in the component.",
          ),
        );
      }
      return new Promise<boolean>((resolve) => {
        const id = nextId++;
        answers.set(id, resolve);
        queue = [...queue, { id, options, opener }];
        emit();
      });
    },
    queue: () => queue,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    host(token) {
      hosts.push(token);
      drawn = true;
      emit();
      return () => {
        const at = hosts.indexOf(token);
        if (at >= 0) hosts.splice(at, 1);
        if (!hosts.length) dropAll();
        else emit();
      };
    },
    shower: () => hosts[0],
    running(id, yes) {
      if (yes) busy.add(id);
      else busy.delete(id);
    },
    settle,
    drop(id) {
      if (busy.has(id)) {
        if (remove(id)) emit();
      } else settle(id, false);
    },
    open() {
      closed = false;
    },
    close() {
      closed = true;
      dropAll();
    },
  };
}
