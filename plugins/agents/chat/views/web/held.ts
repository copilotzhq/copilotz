/**
 * Which agents are working in a conversation, each held a moment after it
 * stops: a turn runs in steps, and between two (its `live` document gone,
 * the next not yet there) about 50 ms pass, which mustn't read as the turn
 * being over. An agent is on at once; off once it's stayed off for `ms`,
 * whoever else is still working. A store, for `useSyncExternalStore`: the
 * same list until it changes.
 */

/** How long it holds after an agent's last live document goes. */
export const HOLD_MS = 600;

export function held(ms = HOLD_MS, working: string[] = []) {
  let on = [...new Set(working)].sort();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const changed = (now: string[]) => {
    on = now;
    for (const listener of listeners) listener();
  };
  return {
    get: () => on,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Who's live now: each on at once; one gone goes off unless it comes back within `ms`. */
    set(now: string[]) {
      const live = new Set(now);
      for (const agent of live) {
        clearTimeout(timers.get(agent));
        timers.delete(agent);
      }
      for (const agent of on) {
        if (live.has(agent) || timers.has(agent)) continue;
        timers.set(
          agent,
          setTimeout(() => {
            timers.delete(agent);
            changed(on.filter((other) => other !== agent));
          }, ms),
        );
      }
      const started = [...live].filter((agent) => !on.includes(agent));
      if (started.length) changed([...on, ...started].sort());
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
