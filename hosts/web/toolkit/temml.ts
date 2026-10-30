/**
 * Temml, loaded the first time a formula needs it: a dynamic import, which a
 * bundle split by code (`deno bundle --code-splitting`) makes a file of its
 * own, so a page with no math never fetches it. When it arrives, every
 * formula waiting for it redraws; if it can't be fetched (offline), the next
 * formula tries again.
 */
import { useEffect, useSyncExternalStore } from "react";

/** What a formula needs of Temml. */
export type Temml = { renderToString: typeof import("temml").renderToString };

let loaded: Temml | undefined;
let loading: Promise<void> | undefined;
const waiting = new Set<() => void>();

/** Starts loading Temml, once. */
export function loadTemml(): Promise<void> {
  return loading ??= import("temml").then(
    (module) => {
      loaded = module.default;
      for (const redraw of waiting) redraw();
    },
    () => {
      loading = undefined;
    },
  );
}

/** Temml, once it's here; asking for it starts loading it. */
export function useTemml(): Temml | undefined {
  useEffect(() => void loadTemml(), []);
  return useSyncExternalStore(
    (redraw: () => void) => {
      waiting.add(redraw);
      return () => void waiting.delete(redraw);
    },
    () => loaded,
    () => undefined,
  );
}
