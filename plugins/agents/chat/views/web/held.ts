/**
 * Whether agents are working in a conversation, held a moment after they
 * stop: a turn runs in steps, and between two (its `live` document gone,
 * the next not yet there) about 50 ms pass, which mustn't read as the turn
 * being over. On at once; off once it's stayed off for `ms`. A store, for
 * `useSyncExternalStore`.
 */

/** How long it holds after the last live document goes. */
export const HOLD_MS = 600;

export function held(ms = HOLD_MS, on = false) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const changed = (now: boolean) => {
    on = now;
    for (const listener of listeners) listener();
  };
  return {
    get: () => on,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** What's live now: on, it's on at once; off, it goes off unless it comes back within `ms`. */
    set(now: boolean) {
      if (now) {
        clearTimeout(timer);
        timer = undefined;
        if (!on) changed(true);
      } else if (on && !timer) {
        timer = setTimeout(() => {
          timer = undefined;
          changed(false);
        }, ms);
      }
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
