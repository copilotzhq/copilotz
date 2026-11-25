/**
 * The page's toasts, as state: what's showing, each one's timer, and which
 * `<Toasts />` shows them (see toast.tsx). `toast()` works from anywhere (a
 * handler, a plain function), so it lives here, outside React.
 */
import type { ReactNode } from "react";

/** A toast's colour and what it means. `destructive` is said at once (an alert). */
export type ToastTone = "neutral" | "success" | "info" | "warning" | "destructive";

/** How a toast shows: its tone, and for how long (milliseconds; 0 stays until dismissed). */
export type ToastOptions = { tone?: ToastTone; duration?: number };

/** One toast on the page. */
export type Toast = { id: number; message: ReactNode; tone: ToastTone };

/** What `<Toasts />` reads: the toasts, and which of the mounted ones shows them. */
export type ToastState = { toasts: Toast[]; shownBy: string | undefined };

/** How long a toast stays, unless told. */
export const TOAST_DURATION = 5000;

let state: ToastState = { toasts: [], shownBy: undefined };
let nextId = 1;
const listeners = new Set<() => void>();
/** Each toast's timer and what's left of its time, while it counts down. */
const timers = new Map<
  number,
  { left: number; started: number; timer?: ReturnType<typeof setTimeout> }
>();
/** The mounted `<Toasts />`, in order, and whether each chose its placement. */
const hosts: { id: string; placed: boolean }[] = [];

const emit = (next: Partial<ToastState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

/** Listens for changes (`useSyncExternalStore`'s subscribe). */
export const subscribe = (listener: () => void): () => void => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What's showing now (`useSyncExternalStore`'s snapshot). */
export const toastState = (): ToastState => state;

/** Nothing, as a page made on the server has. */
export const NO_TOASTS: ToastState = { toasts: [], shownBy: undefined };

const start = (id: number) => {
  const timing = timers.get(id);
  if (!timing || timing.timer !== undefined) return;
  timing.started = Date.now();
  timing.timer = setTimeout(() => dismissToast(id), timing.left);
};

/**
 * Shows a message for a while, over the page: `toast("Saved", "success")`, or
 * `{ tone, duration }`. Gives back what takes it away early.
 */
export function toast(message: ReactNode, how: ToastTone | ToastOptions = {}): () => void {
  const { tone = "neutral", duration = TOAST_DURATION } = typeof how === "string"
    ? { tone: how }
    : how;
  const id = nextId++;
  emit({ toasts: [...state.toasts, { id, message, tone }] });
  if (duration > 0) {
    timers.set(id, { left: duration, started: Date.now() });
    start(id);
  }
  return () => dismissToast(id);
}

/** Takes a toast away. */
export function dismissToast(id: number): void {
  const timing = timers.get(id);
  if (timing?.timer !== undefined) clearTimeout(timing.timer);
  timers.delete(id);
  if (state.toasts.some((t) => t.id === id)) {
    emit({ toasts: state.toasts.filter((t) => t.id !== id) });
  }
}

/** Stops a toast's clock (the pointer is on it, or the keyboard is in it). */
export function pauseToast(id: number): void {
  const timing = timers.get(id);
  if (!timing || timing.timer === undefined) return;
  clearTimeout(timing.timer);
  timing.timer = undefined;
  timing.left = Math.max(0, timing.left - (Date.now() - timing.started));
}

/** Starts it again, with the time it had left. */
export const resumeToast = (id: number): void => start(id);

/** Which mounted `<Toasts />` shows them: the first that chose its placement, or the first. */
const shower = () => (hosts.find((host) => host.placed) ?? hosts[0])?.id;

/**
 * A `<Toasts />` is on the page (`placed`: it chose where they show). Only
 * one shows them, so a shell's and an app's never both do. Gives back what
 * takes it off.
 */
export function mountToasts(id: string, placed: boolean): () => void {
  hosts.push({ id, placed });
  emit({ shownBy: shower() });
  return () => {
    const at = hosts.findIndex((host) => host.id === id);
    if (at >= 0) hosts.splice(at, 1);
    emit({ shownBy: shower() });
  };
}

/** Changing placement can hand the toasts to another host while both remain mounted. */
export function placeToasts(id: string, placed: boolean): void {
  const host = hosts.find((h) => h.id === id);
  if (host && host.placed !== placed) {
    host.placed = placed;
    emit({ shownBy: shower() });
  }
}
