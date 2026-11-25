/**
 * A month's days to choose from, or a few months side by side: what the
 * date pickers open, and usable alone (a booking page's). Days are
 * `YYYY-MM-DD` (see `dates.ts`). It's a grid, as screen readers know them:
 * the arrow keys move a day (on into the next month, which it then shows),
 * Page Up and Page Down a month (with Shift, a year), Home and End to the
 * week's ends, and Enter or Space choose. One day is in the tab order, and
 * each says its whole date. Days before `min` or after `max` show, but
 * can't be chosen. It marks the chosen day (`value`), or a range's ends and
 * the days between (`value` as `{ start, end }`; without `end`, while the
 * second end is being chosen, the pointer previews it), and today
 * (`today`: the app's).
 *
 * Month and weekday names are the page language's; the week starts where
 * that language starts it, or on `weekStart` (0 Sunday … 6 Saturday). A
 * month's heading is `monthFormat` (a pattern, `MMM yyyy`, or a function of
 * its first day).
 *
 * ```tsx
 * <Calendar month={month} onMonth={setMonth} value={day} onPick={setDay} max={today} />
 * <Calendar months={2} month={month} onMonth={setMonth} value={{ start, end }} onPick={pick} />
 * ```
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { formatDate, lang } from "../words.ts";
import { cx } from "./cx.ts";
import {
  addDays,
  addMonth,
  addMonths,
  asciiDigits,
  clampDay,
  formatPattern,
  isDay,
  lastOfMonth,
  monthOf,
  monthWeeks,
  parsePattern,
  partsOf,
  utcDate,
  weekOf,
} from "./dates.ts";
import { Icon } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

/** A day's text: a pattern (`dd/MM/yyyy`; see `formatPattern`) or the app's own function. */
export type DayFormat = string | ((day: string) => string);

/** What a calendar shows as chosen: a day, or a range (its end missing while it's being chosen). */
export type CalendarValue = string | { start: string; end?: string };

const SHEET = sheet(
  "calendar",
  `
.copilotz-calendar { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--calendar-gap, 20px);
  font-size: var(--calendar-font-size, 13px); line-height: 1; }
.copilotz-calendar-month { flex: none; }
.copilotz-calendar-head { display: flex; align-items: center; gap: 4px; margin-bottom: var(--calendar-head-gap, 4px); }
.copilotz-calendar-title { flex: 1; margin: 0; text-align: center; white-space: nowrap;
  font-family: var(--calendar-title-font, var(--font-display)); font-size: var(--calendar-title-size, 14px);
  font-weight: var(--calendar-title-weight, 650); line-height: 1.2; }
.copilotz-calendar-nav, .copilotz-calendar-spacer { flex: none; width: var(--calendar-day-size, 34px);
  height: var(--calendar-day-size, 34px); }
.copilotz-calendar-nav { display: grid; place-items: center; margin: 0; padding: 0; border: 0;
  border-radius: var(--calendar-day-radius, var(--radius-md)); background: transparent;
  color: var(--calendar-nav-color, var(--muted-foreground)); cursor: pointer; }
.copilotz-calendar-nav:hover:not(:disabled) { background: var(--calendar-hover-background, var(--accent));
  color: var(--calendar-hover-foreground, var(--accent-foreground)); }
.copilotz-calendar-nav:disabled { opacity: .35; cursor: default; }
.copilotz-calendar-grid { border-collapse: separate; border-spacing: 0 var(--calendar-row-gap, 2px); }
.copilotz-calendar-grid th { width: var(--calendar-day-size, 34px); height: 26px; padding: 0;
  color: var(--calendar-weekday-color, var(--muted-foreground)); font-size: var(--calendar-weekday-size, 11.5px);
  font-weight: 600; text-align: center; }
.copilotz-calendar-grid td { padding: 0; text-align: center; }
.copilotz-calendar-day { display: grid; place-items: center; width: var(--calendar-day-size, 34px);
  height: var(--calendar-day-size, 34px); margin: 0; padding: 0; border: 0;
  border-radius: var(--calendar-day-radius, var(--radius-md)); background: transparent; color: inherit; font: inherit;
  font-variant-numeric: tabular-nums; cursor: pointer; }
.copilotz-calendar-day:hover { background: var(--calendar-hover-background, var(--accent));
  color: var(--calendar-hover-foreground, var(--accent-foreground)); }
.copilotz-calendar-day:focus-visible { outline-offset: 0; }
.copilotz-calendar-day[aria-current=date] { font-weight: 700;
  box-shadow: inset 0 0 0 1px var(--calendar-today-ring, var(--border)); }
td[data-between] > .copilotz-calendar-day { border-radius: var(--calendar-range-radius, 0);
  background: var(--calendar-range-background, var(--primary-soft));
  color: var(--calendar-range-foreground, var(--primary-text)); }
td[aria-selected=true] > .copilotz-calendar-day, td[aria-selected=true] > .copilotz-calendar-day:hover {
  background: var(--calendar-selected-background, var(--primary));
  color: var(--calendar-selected-foreground, var(--primary-foreground));
  font-weight: 650; box-shadow: none; }
td[data-start]:not([data-end]) > .copilotz-calendar-day {
  border-start-end-radius: var(--calendar-range-radius, 0); border-end-end-radius: var(--calendar-range-radius, 0); }
td[data-end]:not([data-start]) > .copilotz-calendar-day {
  border-start-start-radius: var(--calendar-range-radius, 0); border-end-start-radius: var(--calendar-range-radius, 0); }
.copilotz-calendar-day[aria-disabled=true], .copilotz-calendar-day[aria-disabled=true]:hover {
  background: transparent; color: var(--muted-foreground); opacity: .45; cursor: default; }
/* Touch screens: days a finger finds */
@media (pointer: coarse) {
  .copilotz-calendar-day, .copilotz-calendar-nav, .copilotz-calendar-spacer, .copilotz-calendar-grid th {
    width: var(--calendar-day-size-touch, 40px); }
  .copilotz-calendar-day, .copilotz-calendar-nav, .copilotz-calendar-spacer {
    height: var(--calendar-day-size-touch, 40px); }
}
`,
);

