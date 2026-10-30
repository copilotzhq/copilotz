/// <reference lib="dom" />
/**
 * The page's side of the app being installable: it registers the service
 * worker (`/sw.js`, see `pwa.ts`), asks it now and then whether a new
 * version came (when the page is shown again, and every half hour), and
 * says when one is ready (`useUpdate`); `update()` moves to it and reloads,
 * once. A browser without service workers, or one that refuses this one,
 * goes on as a plain page.
 */
import { useSyncExternalStore } from "react";

let ready = false;
let waiting: ServiceWorker | undefined;
const listeners = new Set<() => void>();
const set = (worker: ServiceWorker | undefined) => {
  waiting = worker;
  ready = !!worker;
  for (const listener of listeners) listener();
};

/** Registers the worker, once, and follows its versions. */
export function registerWorker(): void {
  const workers = globalThis.navigator?.serviceWorker;
  if (!workers || registered) return;
  registered = true;
  workers.register("/sw.js", { scope: "/", updateViaCache: "none" }).then((registration) => {
    // A version already waiting, from a visit before: this page runs the old one.
    if (registration.waiting && workers.controller) set(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const next = registration.installing;
      next?.addEventListener("statechange", () => {
        // Installed while another one runs this page: it waits for the person's say.
        if (next.state === "installed" && workers.controller) set(next);
      });
    });
    const check = () => void registration.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    setInterval(check, 30 * 60_000);
  }, () => {});
  // Once the new version takes over, the page starts over in it (and only once).
  let reloading = false;
  workers.addEventListener("controllerchange", () => {
    if (!moving || reloading) return;
    reloading = true;
    location.reload();
  });
}

let registered = false;
let moving = false;

/** Whether a new version is ready, kept current. */
export function useUpdate(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ready,
    () => false,
  );
}

/** Moves to the new version: the worker takes over, and the page reloads in it. */
export function update(): void {
  moving = true;
  if (waiting) waiting.postMessage({ type: "copilotz:update" });
  else location.reload();
}

/** Puts the offer away, for this page. */
export function later(): void {
  ready = false;
  for (const listener of listeners) listener();
}
