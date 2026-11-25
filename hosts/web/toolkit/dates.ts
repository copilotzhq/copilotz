/**
 * Days as the date pieces keep them: `"2026-11-16"`, a calendar day with no
 * time and no zone, so a day is the same day wherever the page is open.
 * Their arithmetic is in UTC (`Date.UTC`), where no day is 23 or 25 hours.
 * What the pieces need of them: moving by days and months, a month's weeks
 * for a week that starts on any day, the app's today in its time zone, the
 * standard ranges a report asks for (`presetRange`), and writing a day or a
 * time by the app's own pattern (`formatPattern`), with the month and
 * weekday names of the page's language.
 *
 * ```ts
 * addDays("2026-03-01", -1); // "2026-02-28"
 * formatPattern("2026-11-16", "dd/MM/yyyy"); // "16/11/2026"
 * presetRange("lastMonth", "2026-11-16"); // { start: "2026-10-01", end: "2026-10-31" }
 * ```
 */

/** A range of days, both ends included. */
export type DateRange = { start: string; end: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})/;

/** Whether a string is a real day, `YYYY-MM-DD`. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY.exec(value);
  return !!match && dayOf(+match[1], +match[2], +match[3]) === value;
}

/** A day from its year, month (1–12) and day; out-of-range parts roll over (day 0 is the last one before). */
export function dayOf(year: number, month: number, day: number): string {
  // Not `Date.UTC`, which reads years 0–99 as 1900–1999.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  return at.toISOString().slice(0, 10);
}

/** A day as a `Date` at its start in UTC: what `Intl` formats with `timeZone: "UTC"`. */
export function utcDate(day: string): Date {
  const [year, month, date] = partsOf(day);
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, date);
  return at;
}

/** A day's year, month (1–12) and day. */
export function partsOf(day: string): [year: number, month: number, day: number] {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number);
  return [year, month, date];
}

/** The day `count` days after (or before) another. */
export function addDays(day: string, count: number): string {
  const [year, month, date] = partsOf(day);
  return dayOf(year, month, date + count);
}

/** The last day of a month (1–12). */
export function lastOfMonth(year: number, month: number): string {
  return dayOf(year, month + 1, 0);
}

/**
 * The same day `count` months on (or back), kept in its month: from January 31 a month on is
 * February's last day, not March 3.
 */
export function addMonths(day: string, count: number): string {
  const [year, month, date] = partsOf(day);
  const first = dayOf(year, month + count, 1);
  const [y, m] = partsOf(first);
  return dayOf(y, m, Math.min(date, partsOf(lastOfMonth(y, m))[2]));
}

/** A day's month, `YYYY-MM` (a month given as one stays). */
export const monthOf = (day: string): string => MONTH.exec(day)?.[0] ?? day.slice(0, 7);

/** A month (`YYYY-MM`) `count` months on, or back. */
export function addMonth(month: string, count: number): string {
  return monthOf(dayOf(+month.slice(0, 4), +month.slice(5, 7) + count, 1));
}

/** How many months from one month (or day) to another: `2026-01` to `2026-03` is 2. */
export function monthsBetween(from: string, to: string): number {
  const [a, b] = [partsOf(`${monthOf(from)}-01`), partsOf(`${monthOf(to)}-01`)];
  return (b[0] - a[0]) * 12 + (b[1] - a[1]);
}

/** A day's weekday: 0 is Sunday, 6 Saturday. */
export function weekdayOf(day: string): number {
  const [year, month, date] = partsOf(day);
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, date);
  return at.getUTCDay();
}

/**
 * A month's weeks, six of them (a calendar keeps its height), each its seven days, starting on
 * `weekStart` (0 Sunday … 6 Saturday): the days before and after the month fill them out.
 */
export function monthWeeks(month: string, weekStart = 0): string[][] {
  const first = `${monthOf(month)}-01`;
  const back = (weekdayOf(first) - weekStart + 7) % 7;
  const from = addDays(first, -back);
  return Array.from(
    { length: 6 },
    (_, week) => Array.from({ length: 7 }, (_, day) => addDays(from, week * 7 + day)),
  );
}

/** The day of the week's first day that a day belongs to, and its last. */
export function weekOf(day: string, weekStart = 0): DateRange {
  const start = addDays(day, -((weekdayOf(day) - weekStart + 7) % 7));
  return { start, end: addDays(start, 6) };
}

/** A day kept within bounds: before `min` it's `min`, after `max` it's `max`. */
export function clampDay(day: string, min?: string, max?: string): string {
  if (min && day < min) return min;
  if (max && day > max) return max;
  return day;
}