/** The day a week starts on in a language (`Intl.Locale`'s week info), or Sunday where it can't say. */
export function weekStartOf(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?(): { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    return typeof first === "number" ? first % 7 : 0;
  } catch {
    return 0;
  }
}

/** A day written by a format: the pattern's, the function's, or the page language's short date. */
export function formatDay(day: string, format?: DayFormat): string {
  if (typeof format === "function") return format(day);
  if (format) return formatPattern(day, format, lang());
  return formatDate(utcDate(day), { timeZone: "UTC" });
}

/** The pattern `formatDay`'s short date is written by (`M/d/yyyy`, `dd/MM/yyyy`), read off a sample. */
export function shortPattern(): string {
  const sample = formatDate(utcDate("2003-04-25"), { timeZone: "UTC" });
  return asciiDigits(sample, lang()).split(/(\d+)/).map((part, i) =>
    i % 2 === 0
      ? (part ? `'${part.replaceAll("'", "")}'` : "")
      : part === "2003"
      ? "yyyy"
      : part === "25"
      ? "d"
      : "M"
  ).join("");
}

/**
 * A day read from text typed in the same format `formatDay` writes (a pattern, or the page
 * language's short date), or `undefined` when it isn't a real day. A function format can't be
 * turned back, so its text is read as the page language's short date, or as `YYYY-MM-DD`.
 */
export function parseDay(text: string, format?: DayFormat): string | undefined {
  const pattern = typeof format === "string" ? format : undefined;
  const found = parsePattern(text, pattern ?? shortPattern(), lang(), pattern === undefined);
  if (found || pattern) return found;
  return isDay(text.trim()) ? text.trim() : parsePattern(text, "yyyy-MM-dd", lang());
}

/** The start and end a value marks, and the days chosen (its ends, or the day). */
function marksOf(value: CalendarValue | undefined, hover: string | undefined) {
  if (value === undefined) return { chosen: [] as string[] };
  if (typeof value === "string") return { chosen: [value] };
  const end = value.end ?? (hover && hover !== value.start ? hover : undefined);
  if (!end) return { chosen: [value.start] };
  const [start, last] = end < value.start ? [end, value.start] : [value.start, end];
  return { start, end: last, chosen: value.end ? [start, last] : [value.start] };
}

