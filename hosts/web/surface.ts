/**
 * Where a page's Views are drawn, and what they may ask of it: the web host's own page
 * (`"page"`), or a widget inside an outside assistant's conversation (`"widget"`: an MCP Apps
 * host such as ChatGPT, see widget.tsx). One View serves both: what only a widget can do is a
 * no-op on the page, so a View calls these from its handlers without asking where it is.
 *
 * - `surface()`: `"page"` or `"widget"`.
 * - `display(mode)`: asks the widget's host for a display mode (`inline`, `pip`, `fullscreen`);
 *   it answers the mode it set. On the page, nothing changes (it answers `undefined`).
 * - `tell(text)`: a message from the user into the assistant's conversation, which starts its
 *   model's turn. Use sparingly: it speaks for the user.
 * - `remind(text)`: what the assistant's model should know next time it answers (what the user
 *   did in the widget), replacing what this widget said before. Never personal data.
 * - `openLink(url)`: opens a link outside (the host's way, in a widget; a new tab on the page).
 * - `useRefresh(ms)`: while the component that calls it is mounted, a widget asks its reads again
 *   every `ms` (a payment's status): the page needs nothing, its reads are pushed.
 *
 * The widget host sets them (`setSurface`); nothing else does.
 */
import { useEffect } from "react";

export type DisplayMode = "inline" | "pip" | "fullscreen";

/** What a widget's host does for its Views (see widget.tsx). */
export type SurfaceHost = {
  display(mode: DisplayMode): Promise<DisplayMode | undefined>;
  tell(text: string): Promise<void>;
  remind(text: string): Promise<void>;
  openLink(url: string): Promise<void>;
  /** Asks the reads again every `ms` until the returned function is called. */
  every(ms: number): () => void;
};

let host: SurfaceHost | undefined;

/** The widget host's, once it runs (and for tests). */
export function setSurface(next: SurfaceHost | undefined): void {
  host = next;
}

export const surface = (): "page" | "widget" => host ? "widget" : "page";

export const display = (mode: DisplayMode): Promise<DisplayMode | undefined> =>
  host ? host.display(mode) : Promise.resolve(undefined);

export const tell = (text: string): Promise<void> => host ? host.tell(text) : Promise.resolve();

export const remind = (text: string): Promise<void> => host ? host.remind(text) : Promise.resolve();

/** Only links to the web (http, https) are opened. */
export function openLink(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve();
  if (host) return host.openLink(url);
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

/** In a widget, its reads asked again every `ms` while the caller is mounted (at least a second). */
export function useRefresh(ms: number): void {
  useEffect(() => host?.every(Math.max(1_000, ms)), [ms]);
}
