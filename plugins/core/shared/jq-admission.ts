/** Internal clock seam: cancellation is portable across browser and server timers. */
export interface JqClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export const systemJqClock: Readonly<JqClock> = Object.freeze({
  now: () => performance.now(),
  schedule(callback: () => void, delayMs: number) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

export interface JqPermit {
  release(): void;
}

export interface JqAdmission {
  acquire(signal?: AbortSignal): Promise<JqPermit>;
}

interface Waiter {
  pending: boolean;
  deadline: number;
  signal?: AbortSignal;
  abort: () => void;
  removeAbort?: () => void;
  cancelTimer?: () => void;
  resolve: (permit: JqPermit) => void;
  reject: (reason: unknown) => void;
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** FIFO allocation ownership; a released permit does not prove physical Worker exit. */
export function createJqAdmission(
  options: {
    activeLimit: number;
    pendingLimit: number;
    waitMs: number;
  },
  clock: JqClock = systemJqClock,
): JqAdmission {
  const { activeLimit, pendingLimit, waitMs } = options;
  if (!Number.isSafeInteger(activeLimit) || activeLimit <= 0) {
    throw new Error("jq active limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(pendingLimit) || pendingLimit < 0) {
    throw new Error("jq pending limit must be a nonnegative safe integer.");
  }
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    throw new Error("jq admission wait must be a positive finite duration.");
  }
  const now = clock.now.bind(clock);
  const schedule = clock.schedule.bind(clock);
  const queue: Waiter[] = [];
  let active = 0;
  let draining = false;
  const waitError = () =>
    new Error(`jq exceeded its ${waitMs / 1000} second admission wait limit.`);

  function detach(waiter: Waiter): { error: unknown } | undefined {
    waiter.pending = false;
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
    const cancelTimer = waiter.cancelTimer;
    waiter.cancelTimer = undefined;
    const removeAbort = waiter.removeAbort;
    waiter.removeAbort = undefined;
    let failure: { error: unknown } | undefined;
    for (const cleanup of [removeAbort, cancelTimer]) {
      try {
        cleanup?.();
      } catch (error) {
        failure ??= { error };
      }
    }
    return failure;
  }

  function permit(): JqPermit {
    active++;
    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        released = true;
        active--;
        drain();
      },
    });
  }

  function reject(waiter: Waiter, reason: unknown): void {
    if (!waiter.pending) return;
    detach(waiter);
    waiter.reject(reason);
    drain();
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (active < activeLimit && queue.length > 0) {
        const waiter = queue[0];
        if (waiter.signal?.aborted) {
          reject(waiter, aborted(waiter.signal));
        } else if (now() >= waiter.deadline) {
          reject(waiter, waitError());
        } else {
          // Charge before cleanup or promise resolution: either can lead to
          // another acquisition before this consumer's continuation runs.
          const granted = permit();
          const failure = detach(waiter);
          if (failure) {
            waiter.reject(failure.error);
            granted.release();
          } else {
            waiter.resolve(granted);
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  return Object.freeze({
    acquire(signal?: AbortSignal): Promise<JqPermit> {
      if (signal?.aborted) return Promise.reject(aborted(signal));
      if (!draining && active < activeLimit && queue.length === 0) {
        return Promise.resolve(permit());
      }
      if (queue.length >= pendingLimit) {
        return Promise.reject(
          new Error(
            `jq admission queue is full (${pendingLimit} waiting evaluations).`,
          ),
        );
      }
      return new Promise<JqPermit>((resolve, rejectPromise) => {
        const waiter: Waiter = {
          pending: true,
          deadline: now() + waitMs,
          signal,
          abort: () => reject(waiter, aborted(signal!)),
          resolve,
          reject: rejectPromise,
        };
        queue.push(waiter);
        const expire = () => {
          if (!waiter.pending) return;
          try {
            const remaining = waiter.deadline - now();
            if (remaining > 0) {
              waiter.cancelTimer = schedule(expire, remaining);
            } else {
              reject(waiter, waitError());
            }
          } catch (error) {
            reject(waiter, error);
          }
        };
        try {
          waiter.cancelTimer = schedule(expire, waitMs);
          if (signal) {
            waiter.removeAbort = () =>
              signal.removeEventListener("abort", waiter.abort);
            signal.addEventListener("abort", waiter.abort, { once: true });
          }
          if (signal?.aborted) waiter.abort();
          drain();
        } catch (error) {
          reject(waiter, error);
        }
      });
    },
  });
}