/** A moment's parts, in a time zone (the page's when none is given). */
export type Moment = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** A moment as its parts in a time zone (IANA: `America/Sao_Paulo`), or the page's own. */
export function momentIn(at: Date, timeZone?: string): Moment {
  if (!timeZone) {
    return {
      year: at.getFullYear(),
      month: at.getMonth() + 1,
      day: at.getDate(),
      hour: at.getHours(),
      minute: at.getMinutes(),
      second: at.getSeconds(),
    };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

const two = (n: number) => String(n).padStart(2, "0");

/** A moment as text a pattern function reads: `YYYY-MM-DD HH:mm:ss`. */
export const stamp = (m: Moment): string =>
  `${dayOf(m.year, m.month, m.day)} ${two(m.hour)}:${two(m.minute)}:${two(m.second)}`;

/** Today, in a time zone (the app's), or the page's own: a day. */
export function todayIn(timeZone?: string, now: Date = new Date()): string {
  const m = momentIn(now, timeZone);
  return dayOf(m.year, m.month, m.day);
}

/** What a pattern may say. Letters in quotes are said as they are: `d 'de' MMMM`. */
const TOKENS = /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|a|'[^']*'/g;

/** Names, by language and kind, made once. */
const names = new Map<string, Intl.DateTimeFormat>();
function nameOf(
  locale: string,
  options: Intl.DateTimeFormatOptions,
  key: string,
  at: Date,
  part: Intl.DateTimeFormatPartTypes,
): string {
  const id = `${locale}|${key}`;
  let format = names.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    names.set(id, format);
  }
  return format.formatToParts(at).find((p) => p.type === part)?.value ?? "";
}

/**
 * A day, or a moment, written by a pattern, in a language (`lang()`, the page's) for the month
 * and weekday names:
 *
 * | Token | Says | | Token | Says |
 * |---|---|---|---|---|
 * | `yyyy` | 2026 | | `HH`, `H` | 09, 9 (0–23) |
 * | `yy` | 26 | | `hh`, `h` | 09, 9 (1–12) |
 * | `MMMM`, `MMM` | November, Nov | | `mm` | 05 (minutes) |
 * | `MM`, `M` | 11, 11 | | `ss` | 07 (seconds) |
 * | `dd`, `d` | 06, 6 | | `a` | AM, PM |
 * | `EEEE`, `EEE` | Monday, Mon | | `'text'` | text, as it is |
 *
 * Anything else is written as it is: `dd/MM/yyyy`, `MMM d, yyyy`, `d 'de' MMMM`, `HH:mm`.
 */
