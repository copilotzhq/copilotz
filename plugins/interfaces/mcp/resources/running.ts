/**
 * Calls running now, counted by the MCP route for its limits at once: in
 * the runtime, on a line, from a caller's address, in a conversation. Kept
 * by runtime, so under the orgs host (a runtime each) one org's calls never
 * take another's places. A request takes its places whole or not at all,
 * and gives them back once it's answered. In this process's memory: a
 * runtime's calls all come through it.
 */

/** One count a request goes by: its key, the most it may reach, and how much the request adds. */
export type Place = { key: string; most: number; adds?: number };

const running = new WeakMap<object, Map<string, number>>();

/** Takes every place, or none: its release (once), or undefined when one is full. */
export function hold(runtime: object, places: Place[]): (() => void) | undefined {
  const counts = running.get(runtime) ?? new Map<string, number>();
  running.set(runtime, counts);
  if (places.some((p) => (counts.get(p.key) ?? 0) + (p.adds ?? 1) > p.most)) return undefined;
  for (const p of places) counts.set(p.key, (counts.get(p.key) ?? 0) + (p.adds ?? 1));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const p of places) {
      const left = (counts.get(p.key) ?? 0) - (p.adds ?? 1);
      if (left > 0) counts.set(p.key, left);
      else counts.delete(p.key);
    }
  };
}

/** What a request too many is told, and thrown with, to answer as busy. */
export const busy = () =>
  Object.assign(new Error("Busy: too many calls at once. Try again in a moment."), {
    busy: true as const,
  });

export const isBusy = (error: unknown) => (error as { busy?: unknown })?.busy === true;
