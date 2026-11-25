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
      era: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(at).map(({ type, value }) => [type, value]),
  );
  return {
    year: parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
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

/** Unquoted spaces between fields may vary. */
const spaced = (text: string): string => escaped(text).replace(/\s+/g, "\\s*");

/** The letters that write a time of day. */
const TIME_LETTERS = new Set(["HH", "H", "hh", "h", "mm", "ss", "a"]);

/** Whether a pattern writes a time of day (`HH:mm`, `h:mm a`), not only a day. */
export const hasTime = (pattern: string): boolean =>
  [...pattern.matchAll(TOKENS)].some(([token]) => TIME_LETTERS.has(token));

/** What a pattern's letters read from text: a day's parts, and a time's (when it writes one). */
type Read = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  /** The hour was read on a 12-hour clock (`h`, `hh`). */
  twelve?: boolean;
  /** AM or PM, as typed. */
  period?: string;
  minute?: number;
  second?: number;
};

const numerals = new Map<string, string[]>();
function localeDigits(locale: string): string[] {
  let digits = numerals.get(locale);
  if (!digits) {
    const format = new Intl.NumberFormat(locale, { useGrouping: false });
    digits = Array.from({ length: 10 }, (_, n) => format.format(n));
    numerals.set(locale, digits);
  }
  return digits;
}

/** Reads decimal digits as the locale writes them, keeping ASCII input valid too. */
function asciiDigits(text: string, locale: string): string {
  if (!/(?![0-9])\p{Nd}/u.test(text)) return text;
  const digits = localeDigits(locale);
  return text.replace(/\p{Nd}/gu, (digit) => {
    const value = digits.indexOf(digit);
    return value < 0 ? digit : String(value);
  });
}

/**
 * Text read by a pattern, letter by letter (see `formatPattern`), or `undefined` when it doesn't
 * fit. Days and months take one or two digits, `yyyy` four, `yy` two; month names are the
 * language's; weekday names are skipped. Hours, minutes and seconds take one or two digits, and
 * seconds may be left out (with the words before them), or typed where the pattern has none.
 */