export function formatPattern(at: string | Moment, pattern: string, locale = "en"): string {
  const m: Moment = typeof at === "string"
    ? (() => {
      const [year, month, day] = partsOf(at);
      const [hour, minute, second] = (at.slice(11) || "0:0:0").split(":").map(Number);
      return { year, month, day, hour: hour || 0, minute: minute || 0, second: second || 0 };
    })()
    : at;
  const date = new Date(0);
  date.setUTCFullYear(m.year, m.month - 1, m.day);
  date.setUTCHours(m.hour, m.minute, m.second);
  const hour12 = m.hour % 12 || 12;
  return pattern.replace(TOKENS, (token) => {
    switch (token) {
      case "yyyy":
        return String(m.year).padStart(4, "0");
      case "yy":
        return two(m.year % 100);
      case "MMMM":
        return nameOf(locale, { month: "long" }, "MMMM", date, "month");
      case "MMM":
        return nameOf(locale, { month: "short" }, "MMM", date, "month");
      case "MM":
        return two(m.month);
      case "M":
        return String(m.month);
      case "dd":
        return two(m.day);
      case "d":
        return String(m.day);
      case "EEEE":
        return nameOf(locale, { weekday: "long" }, "EEEE", date, "weekday");
      case "EEE":
        return nameOf(locale, { weekday: "short" }, "EEE", date, "weekday");
      case "HH":
        return two(m.hour);
      case "H":
        return String(m.hour);
      case "hh":
        return two(hour12);
      case "h":
        return String(hour12);
      case "mm":
        return two(m.minute);
      case "ss":
        return two(m.second);
      case "a":
        return nameOf(locale, { hour: "numeric", hour12: true }, "a", date, "dayPeriod") ||
          (m.hour < 12 ? "AM" : "PM");
      default:
        return token.slice(1, -1);
    }
  });
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A day read from text written by a pattern (what `formatPattern` writes: `dd/MM/yyyy`,
 * `d MMM yyyy`, `yyyy-MM-dd`), or `undefined` when the text isn't a real day. Day and month take
 * one or two digits, `yyyy` four, `yy` two (20xx); month names are read in the language's, in any
 * case; weekday names are skipped. A pattern with no year, month or day can't be read.
 */
export function parsePattern(text: string, pattern: string, locale = "en"): string | undefined {
  const order: string[] = [];
  let source = "";
  let last = 0;
  const literal = (end: number) => {
    source += escaped(pattern.slice(last, end)).replace(/\s+/g, "\\s*");
  };
  for (const hit of pattern.matchAll(TOKENS)) {
    literal(hit.index);
    last = hit.index + hit[0].length;
    const token = hit[0];
    if (token[0] === "'") {
      source += escaped(token.slice(1, -1));
    } else if (token === "yyyy") {
      source += "(\\d{4})";
      order.push("y");
    } else if (token === "yy") {
      source += "(\\d{2})";
      order.push("yy");
    } else if (token === "MMMM" || token === "MMM") {
      source += "(\\p{L}+\\.?)";
      order.push(token);
    } else if (token === "MM" || token === "M") {
      source += "(\\d{1,2})";
      order.push("M");
    } else if (token === "dd" || token === "d") {
      source += "(\\d{1,2})";
      order.push("d");
    } else if (token === "EEEE" || token === "EEE") {
      source += "\\p{L}+\\.?";
    } else return undefined; // a time's letters: not a day
  }
  literal(pattern.length);
  if (!order.some((o) => o === "y" || o === "yy") || !order.includes("d")) return undefined;
  if (!order.some((o) => o === "M" || o === "MMM" || o === "MMMM")) return undefined;
  const match = new RegExp(`^${source}$`, "iu").exec(text.trim());
  if (!match) return undefined;
  let year = 0, month = 0, day = 0;
  for (const [i, kind] of order.entries()) {
    const part = match[i + 1];
    if (kind === "y") year = +part;
    else if (kind === "yy") year = 2000 + +part;
    else if (kind === "d") day = +part;
    else if (kind === "M") month = +part;
    else {
      const wanted = part.toLowerCase().replace(/\.$/, "");
      month = Array.from({ length: 12 }, (_, m) => m + 1).find((m) => {
        const name = formatPattern(dayOf(2000, m, 1), kind, locale).toLowerCase();
        return name.replace(/\.$/, "") === wanted;
      }) ?? 0;
    }
  }
  const result = dayOf(year, month, day);
  return month >= 1 && month <= 12 && day >= 1 && isDay(result) && partsOf(result)[1] === month &&
      partsOf(result)[2] === day
    ? result
    : undefined;
}

/** Whether a pattern shows seconds: a clock that doesn't ticks once a minute. */
export const showsSeconds = (pattern: string): boolean =>
  /ss/.test(pattern.replace(/'[^']*'/g, ""));

/** The standard ranges, by name. */
export const PRESETS = [
  "today",
  "yesterday",
  "todayLastYear",
  "last7Days",
  "last30Days",
  "thisMonth",
  "sameMonthToDateLastYear",
  "sameMonthLastYear",
  "lastMonth",
  "thisYear",
  "lastYear",
  "thisFiscalYear",
  "lastFiscalYear",
  "allTime",
] as const;

/** One of the standard ranges. */
export type Preset = typeof PRESETS[number];

/**
 * A standard range for a today (the app's): months and years whole, so "this month" ends on its
 * last day (a picker's `max` cuts it at today). A fiscal year starts on the first of
 * `fiscalYearStart` (1–12; January, the calendar year, by default): in November with a year
 * starting in April, this fiscal year is April 1 to March 31 next. `allTime` runs from `min`
 * (none without it).
 */
export function presetRange(
  preset: Preset,
  today: string,
  { fiscalYearStart = 1, min }: { fiscalYearStart?: number; min?: string } = {},
): DateRange | undefined {
  const [y, m] = partsOf(today);
  const lastYear = addMonths(today, -12);
  const [ly, lm] = partsOf(lastYear);
  const fy = Math.min(12, Math.max(1, Math.trunc(fiscalYearStart) || 1));
  const fiscalStart = dayOf(m >= fy ? y : y - 1, fy, 1);
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { start: day, end: day };
    }
    case "todayLastYear":
      return { start: lastYear, end: lastYear };
    case "last7Days":
      return { start: addDays(today, -6), end: today };
    case "last30Days":
      return { start: addDays(today, -29), end: today };
    case "thisMonth":
      return { start: dayOf(y, m, 1), end: lastOfMonth(y, m) };
    case "sameMonthToDateLastYear":
      return { start: dayOf(ly, lm, 1), end: lastYear };
    case "sameMonthLastYear":
      return { start: dayOf(ly, lm, 1), end: lastOfMonth(ly, lm) };
    case "lastMonth": {
      const [py, pm] = partsOf(dayOf(y, m - 1, 1));
      return { start: dayOf(py, pm, 1), end: lastOfMonth(py, pm) };
    }
    case "thisYear":
      return { start: dayOf(y, 1, 1), end: dayOf(y, 12, 31) };
    case "lastYear":
      return { start: dayOf(y - 1, 1, 1), end: dayOf(y - 1, 12, 31) };
    case "thisFiscalYear":
      return { start: fiscalStart, end: addDays(addMonths(fiscalStart, 12), -1) };
    case "lastFiscalYear":
      return { start: addMonths(fiscalStart, -12), end: addDays(fiscalStart, -1) };
    case "allTime":
      return min ? { start: min, end: today } : undefined;
  }
}

