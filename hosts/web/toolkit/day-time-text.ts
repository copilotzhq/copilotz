/**
 * Day-times as people type them. A pattern is checked once (`patternProblem`): it can be read
 * back when it has each field once, and none drops its century. Then `formatPattern`
 * writes with it and `parseDayTime` reads with it, so whatever was written reads back as the value
 * it was written from, in any language. `dayTimePattern` is a language's own: its order,
 * separators and clock, with a four-digit year and the Gregorian calendar.
 *
 * ```ts
 * parseDayTime("02/11/2026 14:30:05", "dd/MM/yyyy HH:mm:ss"); // "2026-11-02 14:30:05"
 * parseDayTime("11/02/2026 02:30 PM", undefined, "en-US"); // "2026-11-02 14:30:00"
 * patternProblem("dd/MM/yy HH:mm"); // "`yy` leaves out the century: write `yyyy`"
 * ```
 */
import {
  dayOf,
  type DayTime,
  dayTimeOf,
  formatPattern,
  isDay,
  isDayTime,
  partsOf,
  weekdayOf,
} from "./dates.ts";

/** `formatPattern`'s letters, the same expression: a pattern reads as it's written. */
const TOKENS = /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|a|'[^']*'/g;

type Field = "year" | "month" | "day" | "hour" | "minute" | "second" | "weekday" | "period";

const FIELD_OF: Record<string, Field> = {
  yyyy: "year",
  yy: "year",
  MMMM: "month",
  MMM: "month",
  MM: "month",
  M: "month",
  dd: "day",
  d: "day",
  EEEE: "weekday",
  EEE: "weekday",
  HH: "hour",
  H: "hour",
  hh: "hour",
  h: "hour",
  mm: "minute",
  ss: "second",
  a: "period",
};

/** A name a field reads: its value, and the text that says it. */
type Name = { value: number; match: RegExp; spellings: string[] };

type Element =
  | { kind: "literal"; text: string; match: RegExp }
  | { kind: "number"; token: string; field: Field; min: number; max: number }
  | { kind: "name"; token: string; field: Field; names: Name[] };

type Compiled = {
  problem?: string;
  elements: Element[];
  /** The separator before `ss`, which may be left out with it. */
  optional?: number;
  seconds: boolean;
  twelve: boolean;
  /** Each hour's AM or PM, as its letters (`a`). */
  periods: string[];
  digits: string[];
};

const known = new Map<string, boolean>();
/** Whether the runtime supports a language: has its data, not only accepts its tag. */
function knows(locale: string): boolean {
  let yes = known.get(locale);
  if (yes === undefined) {
    try {
      yes = Intl.DateTimeFormat.supportedLocalesOf([locale]).length === 1;
    } catch {
      yes = false;
    }
    known.set(locale, yes);
  }
  return yes;
}

/**
 * Text as it's compared, the pattern's and the typed alike: composed, without invisible format
 * marks (bidi marks, joiners), in lower case.
 */
const keyOf = (text: string) => text.normalize("NFC").replace(/\p{Cf}/gu, "").toLowerCase();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A literal's expression: as written, any run of spaces for its spaces. */
const literalSource = (text: string) =>
  text.split(/(\s+)/).map((part) => /^\s+$/.test(part) ? "\\s+" : escaped(part)).join("");

/** A character's kind, as a boundary sees it: a digit (any, or the language's own), a space, or itself. */
const kindOf = (char: string, digits: string[]) =>
  /\p{Nd}/u.test(char) || digits.includes(char) ? "digit" : /\s/.test(char) ? "space" : char;

/** Letters and their marks: what AM and PM are told apart by. */
const lettersOf = (key: string) => key.replace(/[^\p{L}\p{M}]/gu, "");

