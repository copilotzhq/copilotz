/**
 * `useConfirm`'s questions, as state (see confirm-dialog.tsx): the questions one component
 * asked, in order, shown where it draws its `{dialog}`: the first one waiting, over those whose
 * operation runs (a question asked from a question's `onConfirm` shows over it). Each is
 * answered once. They belong to the component that asks: when it goes, or the `{dialog}` that
 * shows them does, a question still waiting is answered no and never shows again, and one whose
 * operation runs is answered by how that ends. A question asked while others are on the screen
 * gives the focus back, in the end, where the first of them would.
 */

/** What can have the focus back once a question is answered. */
export type Focusable = { focus?(): void; isConnected?: boolean };

/** A question asked and not yet answered. */
export type Asked<O> = {
  id: number;
  options: O;
  /** What had the focus as it was asked (the button pressed), or the first question's. */
  opener: Focusable | null;
  /** Its operation runs: it stays on the screen, busy, under the next question. */
  running: boolean;
};

/** One component's questions. */
export type Questions<O> = {
  /** Asks: the answer, once given. No `{dialog}` ever drawn: a mistake, rejected at once. */
  ask(options: O, opener?: Focusable | null): Promise<boolean>;
  /** The questions shown or waiting, in order (`useSyncExternalStore`'s snapshot). */
  queue(): readonly Asked<O>[];
  /** The questions on the screen: those whose operation runs, and the first waiting after them. */
  visible(): readonly Asked<O>[];
  /** Listens for changes (`useSyncExternalStore`'s subscribe). */
  subscribe(listener: () => void): () => void;
  /**
   * A `{dialog}` is drawn; gives back what takes it away. The first one drawn shows them; when it
   * goes, the questions it showed go with it, and another shows the rest.
   */
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

/**
 * Of the questions waiting, those on the screen, in order: every one whose operation runs (one
 * is never hidden while it runs), and the first one waiting.
 */
export function visibleOf<O>(queue: readonly Asked<O>[]): readonly Asked<O>[] {
  const next = queue.find((q) => !q.running);
  return queue.filter((q) => q.running || q === next);
}

export function questions<O>(): Questions<O> {
  let queue: readonly Asked<O>[] = [];
  let closed = false;
  let drawn = false;
  let nextId = 1;
  const hosts: object[] = [];
  const answers = new Map<number, (yes: boolean) => void>();
  const busy = new Set<number>();
  const visible = () => visibleOf(queue);
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
        // Asked from a question on the screen: the focus goes back where that one's would.
        const from = queue.length ? queue[0].opener : opener;
        queue = [...queue, { id, options, opener: from, running: false }];
        emit();
      });
    },
    queue: () => queue,
    visible,
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
        if (at < 0) return;
        hosts.splice(at, 1);
        if (!hosts.length) return dropAll();
        // What the host that goes showed goes with it; another never shows it again.
        if (at === 0) {
          const shown = visible();
          queue = queue.filter((q) => !shown.includes(q));
          for (const q of shown) {
            if (busy.has(q.id)) continue;
            const answer = answers.get(q.id);
            answers.delete(q.id);
            answer?.(false);
          }
        }
        emit();
      };
    },
    shower: () => hosts[0],
    running(id, yes) {
      if (yes) busy.add(id);
      else busy.delete(id);
      if (queue.some((q) => q.id === id && q.running !== yes)) {
        queue = queue.map((q) => (q.id === id ? { ...q, running: yes } : q));
        emit();
      }
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
