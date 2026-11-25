/**
 * Day-times as people type them. A pattern is checked once (`patternProblem`): it can be read
 * back when no two values it writes look alike and none drops its century. Then `formatPattern`
 * writes with it and `parseDayTime` reads with it, so whatever was written reads back as the value
 * it was written from, in any language. `dayTimePattern` is a language's own: its order,
 * separators and clock, with a four-digit year and the Gregorian calendar.
 *
 * ```ts
 * parseDayTime("02/11/2026 14:30:05", "dd/MM/yyyy HH:mm:ss"); // "2026-11-02 14:30:05"
 * parseDayTime("11/02/2026 02:30 PM", undefined, "en-US"); // "2026-11-02 14:30:00"
 * patternProblem("yyyy/dM HH:mm"); // "`d` is followed by a digit (`M`): …"
 * ```
 */
import {
  dayOf,
  type DayTime,
  dayTimeOf,
  formatPattern,
  isDay,
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

/** Text as it's compared: composed, without invisible format marks (bidi marks, joiners). */
const clean = (text: string) => text.normalize("NFC").replace(/\p{Cf}/gu, "");

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A literal's expression: as written, any run of spaces for its spaces, letters in any case. */
const literalSource = (text: string) =>
  text.split(/(\s+)/).map((part) => /^\s+$/.test(part) ? "\\s+" : escaped(part)).join("");

const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** A character's kind, as a boundary sees it. */
const kindOf = (char: string) =>
  /\p{Nd}/u.test(char) ? "digit" : /\s/.test(char) ? "space" : fold(char);

/** Letters and their marks: what AM and PM are compared on. */
const lettersOf = (text: string) => fold(text).replace(/[^\p{L}\p{M}]/gu, "");

const known = new Map<string, boolean>();
function knows(locale: string): boolean {
  let yes = known.get(locale);
  if (yes === undefined) {
    try {
      new Intl.DateTimeFormat(locale);
      yes = true;
    } catch {
      yes = false;
    }
    known.set(locale, yes);
  }
  return yes;
}

/** The language's own digits, 0 to 9 (none when the runtime doesn't know it, or they're ASCII). */
function digitsOf(locale: string): string[] {
  if (!knows(locale)) return [];
  const format = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits = Array.from({ length: 10 }, (_, n) => format.format(n));
  return digits[0] === "0" ? [] : digits;
}

const two = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => partsOf(dayOf(year, month + 1, 0))[2];

const nameCache = new Map<string, Name[] | string>();

/**
 * A name field's names in a language, or why they can't be read: month names that change within
 * a month (another calendar's), two that read alike.
 */
function namesOf(token: string, locale: string): Name[] | string {
  const id = `${locale}\u0000${token}`;
  const cached = nameCache.get(id);
  if (cached) return cached;
  let result: Name[] | string;
  if (token === "a") result = periodNames(locale);
  else {
    const said = token[0] === "M"
      ? Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        const names = new Set<string>();
        for (const year of [2024, 2025]) {
          for (const day of [1, 15, lastDay(year, month)]) {
            names.add(clean(formatPattern(`${year}-${two(month)}-${two(day)}`, token, locale)));
          }
        }
        return names.size === 1 ? [...names][0] : undefined;
      })
      : Array.from(
        { length: 7 },
        (_, w) => clean(formatPattern(`2026-11-0${w + 1}`, token, locale)),
      );
    if (said.some((name) => name === undefined)) {
      result = `\`${token}\` names in ${locale} change within a month (its calendar isn't the ` +
        "Gregorian one): write `MM`";
    } else {
      const names = said as string[];
      const spellings = names.map((name) => {
        const bare = name.replace(/\.$/, "");
        return bare === name ? [fold(name)] : [fold(name), fold(bare)];
      });
      const all = spellings.flat();
      if (names.some((name) => !name.trim()) || new Set(all).size !== all.length) {
        result = `two \`${token}\` names read alike in ${locale}`;
      } else {
        result = names.map((name, i) => ({
          value: token[0] === "M" ? i + 1 : i,
          spellings: spellings[i],
          match: new RegExp(
            literalSource(name.replace(/\.$/, "")) + (name.endsWith(".") ? "\\.?" : ""),
            "iuy",
          ),
        }));
      }
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
        lettersOf(clean(
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
  return [...new Set(hours)].map((letters) => ({
    value: hours.indexOf(letters),
    spellings: [letters],
    // Its letters in order, with dots or spaces between them, and a dot after: P.M., pm, p. m.
    match: new RegExp([...letters].map(escaped).join("[.\\s]*") + "\\.?", "iuy"),
  }));
}

/** The kinds of character an element can start with. */
function startsOf(element: Element | undefined): Set<string> {
  if (!element) return new Set();
  if (element.kind === "literal") return new Set([kindOf([...element.text][0])]);
  if (element.kind === "number") return new Set(["digit"]);
  return new Set(element.names.flatMap((n) => n.spellings.map((s) => kindOf(s[0]))));
}

/** The kinds of character that could carry an element on past where one reading of it ends. */
function continuationOf(element: Element): Set<string> {
  const out = new Set<string>();
  if (element.kind === "number") {
    if (element.min !== element.max) out.add("digit");
  } else if (element.kind === "name") {
    const all = element.names.flatMap((n) => n.spellings);
    if (element.token === "a") out.add(".");
    for (const a of all) {
      for (const b of all) {
        if (b.length > a.length && b.startsWith(a)) {
          out.add(kindOf(b[a.length]));
          if (element.token === "a") out.add(".").add("space");
        }
      }
    }
  }
  return out;
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

  // The pattern's pieces: its letters, and the words between them.
  const pieces: ({ token: string } | { text: string })[] = [];
  let last = 0;
  const literal = (text: string) => {
    const kept = clean(text);
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
        match: new RegExp(literalSource(piece.text), "iuy"),
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
  const elements = result.elements;
  const s = elements.findIndex((e) => e.kind === "number" && e.field === "second");
  const separator = elements[s - 1];
  if (
    s > 0 && separator.kind === "literal" && [...separator.text].length === 1 &&
    !/[\p{L}\p{Nd}\s]/u.test(separator.text) &&
    !startsOf(elements[s + 1]).has(kindOf(separator.text))
  ) result.optional = s - 1;

  // P3: what follows a field of no fixed length can't carry it on. Two-digit fields take one
  // digit when what follows can't be a digit.
  for (const [i, element] of elements.entries()) {
    const next = startsOf(elements[i + 1]);
    // Before the seconds' separator: what follows the seconds may come next too.
    if (result.optional === i + 1) { for (const kind of startsOf(elements[i + 3])) next.add(kind); }
    if (element.kind === "number" && element.token.length === 2 && !next.has("digit")) {
      element.min = 1;
    }
    for (const kind of continuationOf(element)) {
      if (!next.has(kind)) continue;
      const following = elements[i + 1];
      const what = following?.kind === "literal"
        ? `"${following.text}"`
        : `\`${(following as { token: string }).token}\``;
      if (element.kind === "number") {
        return fail(
          `\`${element.token}\` is followed by a digit (${what}): give it two digits or a separator`,
        );
      }
      const token = (element as { token: string }).token;
      return fail(`\`${token}\` in ${locale} can run into what follows it (${what})`);
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
 * maybe seconds (`ss`) and a weekday (`EEE`, `EEEE`). A field of no fixed length (`M`, `d`, `H`,
 * `h`, a name) is followed by something that can't carry it on: `yyyy/dM` can't be read (`2026/211`
 * is November 2nd or January 21st), nor `dMMM` where month names are numbers (Chinese `11月`). Its
 * names, in the language, are distinct and Gregorian: Persian `MMM` changes within a month, so a
 * Persian pattern writes `MM`.
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

/** Every reading of the text, to the second one (one is enough to refuse it). */
function readings(input: string, c: Compiled): Read[] {
  const found: Read[] = [];
  const walk = (i: number, at: number, read: Read) => {
    if (found.length > 1) return;
    if (i === c.elements.length) {
      if (at === input.length) found.push(read);
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
 * pattern has spaces; letters in any case; a month or weekday name without its final dot; AM
 * and PM with or without dots (`p.m.`, `pm`); one digit where the pattern writes two and no digit
 * follows; the language's own digits (Arabic-Indic, Persian, Bengali…), one kind to a field;
 * invisible marks (right-to-left marks) anywhere; and seconds left out with the `:` before them,
 * when the pattern writes them (they're `:00`).
 *
 * `undefined` for text that isn't one real day and time in the pattern: February 30th, 25:00,
 * 13 PM, a two-digit year, a weekday that isn't the date's, seconds the pattern doesn't write,
 * text that could be two day-times. Every text is `undefined` when the pattern can't be read back
 * (`patternProblem` says why). Days are Gregorian, whatever the language's calendar: a Buddhist
 * year typed in Thai is read as that Gregorian year. The value has seconds (`YYYY-MM-DD HH:mm:ss`)
 * when the pattern writes them, and none when it doesn't.
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
  const values = new Set<string>();
  for (const read of readings(clean(text).trim(), c)) {
    const value = valueOf(read, c);
    if (value) values.add(value);
  }
  return values.size === 1 ? [...values][0] : undefined;
}

const patterns = new Map<string, string>();

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

/**
 * The pattern a language writes a day and a time in, as people type them: the language's order
 * and separators and its 12- or 24-hour clock, with a four-digit year, two-digit fields, the
 * Gregorian calendar, and seconds unless `seconds` is false. `MM/dd/yyyy hh:mm:ss a` in American
 * English, `dd/MM/yyyy HH:mm:ss` in Brazilian Portuguese, `yyyy/MM/dd HH:mm:ss` in Japanese,
 * `dd.MM.yyyy HH.mm.ss` in Finnish; Thai and Persian patterns write the Gregorian year too. Its
 * words are quoted (`MM'/'dd'/'yyyy hh':'mm':'ss' 'a`), with plain spaces. A language the runtime
 * doesn't know, or one whose own pattern can't be read back, gets `yyyy-MM-dd HH:mm:ss`.
 *
 * What `parseDayTime` reads with no pattern, and what `DateRangePicker` with `seconds` shows
 * without a `format` it can read back; `formatPattern(value, dayTimePattern(locale), locale)` writes
 * a value in it.
 */
export function dayTimePattern(locale = "en", seconds = true): string {
  const id = `${locale}\u0000${seconds}`;
  const made = patterns.get(id);
  if (made) return made;
  let pattern = seconds ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm";
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    const twelve = cycle === "h11" || cycle === "h12";
    const sample = new Date(Date.UTC(2026, 10, 2, 14, 30, 5));
    const common = { calendar: "gregory", numberingSystem: "latn", timeZone: "UTC" } as const;
    const lettered = (options: Intl.DateTimeFormatOptions) => {
      const parts = new Intl.DateTimeFormat(locale, { ...common, ...options }).formatToParts(
        sample,
      );
      const out = parts.map(({ type, value }) => {
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
    const whole = `${day} ${time}`;
    if (day && time && patternProblem(whole, locale) === undefined) pattern = whole;
  } catch {
    // A language the runtime doesn't know: the toolkit's own order.
  }
  patterns.set(id, pattern);
  return pattern;
}