function readPattern(
  text: string,
  pattern: string,
  locale: string,
  syntax: "picker" | "pattern" | "locale",
  interpret: (read: Read) => string | undefined,
): string | undefined {
  const order: string[] = [];
  const tokens = [...pattern.matchAll(TOKENS)];
  const timed = tokens.some(([token]) => TIME_LETTERS.has(token));
  if (syntax === "picker" && timed) return undefined;
  const seconds = tokens.some(([token]) => token === "ss");
  let source = "";
  let optionalSeconds = "";
  let last = 0;
  // Where the words since the last letter start, in `source`: what seconds left out take along.
  let words = 0;
  const literal = (end: number) => {
    source += spaced(pattern.slice(last, end));
  };
  const digits = (kind: string) => {
    source += "(\\p{Nd}{1,2})";
    order.push(kind);
  };
  for (const hit of tokens) {
    literal(hit.index);
    last = hit.index + hit[0].length;
    const token = hit[0];
    if (token[0] === "'") {
      const quoted = token.slice(1, -1);
      source += syntax === "locale" ? spaced(quoted).replace(/,/g, ",?") : escaped(quoted);
      continue;
    }
    if (token === "yyyy") {
      source += "(\\p{Nd}{4})";
      order.push("y");
    } else if (token === "yy") {
      // A whole year typed into a day-time field must be separate from adjacent digits.
      source += timed ? "((?<!\\p{Nd})\\p{Nd}{4}(?!\\p{Nd})|\\p{Nd}{2})" : "(\\p{Nd}{2})";
      order.push("yy");
    } else if (token === "MMMM" || token === "MMM") {
      source += "(\\p{L}+\\.?)";
      order.push(token);
    } else if (token === "MM" || token === "M") digits("M");
    else if (token === "dd" || token === "d") digits("d");
    else if (token === "EEEE" || token === "EEE") source += "\\p{L}+\\.?";
    else if (token === "HH" || token === "H") digits("H");
    else if (token === "hh" || token === "h") digits("h");
    else if (token === "mm") {
      digits("m");
      // Seconds the pattern doesn't write may still be typed.
      if (!seconds) {
        optionalSeconds = ":(\\p{Nd}{1,2})";
        source += `(?:${optionalSeconds})?`;
        order.push("s");
      }
    } else if (token === "ss") {
      // Seconds may be left out, and the words before them too.
      optionalSeconds = `${source.slice(words)}(\\p{Nd}{1,2})`;
      source = `${source.slice(0, words)}(?:${optionalSeconds})?`;
      order.push("s");
    } else if (token === "a") {
      source += "(\\p{L}+\\.?(?:\\s?\\p{L}+\\.?)?)";
      order.push("a");
    }
    words = source.length;
  }
  literal(pattern.length);
  const input = text.trim();
  const match = (expression: string) => new RegExp(`^${expression}$`, "iu").exec(input);
  const first = match(source);
  if (!first) return undefined;
  const readMatch = (captures: RegExpExecArray) => {
    const read: Read = {};
    for (const [i, kind] of order.entries()) {
      const token = captures[i + 1];
      if (!token) continue; // seconds omitted
      if (kind === "a") {
        read.period = token;
        continue;
      }
      if (kind === "MMM" || kind === "MMMM") {
        const wanted = token.toLowerCase().replace(/\.$/, "");
        let found: number | undefined;
        for (let month = 1; month <= 12; month++) {
          const name = formatPattern(dayOf(2000, month, 1), kind, locale);
          if (name.toLowerCase().replace(/\.$/, "") !== wanted) continue;
          if (found !== undefined) return undefined;
          found = month;
          if (syntax === "picker") break;
        }
        if (found === undefined) return undefined;
        read.month = found;
        continue;
      }
      const part = syntax === "picker" ? token : asciiDigits(token, locale);
      const value = Number(part);
      if (!Number.isInteger(value)) return undefined;
      if (kind === "y") read.year = value;
      else if (kind === "yy") read.year = part.length === 4 ? value : 2000 + value;
      else if (kind === "M") read.month = value;
      else if (kind === "d") read.day = value;
      else if (kind === "H") read.hour = value;
      else if (kind === "h") Object.assign(read, { hour: value, twelve: true });
      else if (kind === "m") read.minute = value;
      else if (kind === "s") read.second = value;
    }
    return interpret(read);
  };

  // Keep rc.63's first match for ASCII date-only input. Locale digits and day-times must
  // have a unique reading, even when adjacent fields have no separator.
  if (
    syntax === "picker" || !timed &&
      !order.some((kind, i) => ["y", "yy", "M", "d"].includes(kind) && /[^0-9]/.test(first[i + 1]))
  ) return readMatch(first);

  const readings = new Set<string>();
  const collect = (expression: string) => {
    if (readings.size > 1) return;
    const captures = match(expression);
    if (!captures) return;
    // Resolve one variable-width numeric capture at a time. A branch ends as soon as it
    // cannot match the input. Literal braces in a pattern have already been escaped.
    if (expression.includes("{1,2}")) {
      collect(expression.replace("{1,2}", "{1}"));
      collect(expression.replace("{1,2}", "{2}"));
    } else {
      const value = readMatch(captures);
      if (value !== undefined) readings.add(value);
    }
  };
  if (optionalSeconds) {
    const group = `(?:${optionalSeconds})?`;
    collect(source.replace(group, () => optionalSeconds));
    collect(source.replace(group, "()")); // preserve the capture order
  } else collect(source);
  return readings.size === 1 ? readings.values().next().value : undefined;
}

/** The day a reading names, if it's a real one: no February 30th, no 13th month. */
const dayRead = ({ year, month, day }: Read): string | undefined => {
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (month < 1 || month > 12 || day < 1) return undefined;
  const result = dayOf(year, month, day);
  const [, m, d] = partsOf(result);
  return isDay(result) && m === month && d === day ? result : undefined;
};

/**
 * A day read from text written by a pattern (what `formatPattern` writes: `dd/MM/yyyy`,
 * `d MMM yyyy`, `yyyy-MM-dd`), or `undefined` when the text isn't a real day. Day and month take
 * one or two digits, `yyyy` four, `yy` two (20xx); month names are read in the language's, in any
 * case; weekday names are skipped. A pattern with no year, month or day can't be read, nor one
 * with a time's letters: `parseDayTime` reads those.
 */