/** The language's own digits, 0 to 9 (none when the runtime doesn't know it, or they're ASCII). */
function digitsOf(locale: string): string[] {
  if (!knows(locale)) return [];
  const format = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits = Array.from({ length: 10 }, (_, n) => format.format(n));
  return digits[0] === "0" ? [] : digits;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Whether a language's calendar is the Gregorian one, so its month names are the Gregorian months. */
const gregorian = (locale: string) =>
  ["gregory", "iso8601"].includes(new Intl.DateTimeFormat(locale).resolvedOptions().calendar);

const nameCache = new Map<string, Name[] | string>();

/**
 * A name field's names in a language, or why they can't be read: another calendar's months, two
 * that read alike.
 */
function namesOf(token: string, locale: string): Name[] | string {
  const id = `${locale}\u0000${token}`;
  const cached = nameCache.get(id);
  if (cached) return cached;
  let result: Name[] | string;
  if (token === "a") result = periodNames(locale);
  else if (token[0] === "M" && !gregorian(locale)) {
    result = `\`${token}\` names in ${locale} are another calendar's months: write \`MM\``;
  } else {
    const keys = (token[0] === "M"
      ? Array.from({ length: 12 }, (_, i) =>
        formatPattern(`2026-${two(i + 1)}-15`, token, locale))
      : Array.from({ length: 7 }, (_, w) =>
        formatPattern(`2026-11-0${w + 1}`, token, locale)))
      .map(keyOf);
    const spellings = keys.map((key) => {
      const bare = key.replace(/\.$/, "");
      return bare === key ? [key] : [key, bare];
    });
    const all = spellings.flat();
    if (
      keys.some((key) =>
        !key.trim()
      ) || new Set(all).size !== all.length
    ) {
      result = `two \`${token}\` names read alike in ${locale}`;
    } else {
      result = keys.map((key, i) => ({
        value: token[0] === "M" ? i + 1 : i,
        spellings: spellings[i],
        match: new RegExp(
          literalSource(key.replace(/\.$/, "")) + (key.endsWith(".") ? "\\.?" : ""),
          "uy",
        ),
      }));
    }
  }
  nameCache.set(id, result);
  return result;
}

const periodCache = new Map<string, string[] | string>();

/** Each hour's AM or PM in a language, as its letters, or why they can't be read. */
function periodsOf(locale: string): string[] | string {
  const cached = periodCache.get(locale);
  if (cached) return cached;
  const hours: string[] = [];
  let problem: string | undefined;
  for (let hour = 0; hour < 24 && !problem; hour++) {
    const said = new Set(
      [0, 1, 29, 30, 59].map((minute) =>
        lettersOf(keyOf(
          formatPattern({ year: 2026, month: 1, day: 5, hour, minute, second: 0 }, "a", locale),
        ))
      ),
    );
    if (said.size !== 1 || [...said][0] === "") problem = `AM and PM (\`a\`) change within an hour`;
    hours.push([...said][0]);
  }
  for (let hour = 0; hour < 12 && !problem; hour++) {
    if (hours[hour] === hours[hour + 12]) {
      problem = `AM and PM (\`a\`) can't be told apart in ${locale}`;
    }
  }
  const result = problem ?? hours;
  periodCache.set(locale, result);
  return result;
}

function periodNames(locale: string): Name[] | string {
  const hours = periodsOf(locale);
  if (typeof hours === "string") return hours;
  return [...new Set(hours)].map((letters) => {
    const value = hours.indexOf(letters);
    const at = { year: 2026, month: 1, day: 5, hour: value, minute: 0, second: 0 };
    const written = keyOf(formatPattern(at, "a", locale));
    // As the language writes it (Dzongkha's `སྔ་ཆ་`, Anii's `1ka`), or its letters in order, with
    // dots or spaces between them, and a dot after: P.M., pm, p. m.
    const spelled = [...letters].map(escaped).join("[.\\s]*") + "\\.?";
    return {
      value,
      spellings: [written, letters],
      match: new RegExp(`(?:${literalSource(written)}|${spelled})`, "uy"),
    };
  });
}

/** The kinds of character an element can start with. */
function startsOf(element: Element | undefined, digits: string[]): Set<string> {
  if (!element) return new Set();
  if (element.kind === "literal") return new Set([kindOf([...element.text][0], digits)]);
  if (element.kind === "number") return new Set(["digit"]);
  return new Set(
    element.names.flatMap((n) => n.spellings.map((s) => kindOf([...s][0], digits))),
  );
}

const compiled = new Map<string, Compiled>();

function compile(pattern: string, locale: string): Compiled {
  const id = `${locale}\u0000${pattern}`;
  let found = compiled.get(id);
  if (!found) {
    found = build(pattern, locale);
    compiled.set(id, found);
  }
  return found;
}

const NEEDED: [Field, string][] = [
  ["year", "no year (`yyyy`)"],
  ["month", "no month (`MM`, `M`, `MMM`, `MMMM`)"],
  ["day", "no day (`dd`, `d`)"],
  ["hour", "no hour (`HH`, `H`, `hh`, `h`)"],
  ["minute", "no minutes (`mm`)"],
];

function build(pattern: string, locale: string): Compiled {
  const result: Compiled = {
    elements: [],
    seconds: false,
    twelve: false,
    periods: [],
    digits: digitsOf(locale),
  };
  const fail = (problem: string): Compiled => ({ ...result, problem });

  // The pattern's pieces: its letters, and the words between them, as text is compared.
  const pieces: ({ token: string } | { text: string })[] = [];
  let last = 0;
  const literal = (text: string) => {
    const kept = keyOf(text);
    const before = pieces[pieces.length - 1];
    if (before && "text" in before) before.text += kept;
    else if (kept) pieces.push({ text: kept });
  };
  for (const hit of pattern.matchAll(TOKENS)) {
    literal(pattern.slice(last, hit.index));
    last = hit.index + hit[0].length;
    if (hit[0][0] === "'") literal(hit[0].slice(1, -1));
    else pieces.push({ token: hit[0] });
  }
  literal(pattern.slice(last));

  // P1, P2: the fields, once each.
  const tokens = pieces.flatMap((p) => ("token" in p ? [p.token] : []));
  if (tokens.includes("yy")) return fail("`yy` leaves out the century: write `yyyy`");
  const seen = new Map<Field, string>();
  for (const token of tokens) {
    const field = FIELD_OF[token];
    const before = seen.get(field);
    if (before) return fail(`the ${field} twice (\`${before}\`, \`${token}\`)`);
    seen.set(field, token);
  }
  for (const [field, problem] of NEEDED) if (!seen.has(field)) return fail(problem);
  const hour = seen.get("hour")!;
  result.twelve = hour === "h" || hour === "hh";
  if (result.twelve && !seen.has("period")) return fail(`\`${hour}\` needs \`a\` (AM or PM)`);
  if (!result.twelve && seen.has("period")) {
    return fail("`a` needs a 12-hour hour (`h`, `hh`)");
  }
  result.seconds = seen.has("second");

  // P5, P4: a language the runtime knows, for names, and names that can be read.
  const named = tokens.some((t) => /^(MMMM?|EEEE?|a)$/.test(t));
  if (named && !knows(locale)) return fail(`the runtime doesn't know the language "${locale}"`);
  for (const piece of pieces) {
    if ("text" in piece) {
      result.elements.push({
        kind: "literal",
        text: piece.text,
        match: new RegExp(literalSource(piece.text), "uy"),
      });
    } else if (/^(MMMM?|EEEE?|a)$/.test(piece.token)) {
      const names = namesOf(piece.token, locale);
      if (typeof names === "string") return fail(names);
      result.elements.push({
        kind: "name",
        token: piece.token,
        field: FIELD_OF[piece.token],
        names,
      });
    } else {
      const width = piece.token === "yyyy" ? 4 : piece.token.length;
      result.elements.push({
        kind: "number",
        token: piece.token,
        field: FIELD_OF[piece.token],
        min: piece.token.length === 1 ? 1 : width,
        max: piece.token.length === 1 ? 2 : width,
      });
    }
  }
  if (result.twelve) {
    const periods = periodsOf(locale);
    if (typeof periods === "string") return fail(periods);
    result.periods = periods;
  }

  // Seconds may be left out with a one-character separator before them.
  const { elements, digits } = result;
  const s = elements.findIndex((e) => e.kind === "number" && e.field === "second");
  const separator = elements[s - 1];
  if (
    s > 0 && separator.kind === "literal" && [...separator.text].length === 1 &&
    !/[\p{L}\p{Nd}\s]/u.test(separator.text) && !digits.includes(separator.text) &&
    !startsOf(elements[s + 1], digits).has(kindOf(separator.text, digits))
  ) result.optional = s - 1;

  // Two-digit fields take one digit when what follows can't be a digit.
  for (const [i, element] of elements.entries()) {
    const next = startsOf(elements[i + 1], digits);
    // Before the seconds' separator: what follows the seconds may come next too.
    if (result.optional === i + 1) {
      for (const kind of startsOf(elements[i + 3], digits)) next.add(kind);
    }
    if (element.kind === "number" && element.token.length === 2 && !next.has("digit")) {
      element.min = 1;
    }
  }
  return result;
}

/**
 * Why a day-time pattern can't be read back in a language, as a sentence for the developer
 * ("`yy` leaves out the century: write `yyyy`"), or `undefined` when every text it writes
 * (`formatPattern`) reads back (`parseDayTime`) as the value it was written from. Check an app's
 * patterns with it at startup or in a test.
 *
 * A pattern that can be read back has one year (`yyyy`, never `yy`), month (`MM`, `M`, `MMM`,
 * `MMMM`), day (`dd`, `d`), hour (`HH`, `H`, or `hh`, `h` with `a`) and minutes (`mm`), and
 * maybe seconds (`ss`) and a weekday (`EEE`, `EEEE`). Its names, in the language, are distinct,
 * and its month names the Gregorian months: Persian and Thai patterns write `MM`. A pattern with
 * names needs a language the runtime supports. Fields of no fixed length (`d`, `M`, names) need
 * something between them: `yyyy/dM` writes `2026/211` for November 2nd and January 21st, and that
 * text is refused.
 */
export function patternProblem(pattern: string, locale = "en"): string | undefined {
  return compile(pattern, locale).problem;
}

/** A field's value read from digits at a place: ASCII or the language's, one kind. */
function numbersAt(
  input: string,
  at: number,
  element: { min: number; max: number },
  digits: string[],
) {
  const out: [end: number, value: number][] = [];
  let system: "ascii" | "own" | undefined;
  let value = 0;
  let end = at;
  for (let count = 1; count <= element.max; count++) {
    const char = String.fromCodePoint(input.codePointAt(end) ?? 0);
    const ascii = char >= "0" && char <= "9" && char.length === 1;
    const own = digits.indexOf(char);
    const kind = ascii ? "ascii" : own >= 0 ? "own" : undefined;
    if (!kind || (system && kind !== system)) break;
    system = kind;
    value = value * 10 + (ascii ? +char : own);
    end += char.length;
    if (count >= element.min) out.push([end, value]);
  }
  return out;
}

type Read = Partial<Record<Field, number>>;

/** The day-times the text reads as, to the second one (one is enough to refuse it). */
function readings(input: string, c: Compiled): Set<DayTime> {
  const found = new Set<DayTime>();
  const walk = (i: number, at: number, read: Read) => {
    if (found.size > 1) return;
    if (i === c.elements.length) {
      const value = at === input.length ? valueOf(read, c) : undefined;
      if (value) found.add(value);
      return;
    }
    if (i === c.optional) walk(i + 2, at, { ...read, second: 0 });
    const element = c.elements[i];
    if (element.kind === "literal") {
      element.match.lastIndex = at;
      if (element.match.test(input)) walk(i + 1, element.match.lastIndex, read);
    } else if (element.kind === "number") {
      for (const [end, value] of numbersAt(input, at, element, c.digits)) {
        walk(i + 1, end, { ...read, [element.field]: value });
      }
    } else {
      for (const name of element.names) {
        name.match.lastIndex = at;
        if (name.match.test(input)) {
          walk(i + 1, name.match.lastIndex, { ...read, [element.field]: name.value });
        }
      }
    }
  };
  walk(0, 0, {});
  return found;
}

/** The day-time a reading names, if it's a real one. */
function valueOf(read: Read, c: Compiled): DayTime | undefined {
  const { year = -1, month = 0, day = 0, minute = -1, second = 0 } = read;
  if (month < 1 || month > 12 || day < 1) return undefined;
  const date = dayOf(year, month, day);
  if (!isDay(date) || partsOf(date)[0] !== year || partsOf(date)[1] !== month) return undefined;
  if (read.weekday !== undefined && weekdayOf(date) !== read.weekday) return undefined;
  let hour = read.hour ?? -1;
  if (c.twelve) {
    if (hour < 1 || hour > 12) return undefined;
    // The hour whose AM or PM is the one typed: `read.period` is the first hour that says it.
    const said = c.periods[read.period!];
    const hours = [hour % 12, hour % 12 + 12].filter((h) => c.periods[h] === said);
    if (hours.length !== 1) return undefined;
    hour = hours[0];
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second > 59) return undefined;
  return dayTimeOf(date, hour, minute, c.seconds ? second : undefined);
}

/**
 * A day and a time read from text typed in a pattern (`dd/MM/yyyy HH:mm:ss`, `M/d/yyyy h:mm a`;
 * see `formatPattern`), the inverse of `formatPattern` with the same pattern and language:
 * `parseDayTime(formatPattern(value, pattern, locale), pattern, locale)` is `value`. With no
 * pattern, the language's own (`dayTimePattern(locale)`). `locale` is the language of month,
 * weekday and AM/PM words, and of the digits it reads besides ASCII (English by default; the
 * page's is `lang()`).
 *
 * It reads what the pattern writes, allowing only this: spaces of any kind and number where the
 * pattern has spaces, and at the text's edges; letters in any case; a month or weekday name
 * without its final dot; AM and PM with or without dots (`p.m.`, `pm`); one digit where the
 * pattern writes two and no digit follows; the language's own digits
 * (Arabic-Indic, Persian, Bengali…), one kind to a field; invisible marks (right-to-left marks)
 * anywhere; and seconds left out with the `:` before them, when the pattern writes them (they're
 * `:00`).
 *
 * `undefined` for text that isn't one real day and time in the pattern: February 30th, 25:00,
 * 13 PM, a two-digit year, a weekday that isn't the date's, seconds the pattern doesn't write,
 * text that could be two day-times. Every text is `undefined` when the pattern can't be read back
 * (`patternProblem` says why). Days are Gregorian, whatever the language's calendar: a Buddhist
 * year typed in Thai is read as that Gregorian year. Years have four digits, 0000 (1 BC) to 9999.
 * The value has seconds (`YYYY-MM-DD HH:mm:ss`) when the pattern writes them, and none when it
 * doesn't.
 *
 * ```ts
 * parseDayTime("02/11/2026 14:30:05", "dd/MM/yyyy HH:mm:ss"); // "2026-11-02 14:30:05"
 * parseDayTime("11/2/2026 2:30 PM", "M/d/yyyy h:mm a"); // "2026-11-02 14:30"
 * parseDayTime("31/02/2026 10:00", "dd/MM/yyyy HH:mm"); // undefined: February has no 31st
 * parseDayTime("11/02/2026 02:30 PM", undefined, "en-US"); // "2026-11-02 14:30:00"
 * ```
 */
export function parseDayTime(text: string, pattern?: string, locale = "en"): DayTime | undefined {
  const c = compile(pattern ?? dayTimePattern(locale), locale);
  if (c.problem) return undefined;
  const values = readings(keyOf(text).trim(), c);
  return values.size === 1 ? [...values][0] : undefined;
}

const ownCache = new Map<string, { day: string; time: string }>();

/** A part of `Intl`'s writing as a pattern's letters, or undefined for a part it doesn't know. */
const letter = (type: string, twelve: boolean): string | undefined =>
  ({
    year: "yyyy",
    month: "MM",
    day: "dd",
    hour: twelve ? "hh" : "HH",
    minute: "mm",
    second: "ss",
    dayPeriod: "a",
  } as Record<string, string>)[type];

/** A language's own pattern, its day and its time apart (the toolkit's order when it has none). */
function ownParts(locale: string, seconds: boolean): { day: string; time: string } {
  const id = `${locale}\u0000${seconds}`;
  const made = ownCache.get(id);
  if (made) return made;
  let parts = { day: "yyyy-MM-dd", time: seconds ? "HH:mm:ss" : "HH:mm" };
  if (!knows(locale)) {
    ownCache.set(id, parts);
    return parts;
  }
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    const twelve = cycle === "h11" || cycle === "h12";
    const sample = new Date(Date.UTC(2026, 10, 2, 14, 30, 5));
    const common = { calendar: "gregory", numberingSystem: "latn", timeZone: "UTC" } as const;
    const lettered = (options: Intl.DateTimeFormatOptions) => {
      const written = new Intl.DateTimeFormat(locale, { ...common, ...options });
      const out = written.formatToParts(sample).map(({ type, value }) => {
        if (type === "literal") {
          const text = value.replace(/'/g, "").replace(/\s+/g, " ");
          return text ? `'${text}'` : "";
        }
        return letter(type, twelve);
      });
      return out.includes(undefined) ? undefined : out.join("");
    };
    const day = lettered({ year: "numeric", month: "2-digit", day: "2-digit" });
    const time = lettered({
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hourCycle: twelve ? "h12" : "h23",
    });
    if (day && time && patternProblem(`${day} ${time}`, locale) === undefined) {
      parts = { day, time };
    }
  } catch {
    // A language the runtime doesn't know: the toolkit's own order.
  }
  ownCache.set(id, parts);
  return parts;
}

/**
 * The pattern a language writes a day and a time in, as people type them: the language's order
 * and separators and its 12- or 24-hour clock, with a four-digit year, two-digit fields, the
 * Gregorian calendar, and seconds unless `seconds` is false. `MM/dd/yyyy hh:mm:ss a` in American
 * English, `dd/MM/yyyy HH:mm:ss` in Brazilian Portuguese, `yyyy/MM/dd HH:mm:ss` in Japanese,
 * `dd.MM.yyyy HH.mm.ss` in Finnish; Thai and Persian patterns write the Gregorian year too. Its
 * words are quoted (`MM'/'dd'/'yyyy hh':'mm':'ss' 'a`), with plain spaces. A language the runtime
 * doesn't support (`Intl.DateTimeFormat.supportedLocalesOf` leaves it out: `zz-ZZ`), or one whose
 * own pattern can't be read back, gets `yyyy-MM-dd HH:mm:ss`.
 *
 * What `parseDayTime` reads with no pattern, and what `DateRangePicker` with `seconds` shows
 * without a `format` it can read back; `formatPattern(value, dayTimePattern(locale), locale)` writes
 * a value in it.
 */
export function dayTimePattern(locale = "en", seconds = true): string {
  const { day, time } = ownParts(locale, seconds);
  return `${day} ${time}`;
}

const TIME_FIELDS = new Set<Field>(["hour", "minute", "second", "period"]);

/**
 * The pattern a range to the second (`DateRangePicker` with `seconds`) writes and reads its ends
 * by, in a language: `format` when it can be read back (a day's pattern with the language's time
 * after it; a day-time pattern to the minute with `:ss` after its minutes), or else the
 * language's own (`dayTimePattern`), with why `format` was set aside.
 */
export function rangeSecondsPattern(
  format: unknown,
  locale: string,
): { pattern: string; setAside?: string } {
  const own = dayTimePattern(locale);
  if (format === undefined) return { pattern: own };
  if (typeof format !== "string") {
    return { pattern: own, setAside: "a function can't be read back" };
  }
  const tokens = [...format.matchAll(TOKENS)].filter(([token]) => token[0] !== "'");
  const mm = tokens.find(([token]) => token === "mm");
  const pattern = !tokens.some(([token]) => TIME_FIELDS.has(FIELD_OF[token]))
    ? `${format} ${ownParts(locale, true).time}`
    : tokens.some(([token]) => token === "ss") || !mm
    ? format
    : `${format.slice(0, mm.index + 2)}:ss${format.slice(mm.index + 2)}`;
  const problem = patternProblem(pattern, locale);
  return problem ? { pattern: own, setAside: problem } : { pattern };
}

/** An end as the toolkit keeps one, typed or pasted: `2026-11-02 14:30:05`, or with a `T`. */
const KEPT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/;

/**
 * An end of a range to the second read from typed text, always with seconds: by the range's
 * pattern (`rangeSecondsPattern`), or as the toolkit keeps one. Text the two read as different
 * ends is refused (`yyyy-dd-MM` reads `2026-11-02` as February 11th).
 */
export function readEnd(text: string, pattern: string, locale: string): DayTime | undefined {
  const read = parseDayTime(text, pattern, locale);
  const byPattern = read && read.length === 16 ? `${read}:00` : read;
  const kept = KEPT.exec(text.replace(/\p{Cf}/gu, "").trim());
  const value = kept && `${kept[1]} ${kept[2]}`;
  const asKept = value && isDayTime(value)
    ? (value.length === 16 ? `${value}:00` : value)
    : undefined;
  if (byPattern && asKept && byPattern !== asKept) return undefined;
  return byPattern ?? asKept;
}
