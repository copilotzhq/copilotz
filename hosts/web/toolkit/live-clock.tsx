/**
 * The date and time now, kept current: what an app's bar shows. It ticks
 * each second, or each minute when its `format` shows no seconds, on the
 * minute. The time is the app's: in its `timeZone` (IANA:
 * `America/Sao_Paulo`) when given, the page's own otherwise. `format` is
 * the app's too: a pattern (`dd/MM/yyyy HH:mm:ss`; see `formatPattern`), or
 * a function of the moment as `YYYY-MM-DD HH:mm:ss` in that zone (an app's
 * own formatter); without one, the page language's short date and its time
 * with seconds.
 *
 * Nothing of it is drawn on the server, which can't know the reader's now:
 * the page fills it in as it starts. It's not a live region (it would speak
 * every second); `label` says what it is to screen readers, before it.
 *
 * ```tsx
 * <LiveClock format="dd/MM/yyyy HH:mm" timeZone="America/Sao_Paulo" />
 * <LiveClock format={(at) => phpDate("m/d/Y H:i:s", at)} />
 * ```
 */
import { type ReactNode, useEffect, useState } from "react";
import { formatDateTime, lang } from "../words.ts";
import { cx } from "./cx.ts";
import { formatPattern, momentIn, showsSeconds, stamp } from "./dates.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "live-clock",
  `.copilotz-live-clock { white-space: nowrap; font-variant-numeric: var(--live-clock-numeric, tabular-nums); }`,
);

/** The time now, as a clock in a zone shows it. */
export function clockText(
  now: Date,
  format?: string | ((at: string) => string),
  timeZone?: string,
): string {
  if (typeof format === "function") return format(stamp(momentIn(now, timeZone)));
  if (format) return formatPattern(momentIn(now, timeZone), format, lang());
  return formatDateTime(now, {
    dateStyle: "short",
    timeStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function LiveClock(
  { format, timeZone, label, className }: {
    /** A pattern (`dd/MM/yyyy HH:mm:ss`), or a function of `YYYY-MM-DD HH:mm:ss`. */
    format?: string | ((at: string) => string);
    /** The app's time zone (IANA); the page's when not given. */
    timeZone?: string;
    /** What it is, said to screen readers before the time ("Shop time"). */
    label?: string;
    className?: string;
  },
): ReactNode {
  const [now, setNow] = useState<Date>();
  const minutes = typeof format === "string" && !showsSeconds(format);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    // On the next second, or the next minute: every reading as the clock turns over.
    const tick = () => {
      const at = new Date();
      setNow(at);
      const step = minutes ? 60_000 : 1000;
      timer = setTimeout(tick, step - (at.getTime() % step) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [minutes]);

  return (
    <time className={cx("copilotz-live-clock", className)} dateTime={now?.toISOString()}>
      {SHEET}
      {label ? <span className="copilotz-sr">{label}</span> : null}
      {now ? clockText(now, format, timeZone) : null}
    </time>
  );
}