export function Calendar(
  {
    month,
    onMonth,
    months = 1,
    value,
    onPick,
    min,
    max,
    today,
    weekStart,
    monthFormat,
    label,
    className,
  }: {
    /** The (first) month shown: `YYYY-MM`, or any of its days. */
    month: string;
    /** Shows another month: its buttons, and the keys moving past the months shown. */
    onMonth(month: string): void;
    /** How many months, side by side (they wrap where there's no room). */
    months?: number;
    value?: CalendarValue;
    onPick(day: string): void;
    min?: string;
    max?: string;
    /** The app's today, marked. */
    today?: string;
    /** The week's first day: 0 Sunday … 6 Saturday (the page language's by default). */
    weekStart?: number;
    /** Each month's heading: a pattern (`MMMM yyyy`) or a function of its first day. */
    monthFormat?: DayFormat;
    /** What choosing here is for, said to screen readers. */
    label?: string;
    className?: string;
  },
): ReactNode {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const focusing = useRef(false);
  const [focused, setFocused] = useState<string>();
  const [hover, setHover] = useState<string>();
  const start = weekStart ?? weekStartOf(lang());
  const shown = Array.from({ length: Math.max(1, months) }, (_, i) => addMonth(monthOf(month), i));
  const first = `${shown[0]}-01`;
  const [lastYear, lastMonth] = partsOf(`${shown[shown.length - 1]}-01`);
  const last = lastOfMonth(lastYear, lastMonth);
  const inView = (day?: string): day is string => !!day && day >= first && day <= last;
  const blocked = (day: string) => (!!min && day < min) || (!!max && day > max);

  const { start: from, end: to, chosen } = marksOf(value, hover);
  const picked = typeof value === "string" ? value : value?.end ?? value?.start;
  // The day the keys are on: the one they moved to, else the chosen, today, or the first that can be.
  const active = [focused, picked, typeof value === "object" ? value.start : undefined, today]
    .find((day) => inView(day) && !blocked(day)) ??
    (inView(clampDay(first, min, max)) ? clampDay(first, min, max) : first);

  // Focus follows the keys, once the day they moved to is drawn.
  useEffect(() => {
    if (!focusing.current) return;
    focusing.current = false;
    box.current?.querySelector<HTMLElement>(
      `.copilotz-calendar-day[data-day="${active}"]`,
    )?.focus();
  });

  const move = (to: string) => {
    const day = clampDay(to, min, max);
    focusing.current = true;
    setFocused(day);
    if (day < first) onMonth(monthOf(day));
    else if (day > last) onMonth(addMonth(monthOf(day), 1 - shown.length));
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).matches(".copilotz-calendar-day")) return;
    const year = event.shiftKey ? 12 : 1;
    const to: Record<string, () => string> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      PageUp: () => addMonths(active, -year),
      PageDown: () => addMonths(active, year),
      Home: () => weekOf(active, start).start,
      End: () => weekOf(active, start).end,
    };
    if (!to[event.key]) return;
    // The keys are the grid's: a popover around it doesn't move on them.
    event.preventDefault();
    event.stopPropagation();
    move(to[event.key]());
  };

  const previous = addMonth(shown[0], -1);
  const next = addMonth(shown[shown.length - 1], 1);
  const locale = lang();
  const heading = (m: string) =>
    monthFormat === undefined
      ? formatDate(utcDate(`${m}-01`), { month: "long", year: "numeric", timeZone: "UTC" })
      : formatDay(`${m}-01`, monthFormat);
  const weekdays = monthWeeks(shown[0], start)[0];
  const weekday = (day: string, style: "short" | "long") =>
    new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(utcDate(day));
  const whole = (day: string) =>
    formatDate(utcDate(day), { dateStyle: "full", timeZone: "UTC" } as Intl.DateTimeFormatOptions);

  return (
    <div
      ref={box}
      className={cx("copilotz-calendar", className)}
      role="group"
      aria-label={label}
      onKeyDown={keys}
      onMouseLeave={() => setHover(undefined)}
    >
      {SHEET}
      {shown.map((m, index) => {
        const title = `${id}-${m}`;
        return (
          <div key={m} className="copilotz-calendar-month">
            <div className="copilotz-calendar-head">
              {index === 0
                ? (
                  <button
                    type="button"
                    className="copilotz-calendar-nav"
                    aria-label={say("previousMonth")}
                    disabled={!!min && previous < monthOf(min)}
                    onClick={() => onMonth(previous)}
                  >
                    <Icon name="chevron-left" size={16} />
                  </button>
                )
                : <span className="copilotz-calendar-spacer" />}
              <h2 id={title} className="copilotz-calendar-title" aria-live="polite">
                {heading(m)}
              </h2>
              {index === shown.length - 1
                ? (
                  <button
                    type="button"
                    className="copilotz-calendar-nav"
                    aria-label={say("nextMonth")}
                    disabled={!!max && next > monthOf(max)}
                    onClick={() => onMonth(addMonth(shown[0], 1))}
                  >
                    <Icon name="chevron" size={16} />
                  </button>
                )
                : <span className="copilotz-calendar-spacer" />}
            </div>
            <table role="grid" className="copilotz-calendar-grid" aria-labelledby={title}>
              <thead>
                <tr>
                  {weekdays.map((day) => (
                    <th key={day} scope="col" abbr={weekday(day, "long")}>
                      {weekday(day, "short")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthWeeks(m, start).map((week) => (
                  <tr key={week[0]}>
                    {week.map((day) => {
                      // Days of the months around it are left blank: each day is in one grid.
                      if (monthOf(day) !== m) return <td key={day} role="gridcell" />;
                      const ends = from !== undefined && to !== undefined;
                      const mine = day === active;
                      return (
                        <td
                          key={day}
                          role="gridcell"
                          aria-selected={chosen.includes(day) ? true : undefined}
                          data-start={ends && day === from ? "" : undefined}
                          data-end={ends && day === to ? "" : undefined}
                          data-between={ends && day > from! && day < to! ? "" : undefined}
                        >
                          <button
                            type="button"
                            className="copilotz-calendar-day"
                            data-day={day}
                            data-popover-item={mine ? "" : undefined}
                            tabIndex={mine ? 0 : -1}
                            aria-label={whole(day)}
                            aria-current={day === today ? "date" : undefined}
                            aria-disabled={blocked(day) ? true : undefined}
                            onFocus={() => day !== active && setFocused(day)}
                            onMouseEnter={() => setHover(day)}
                            onClick={() => {
                              if (blocked(day)) return;
                              setFocused(day);
                              onPick(day);
                            }}
                          >
                            {partsOf(day)[2]}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
