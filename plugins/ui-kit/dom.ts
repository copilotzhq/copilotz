/**
 * The few browser APIs the kit's components touch, typed structurally. The
 * package is checked without the DOM library (core stays runtime-neutral), so
 * components reach the browser through these narrow views.
 * @module
 */

export interface DomRect {
  x: number;
  y: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The element members components use. */
export interface DomElement {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
  readonly offsetTop: number;
  readonly parentElement: DomElement | null;
  readonly dataset: Record<string, string | undefined>;
  readonly style: Record<string, string>;
  selectionStart?: number | null;
  value?: string;
  files?: ArrayLike<File> | null;
  getBoundingClientRect(): DomRect;
  scrollTo?(options: { top?: number; left?: number; behavior?: string }): void;
  scrollIntoView?(options?: { block?: string; inline?: string }): void;
  focus(options?: { preventScroll?: boolean }): void;
  click(): void;
  select?(): void;
  setSelectionRange?(start: number, end: number): void;
  contains(node: unknown): boolean;
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
}

/** View any element-like value (a ref, an event target) as a `DomElement`. */
export function dom(value: unknown): DomElement {
  return value as DomElement;
}

/** Pointer, keyboard and drag event fields components read. */
export interface DomEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  button: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export function domEvent(value: unknown): DomEvent {
  return value as DomEvent;
}

/** The parts of `DataTransfer` used for files and row dragging. */
export interface DomTransfer {
  readonly types: readonly string[];
  readonly files: ArrayLike<File>;
  dropEffect: string;
  effectAllowed: string;
  setData(type: string, value: string): void;
  getData(type: string): string;
}

export function transfer(value: unknown): DomTransfer {
  return value as DomTransfer;
}

type Listener = (event: never) => void;
type MediaQuery = {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};
type Observer = { observe(target: unknown): void; disconnect(): void };

/** Browser globals, present only in a browser (or a DOM test environment). */
export interface BrowserGlobals {
  document?: {
    documentElement: { classList: { toggle(name: string, on: boolean): void } };
    querySelector(selector: string): DomElement | null;
    elementFromPoint(x: number, y: number): DomElement | null;
    createElement(tag: string): DomElement & { href: string; download: string };
  };
  requestAnimationFrame?(callback: (time: number) => void): number;
  cancelAnimationFrame?(handle: number): void;
  matchMedia?(query: string): MediaQuery;
  getComputedStyle?(element: unknown): { position: string };
  ResizeObserver?: new (callback: () => void) => Observer;
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: Listener,
    options?: unknown,
  ): void;
}

export const browser: BrowserGlobals = globalThis as unknown as BrowserGlobals;

/** Whether a media query matches now (false where there is no browser). */
export function mediaMatches(query: string): boolean {
  try {
    return browser.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

/** The next animation frame, or a microtask where there is none. */
export function nextFrame(callback: () => void): void {
  if (browser.requestAnimationFrame) browser.requestAnimationFrame(callback);
  else queueMicrotask(callback);
}
