/**
 * xterm.js, loaded the first time a terminal shows: dynamic imports (its
 * code, its fit addon, its stylesheet), which a bundle split by code
 * (`deno bundle --code-splitting`) makes files of their own, so a page with
 * no terminal never fetches them. As `temml.ts` does for math: every
 * terminal waiting for it draws once it's here; if it can't be fetched
 * (offline), the next terminal tries again.
 */
import { type ReactElement, useEffect, useSyncExternalStore } from "react";

/** What a terminal needs of xterm.js. */
export type Xterm = {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  /** Its stylesheet, as the page takes it. */
  sheet: ReactElement;
};

let loaded: Xterm | undefined;
let failed: unknown;
let loading: Promise<void> | undefined;
const waiting = new Set<() => void>();
const redraw = () => {
  for (const each of waiting) each();
};

/** Starts loading xterm.js, once. */
export function loadXterm(): Promise<void> {
  return loading ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("./xterm-style.ts"),
  ]).then(
    ([xterm, fit, style]) => {
      loaded = { Terminal: xterm.Terminal, FitAddon: fit.FitAddon, sheet: style.XTERM_SHEET };
      failed = undefined;
      redraw();
    },
    (error) => {
      loading = undefined;
      failed = error;
      redraw();
    },
  );
}

/** xterm.js once it's here (or why it couldn't come); asking for it starts loading it. */
export function useXterm(): { xterm?: Xterm; error?: unknown } {
  useEffect(() => void loadXterm(), []);
  const subscribe = (again: () => void) => {
    waiting.add(again);
    return () => void waiting.delete(again);
  };
  const xterm = useSyncExternalStore(subscribe, () => loaded, () => undefined);
  const error = useSyncExternalStore(subscribe, () => failed, () => undefined);
  return { xterm, error };
}
