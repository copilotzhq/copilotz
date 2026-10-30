/** The browser engine's shapes: its actions, a request of them, and what it answers. */
import type { Window, Windows } from "./chrome.ts";
import type { BrowserAction } from "./schema.ts";

export type { Window, Windows } from "./chrome.ts";

/** One action, with every field any action takes. */
export type Action = {
  action: BrowserAction;
  timeoutMs?: number;
  selector?: string;
  ref?: string;
  text?: string;
  url?: string;
  clear?: boolean;
  snapshotAfter?: boolean;
  renderMath?: boolean;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  until?: "load" | "domcontentloaded" | "networkidle" | "selector";
  includeHtml?: boolean;
  maxChars?: number;
  fullPage?: boolean;
  expression?: string;
  x?: number;
  y?: number;
  steps?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delayMs?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  path?: string;
  query?: string;
  count?: number;
  region?: string;
  language?: string;
  safeSearch?: "strict" | "moderate" | "off";
  timeRange?: "day" | "week" | "month" | "year";
  operation?: "list" | "new" | "select" | "close";
  tabId?: string;
  accept?: boolean;
  intercept?: string;
};

/** A batch of 1–10 actions, done in order (stopping at the first that fails, unless told not to). */
export type Request = {
  actions: Action[];
  timeoutMs?: number;
  stopOnError?: boolean;
  /**
   * Who's browser hidden, or shown on the person's screen: when it's running
   * in the other, it starts again in this one, on the same profile and page.
   * Unless given, it stays as it is (a browser starts hidden).
   */
  window?: Window;
};

export type Result = {
  success: boolean;
  stoppedEarly: boolean;
  currentUrl?: string;
  title?: string;
  /** Who's browser after the request: hidden, or shown on the person's screen. */
  window: Window;
  results: Record<string, unknown>[];
};

export type Options = {
  /**
   * The computer's root (a real path): who's profile in a space is
   * `.copilotz/browser/<folder>/<who>` in it (see profile.ts).
   */
  root: string;
  /** The Chrome or Chromium to drive; null: there's none. */
  chromium: string | null;
  /** Whether a browser may be shown on the person's screen (unless "never", it may). */
  windows?: Windows;
  width?: number;
  height?: number;
  /** Where `web_search` goes (DuckDuckGo's HTML page unless set). */
  searchUrl?: string;
  /** Chrome's environment. */
  env?: Record<string, string>;
  actionTimeoutMs?: number;
  /** How long an agent waits for a person to hand back control. */
  humanWaitMs?: number;
  launchTimeoutMs?: number;
  closeTimeoutMs?: number;
  ignoreHTTPSErrors?: boolean;
  /** Who's Chrome, unused this long, stops (30 minutes unless given). */
  idleMs?: number;
  /** Hears Chrome start and stop (its pid only). */
  onProcess?: (event: { pid: number; state: "started" | "stopped" }) => void;
};