export function parsePattern(
  text: string,
  pattern: string,
  locale = "en",
  localeSeparators = false,
): string | undefined {
  if (hasTime(pattern)) return undefined;
  return readPattern(text, pattern, locale, localeSeparators ? "locale" : "pattern", dayRead);
}

/** Range inputs keep rc.63's ASCII numeric fields and literal separators. */
export function parsePickerDay(text: string, pattern: string, locale: string): string | undefined {
  return readPattern(text, pattern, locale, "picker", dayRead);
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

/** A word reduced to its letters, lower case: `"P.M."` and `"pm"` are one. */
const letters = (text: string): string => text.toLowerCase().replace(/[^\p{L}]/gu, "");

/** Whether typed text says PM (`true`) or AM (`false`), in a language or in English. */
function afternoon(text: string, locale: string): boolean | undefined {
  const said = letters(text);
  const pm = letters(formatPattern("2000-01-01 21:00", "a", locale));
  const am = letters(formatPattern("2000-01-01 09:00", "a", locale));
  if (said === pm || said === "pm" || said === "p") return true;
  if (said === am || said === "am" || said === "a") return false;
  return undefined;
}

/** The page language's short date and time, as a pattern (`M/d/yyyy, h:mm:ss a`), by language. */
const shortPatterns = new Map<string, string>();

/**
 * The pattern a language writes a short date and time by, read off a sample (`M/d/yyyy, h:mm:ss
 * a` in English, `dd/MM/yyyy, HH:mm:ss` in Brazilian Portuguese): what a day-time field shows and
 * reads when the app gives it no pattern of its own.
 */
export function dayTimePattern(locale = "en"): string {
  const known = shortPatterns.get(locale);
  if (known) return known;
  const sample = new Date(Date.UTC(2003, 3, 5, 13, 6, 7));
  const options = { dateStyle: "short", timeStyle: "medium", timeZone: "UTC" } as const;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(locale, options).formatToParts(sample);
  } catch {
    parts = new Intl.DateTimeFormat("en", options).formatToParts(sample);
  }
  const twelve = parts.some((part) => part.type === "dayPeriod");
  const pattern = parts.map(({ type, value }) => {
    const long = [...value].length === 2;
    switch (type) {
      case "year":
        return long ? "yy" : "yyyy";
      case "month":
        return /^\p{Nd}+$/u.test(value) ? (long ? "MM" : "M") : "MMM";
      case "day":
        return long ? "dd" : "d";
      case "hour":
        return twelve ? (long ? "hh" : "h") : (long ? "HH" : "H");
      case "minute":
        return "mm";
      case "second":
        return "ss";
      case "dayPeriod":
        return "a";
      case "literal":
        return value ? `'${value.replaceAll("'", "")}'` : "";
      default:
        return "";
    }
  }).join("");
  shortPatterns.set(locale, pattern);
  return pattern;
}

/**
 * A day and a time of it, read from text typed in the app's pattern, the inverse of
 * `formatPattern` (and of `formatDayTime` with a pattern): `"16/11/2026 14:30:05"` by
 * `dd/MM/yyyy HH:mm:ss` is `"2026-11-16 14:30:05"`, and `"11/16/2026 2:30 PM"` by
 * `M/d/yyyy h:mm a` is `"2026-11-16 14:30"`. Day and month come in the pattern's order; hours
 * are 0–23 (`HH`), or 1–12 with AM or PM (`hh`, `a`: the language's words, or English's).
 * Seconds may be left out, or typed where the pattern has none; the value has them when the
 * pattern writes them, or when they were typed. Spacing between fields can vary. A locale's
 * generated separators also allow a comma to be left out. Text that isn't a real day and time
 * (February 30th, 25:00, 13 PM) is `undefined`. Ambiguous input and calendars other than
 * Gregorian or ISO also return `undefined`.
 *
 * With no pattern, it reads the language's own short date and time (`dayTimePattern`), and a
 * day-time as the toolkit keeps one (`2026-11-16 14:30`, or with a `T`). `locale` is the
 * language of month names and AM and PM (English by default; the page's is `lang()`). For the
 * moment it names, `dateOfDayTime`.
 */
