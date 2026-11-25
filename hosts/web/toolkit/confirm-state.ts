/**
 * `useConfirm`'s questions, as state (see confirm-dialog.tsx): the questions one component
 * asked, in order, shown one at a time where it draws its `{dialog}`. Each is answered once.
 * They belong to the component that asks: when it goes, or its `{dialog}` does, a question still
 * waiting is answered no and never shows again; one whose operation runs is answered by how that
 * ends.
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
export type Questions<O> = ReturnType<typeof questions<O>>;

export function questions<O>() {
  let queue: readonly Asked<O>[] = [];
  let closed = false;
  let drawn = false;
  let nextId = 1;
  const hosts: object[] = [];
  const answers = new Map<number, (yes: boolean) => void>();
  const running = new Set<number>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  /** Answers a question (once) and takes it away. */
  const settle = (id: number, yes: boolean) => {
    if (!answers.has(id) && !queue.some((q) => q.id === id)) return;
    answers.get(id)?.(yes);
    answers.delete(id);
    running.delete(id);
    queue = queue.filter((q) => q.id !== id);
    emit();
  };
  /** Every question goes: those waiting are answered no; a running one, by how it ends. */
  const dropAll = () => {
    for (const q of queue) if (!running.has(q.id)) settle(q.id, false);
    queue = [];
    emit();
  };
  return {
    /** Asks; with no `{dialog}` ever drawn, rejects. */
    ask(options: O, opener: Focusable | null = null): Promise<boolean> {
      if (closed || (!hosts.length && drawn)) return Promise.resolve(false);
      if (!hosts.length) {
        return Promise.reject(new Error("useConfirm(): render {dialog} in the component."));
      }
      return new Promise<boolean>((resolve) => {
        const id = nextId++;
        answers.set(id, resolve);
        queue = [...queue, { id, options, opener }];
        emit();
      });
    },
    /** The questions shown or waiting, in order (`useSyncExternalStore`'s snapshot). */
    queue: () => queue,
    /** Listens for changes (`useSyncExternalStore`'s subscribe). */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** A `{dialog}` is drawn (the first one drawn shows them); gives back what takes it away. */
    host(token: object): () => void {
      hosts.push(token);
      drawn = true;
      emit();
      return () => {
        hosts.splice(hosts.indexOf(token), 1);
        if (!hosts.length) dropAll();
        else emit();
      };
    },
    /** The `{dialog}` that shows the questions. */
    shower: (): object | undefined => hosts[0],
    /** A question's operation started, or ended: running, it waits for its end to be answered. */
    running(id: number, yes: boolean): void {
      if (yes) running.add(id);
      else running.delete(id);
    },
    settle,
    /** The component is there (again). */
    open(): void {
      closed = false;
    },
    /** The component went: its questions are answered no, and later ones at once. */
    close(): void {
      closed = true;
      dropAll();
    },
  };
}