/** A range kept within bounds, or none when nothing of it is. */
export function clampRange(range: DateRange, min?: string, max?: string): DateRange | undefined {
  const start = clampDay(range.start, min, max);
  const end = clampDay(range.end, min, max);
  if ((min && range.end < min) || (max && range.start > max)) return undefined;
  return start <= end ? { start, end } : undefined;
}

/**
 * A day and a time of it, as the date-time pieces keep them: `"2026-11-16 14:30"`, the app's own
 * clock time (no zone), so it reads the same wherever the page is open, and its text sorts as its
 * moments do. A value may carry seconds, `"2026-11-16 14:30:05"`: they are kept as they are until
 * the time is changed (or always written, by a picker's `seconds`).
 */
export type DayTime = string;

const DAY_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Whether a string is a real day and a time of it, `YYYY-MM-DD HH:mm` or `YYYY-MM-DD HH:mm:ss`. */
export function isDayTime(value: unknown): value is DayTime {
  if (typeof value !== "string") return false;
  const match = DAY_TIME.exec(value);
  return !!match && isDay(match[1]) && +match[2] < 24 && +match[3] < 60 &&
    (match[4] === undefined || +match[4] < 60);
}

/** A day and a time, `YYYY-MM-DD HH:mm`; with a `second`, `YYYY-MM-DD HH:mm:ss`. */
export const dayTimeOf = (day: string, hour: number, minute: number, second?: number): DayTime =>
  `${day} ${two(hour)}:${two(minute)}${second === undefined ? "" : `:${two(second)}`}`;

/** A day-time's parts: its day, its hour and minute, and its second (none when it has no seconds). */
export function partsOfDayTime(
  value: DayTime,
): { day: string; hour: number; minute: number; second?: number } {
  const match = DAY_TIME.exec(value);
  if (!match) return { day: value.slice(0, 10), hour: 0, minute: 0 };
  const parts = { day: match[1], hour: +match[2], minute: +match[3] };
  return match[4] === undefined ? parts : { ...parts, second: +match[4] };
}

/** A day-time with its seconds written (`:00` when it has none): for comparing. */
const full = (value: string): string => (value.length === 16 ? `${value}:00` : value);

/**
 * A bound as a day-time: one given as a day is that day's first minute (`min`) or its last
 * (`max`), so `max: "2026-11-16"` still allows the evening of the 16th. With `seconds`, a day's
 * ends are its first and last second.
 */
export function boundOf(
  bound: string | undefined,
  end: "min" | "max",
  seconds = false,
): DayTime | undefined {
  if (bound === undefined) return undefined;
  if (isDay(bound)) {
    return `${bound} ${end === "min" ? "00:00" : "23:59"}${
      seconds ? (end === "min" ? ":00" : ":59") : ""
    }`;
  }
  return bound;
}

/** A day-time kept within bounds (days, or day-times), seconds counting when it has them. */
export function clampDayTime(value: DayTime, min?: string, max?: string): DayTime {
  const seconds = value.length > 16;
  const low = boundOf(min, "min", seconds);
  const high = boundOf(max, "max", seconds);
  if (low && full(value) < full(low)) return low;
  if (high && full(value) > full(high)) return high;
  return value;
}

/** A minute rounded to the nearest of a step's (5: 0, 5, 10…), never past the hour's last. */
export function roundMinute(minute: number, step = 1): number {
  const by = Math.max(1, Math.min(60, Math.floor(step)));
  return Math.min(Math.round(minute / by) * by, 60 - by);
}

/**
 * Now, in a time zone (the app's), or the page's own: a day-time, its minute on the step; with
 * `seconds`, its second too.
 */
export function nowIn(
  timeZone?: string,
  step = 1,
  now: Date = new Date(),
  seconds = false,
): DayTime {
  const m = momentIn(now, timeZone);
  return dayTimeOf(
    dayOf(m.year, m.month, m.day),
    m.hour,
    seconds ? m.minute : roundMinute(m.minute, step),
    seconds ? m.second : undefined,
  );
}
