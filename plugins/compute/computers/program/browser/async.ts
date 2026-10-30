/**
 * Deadlines, races and queues for the browser engine. Cancellation always
 * reaches the operation underneath; nothing is replayed behind the caller.
 */

/** A browser error, with a code its answer carries. */
export function browserError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code, browser: true });
}

/** Whether an error is the engine's own (it has a code to show). */
export const isBrowserError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && (error as { browser?: boolean }).browser === true;

/** An abort signal that fires after `ms`, or with `parent`. */
export function deadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(browserError("timeout", "Browser deadline exceeded")),
    ms,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

/** `task`, unless `signal` aborts first. */
export function race<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Waits `ms`, unless `signal` aborts first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Runs functions one after another. */
export type Queue = { run<T>(fn: () => Promise<T>): Promise<T> };

export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    },
  };
}

export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
