/**
 * When something happened, quietly: "now", "5m", "3h", "Yesterday", "Tue",
 * "Oct 12"; or, `long`, in words ("5 minutes ago", "Tuesday"), as a detail
 * page says it. The full date on hover. Every one shown keeps current on one
 * shared timer.
 */
import { type ReactNode, useSyncExternalStore } from "react";
import { ago } from "./ago.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "time",
  `.copilotz-time { color: var(--muted-foreground); font-size: 12px; white-space: nowrap;
  font-variant-numeric: tabular-nums; }`,
);

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let tick = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  timer ??= setInterval(() => {
    tick++;
    for (const each of listeners) each();
  }, 30_000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

export function Time(
  { at, long, className }: { at: string; long?: boolean; className?: string },
): ReactNode {
  // Drawn on a server too (the time as it is then).
  useSyncExternalStore(subscribe, () => tick, () => tick);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <>
      {SHEET}
      <time
        className={`copilotz-time${className ? ` ${className}` : ""}`}
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {ago(date, Date.now(), long)}
      </time>
    </>
  );
}