export function parseDayTime(
  text: string,
  pattern?: string,
  locale = "en",
  localeSeparators = pattern === undefined,
): DayTime | undefined {
  let calendar: string;
  try {
    calendar = new Intl.DateTimeFormat(locale).resolvedOptions().calendar;
  } catch {
    return undefined;
  }
  if (calendar !== "gregory" && calendar !== "iso8601") return undefined;
  const typed = text.trim();
  if (pattern === undefined) {
    const kept = typed.replace(/^(\d{4}-\d{2}-\d{2})T/, "$1 ");
    if (isDayTime(kept)) return kept;
  }
  const by = pattern ?? dayTimePattern(locale);
  return readPattern(typed, by, locale, localeSeparators ? "locale" : "pattern", (read) => {
    const day = dayRead(read);
    if (!day || read.hour === undefined) return undefined;
    let hour = read.hour;
    const pm = read.period === undefined ? undefined : afternoon(read.period, locale);
    if (read.twelve) {
      if (hour < 1 || hour > 12 || pm === undefined) return undefined;
      hour = (hour % 12) + (pm ? 12 : 0);
    } else if (read.period !== undefined && pm !== (hour >= 12)) return undefined;
    const minute = read.minute ?? 0;
    if (hour > 23 || minute > 59 || (read.second ?? 0) > 59) return undefined;
    // Seconds the app's pattern writes are always there; the language's, only when typed.
    const second = read.second ?? (pattern !== undefined && showsSeconds(pattern) ? 0 : undefined);
    return dayTimeOf(day, hour, minute, second);
  });
}

/**
 * A day-time pattern's day alone, what a field of the day shows: `dd/MM/yyyy HH:mm:ss` is
 * `dd/MM/yyyy`, `d 'de' MMMM 'às' HH:mm` is `d 'de' MMMM`. A pattern of a day stays as it is.
 */
export function dayPatternOf(pattern: string): string {
  const times = [...pattern.matchAll(TOKENS)].filter(([token]) => TIME_LETTERS.has(token));
  if (!times.length) return pattern;
  const last = times[times.length - 1];
  const before = pattern.slice(0, times[0].index).replace(/(?:\s|[,;]|'[^']*')+$/, "");
  const after = pattern.slice(last.index + last[0].length).replace(/^(?:\s|[,;]|'[^']*')+/, "");
  return before && after ? `${before} ${after}` : before || after;
}

/** A moment's wall clock, in milliseconds as if it were UTC. */
const wallOf = (m: Moment): number => {
  const at = new Date(0);
  at.setUTCFullYear(m.year, m.month - 1, m.day);
  at.setUTCHours(m.hour, m.minute, m.second);
  return at.getTime();
};

/**
 * The moment a day-time (or a day, at its start) is in a time zone (the app's, IANA), as a
 * `Date`: for what needs one, a timestamp to store or a time to count from
 * (`dateOfDayTime("2026-11-16 14:30", "America/Sao_Paulo").toISOString()` is
 * `"2026-11-16T17:30:00.000Z"`). Without a zone, the page's own. A repeated time uses its
 * earlier instant, and a skipped time moves forward by the gap. `undefined` for text that's
 * neither.
 */
export function dateOfDayTime(value: string, timeZone?: string): Date | undefined {
  const timed = isDayTime(value);
  const day = timed ? value.slice(0, 10) : isDay(value) ? value : undefined;
  if (!day) return undefined;
  const { hour, minute, second = 0 } = timed ? partsOfDayTime(value) : { hour: 0, minute: 0 };
  const [year, month, date] = partsOf(day);
  const wall = wallOf({ year, month, day: date, hour, minute, second });
  const wallAt = (at: number) => wallOf(momentIn(new Date(at), timeZone));
  // Sample both sides of any transition around this wall time, including a skipped day.
  const dayMs = 86_400_000;
  const before = wallAt(wall - dayMs) - (wall - dayMs);
  const after = wallAt(wall + dayMs) - (wall + dayMs);
  const earlier = wall - Math.max(before, after);
  if (before === after || wallAt(earlier) === wall) return new Date(earlier);
  // On an ordinary day the later candidate matches. In a gap it moves forward by the gap.
  return new Date(wall - Math.min(before, after));
}
