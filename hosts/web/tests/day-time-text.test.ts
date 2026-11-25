/**
 * Typed day-times read back: a pattern that passes `patternProblem` reads every text
 * `formatPattern` writes with it as the value it was written from, in every language, with the
 * allowances people need (case, spaces, the language's digits, marks, seconds left out); a pattern
 * that could write two values alike, or drop the century, reads nothing; impossible days and times
 * are refused; and each language's own pattern is Gregorian, with a four-digit year.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { formatPattern, lastOfMonth } from "../toolkit/dates.ts";
import { dayTimePattern, parseDayTime, patternProblem } from "../toolkit/day-time-text.ts";

const LOCALES = [
  "en-US",
  "en-GB",
  "de-DE",
  "fr-FR",
  "pt-BR",
  "es-MX",
  "ja-JP",
  "zh-CN",
  "zh-TW",
  "ko-KR",
  "ar-EG",
  "fa-IR",
  "th-TH",
  "hi-IN",
  "fi-FI",
  "el-GR",
  "he-IL",
  "bn-BD",
];

const PATTERNS = [
  "dd/MM/yyyy HH:mm:ss",
  "M/d/yyyy h:mm a",
  "MM/dd/yyyy hh:mm:ss a",
  "yyyyMMdd HHmmss",
  "dd.MM.yyyy H.mm",
  "yyyy-MM-dd'T'HH:mm:ss",
  "d MMM yyyy HH:mm",
  "EEE, d MMM yyyy h:mm:ss a",
  "EEEE d MMMM yyyy, HH:mm:ss",
  "d 'de' MMMM 'de' yyyy 'às' HH:mm",
  "'lot,  1' dd/MM/yyyy HH:mm",
  "'الدفعة ١' d/M/yyyy HH:mm:ss",
];

/** Patterns of numbers alone: every language reads them back. */
const NUMERIC = PATTERNS.filter((p) => !/MMM|EEE/.test(p));

const two = (n: number) => String(n).padStart(2, "0");
const wallOf = (at: Date) => at.toISOString().slice(0, 19).replace("T", " ");

/**
 * The values: walls stepped through 2024–2027 at an uneven interval, and the edges: February
 * 29th, month ends, the year's end, midnight and noon (AM and PM's), the first and last years,
 * 1999 (a two-digit year's trap), and the walls where clocks change in New York, London, São
 * Paulo and Lord Howe.
 */
const VALUES: string[] = [];
for (
  let at = Date.UTC(2024, 0, 1);
  at < Date.UTC(2028, 0, 1);
  at += (79 * 3600 + 13 * 60 + 17) * 1e3
) {
  VALUES.push(wallOf(new Date(at)));
}
for (let month = 1; month <= 12; month++) {
  const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  VALUES.push(`2026-${two(month)}-${two(last)} 23:59:59`);
}
VALUES.push(
  "2024-02-29 00:00:00",
  "2024-02-29 12:00:00",
  "2024-02-29 23:59:59",
  "2026-03-01 00:00:00",
  "2027-01-01 00:00:00",
  "2026-11-02 00:00:00",
  "2026-11-02 00:59:59",
  "2026-11-02 11:59:59",
  "2026-11-02 12:00:00",
  "2026-11-02 12:59:59",
  "0000-01-01 00:00:00",
  "0001-01-01 00:00:00",
  "9999-12-31 23:59:59",
  "1999-11-02 14:30:00",
  "2026-03-08 01:59:59",
  "2026-03-08 02:30:00",
  "2026-03-08 03:00:00",
  "2026-11-01 01:30:00",
  "2026-03-29 01:30:00",
  "2018-11-04 00:00:00",
  "2026-10-04 02:15:00",
  "2026-04-05 01:45:00",
);

/** A value as a pattern keeps it: to the minute when it writes no seconds. */
const kept = (value: string, pattern: string) =>
  /ss/.test(pattern.replace(/'[^']*'/g, "")) ? value : value.slice(0, 16);

/** The language's own digits, 0 to 9. */
const digitsOf = (locale: string) => {
  const format = new Intl.NumberFormat(locale, { useGrouping: false });
  return Array.from({ length: 10 }, (_, n) => format.format(n));
};

/** The ways people's text differs from the pattern's, each still the same value. */
function variants(text: string, pattern: string, locale: string): [string, string][] {
  const out: [string, string][] = [["as written", text]];
  if (text.toUpperCase().toLowerCase() === text.toLowerCase()) {
    out.push(["upper case", text.toUpperCase()], ["lower case", text.toLowerCase()]);
  }
  const digits = digitsOf(locale);
  // ASCII digits are the fields' (quoted digits are the pattern's own, and stay).
  if (digits[0] !== "0" && !/'[^']*[0-9][^']*'/.test(pattern)) {
    out.push(["the language's digits", text.replace(/[0-9]/g, (d) => digits[+d])]);
  }
  if (/\s/.test(text)) {
    out.push(
      ["no-break spaces", text.replace(/\s/g, " ")],
      ["narrow no-break spaces", text.replace(/\s/g, " ")],
      ["doubled spaces", text.replace(/\s/g, "  ")],
    );
  }
  out.push(["right-to-left marks", text.replace(/([/.:-])/g, "‏$1‏")]);
  return out;
}

for (const locale of LOCALES) {
  test(`round trip in ${locale}: what a pattern writes reads back as the value`, () => {
    const patterns = [...PATTERNS, dayTimePattern(locale), dayTimePattern(locale, false)];
    const readable = patterns.filter((p) => patternProblem(p, locale) === undefined);
    // Every pattern of numbers, and the language's own, can be read back.
    for (const p of [...NUMERIC, dayTimePattern(locale), dayTimePattern(locale, false)]) {
      assert(readable.includes(p), `${p}: ${patternProblem(p, locale)}`);
    }
    for (const pattern of readable) {
      for (const value of VALUES) {
        const x = kept(value, pattern);
        const text = formatPattern(x, pattern, locale);
        for (const [how, typed] of variants(text, pattern, locale)) {
          assertEquals(parseDayTime(typed, pattern, locale), x, `${pattern}, ${how}: ${typed}`);
        }
      }
      // Seconds left out with their separator are :00.
      const cut = pattern.match(/^(.*?)(?:'[:.]'|[:.])ss(.*)$/);
      if (cut) {
        const x = "2026-11-02 14:30:00";
        const typed = formatPattern(x, cut[1] + cut[2], locale);
        assertEquals(parseDayTime(typed, pattern, locale), x, `${pattern} without seconds`);
      }
    }
  });
}

test("with no pattern, the language's own: Gregorian, a four-digit year, its clock", () => {
  const at = "2026-11-02 14:30:05";
  const shown = (locale: string) => formatPattern(at, dayTimePattern(locale), locale);
  assertEquals(dayTimePattern("en-US"), "MM'/'dd'/'yyyy hh':'mm':'ss' 'a");
  assertEquals(shown("en-US"), "11/02/2026 02:30:05 PM");
  assertEquals(dayTimePattern("en-US", false), "MM'/'dd'/'yyyy hh':'mm' 'a");
  assertEquals(shown("pt-BR"), "02/11/2026 14:30:05");
  assertEquals(shown("ja-JP"), "2026/11/02 14:30:05");
  assertEquals(shown("de-DE"), "02.11.2026 14:30:05");
  // A Buddhist and a Persian language still write the Gregorian year.
  assertEquals(shown("th-TH"), "02/11/2026 14:30:05");
  assertEquals(shown("fa-IR"), "2026/11/02 14:30:05");
  assertEquals(dayTimePattern("not a language!"), "yyyy-MM-dd HH:mm:ss");
  assertEquals(parseDayTime("11/02/2026 02:30:05 PM"), at);
  assertEquals(parseDayTime("11/02/2026 02:30 PM", undefined, "en-US"), "2026-11-02 14:30:00");
  assertEquals(parseDayTime("2/11/2026 14:30:05", undefined, "pt-BR"), at);
  assertEquals(parseDayTime("2026-11-02 14:30:05", undefined, "not a language!"), at);
});

test("every language's own pattern can be read back", () => {
  const locales = [
    "en",
    "en-CA",
    "en-AU",
    "en-IN",
    "fr-CA",
    "es-ES",
    "it-IT",
    "nl-NL",
    "sv-SE",
    "da-DK",
    "nb-NO",
    "pl-PL",
    "cs-CZ",
    "hu-HU",
    "ro-RO",
    "ru-RU",
    "uk-UA",
    "tr-TR",
    "ar-SA",
    "ur-PK",
    "vi-VN",
    "id-ID",
    "ms-MY",
    "zh-HK",
    "pt-PT",
    "bg-BG",
    "lt-LT",
    "lv-LV",
    "et-EE",
    "sk-SK",
    "sr-RS",
    "hr-HR",
    "ka-GE",
    "hy-AM",
    "kk-KZ",
    "am-ET",
    "sw-KE",
    "my-MM",
    "km-KH",
    "mn-MN",
    "ne-NP",
    "si-LK",
    "ar-EG-u-nu-arab",
    "th-TH-u-nu-thai",
    "ja-JP-u-ca-japanese",
    ...LOCALES,
  ];
  for (const locale of locales) {
    for (const seconds of [true, false]) {
      const pattern = dayTimePattern(locale, seconds);
      assertEquals(patternProblem(pattern, locale), undefined, `${locale}: ${pattern}`);
      assertMatch(pattern, /yyyy/);
      for (const value of VALUES.slice(0, 120)) {
        const x = kept(value, pattern);
        assertEquals(parseDayTime(formatPattern(x, pattern, locale), pattern, locale), x, locale);
      }
    }
  }
});

test("patterns that can't be read back say why, and read nothing", () => {
  const cases: [string, string, RegExp][] = [
    ["yyyy/dM HH:mm:ss", "en", /digit/],
    ["yyMMdd HH:mm", "en", /yy/],
    ["M/d/yy, h:mm a", "en-US", /yy/],
    ["yyyy/dMMM HH:mm", "zh-CN", /MMM/],
    ["yyyy/dMMM HH:mm", "ko-KR", /MMM/],
    ["yyyyMMMd HH:mm", "ja-JP", /MMM/],
    ["d MMM yyyy HH:mm", "fa-IR", /MMM/],
    ["dd/MM/yyyy Hmm", "en", /digit/],
    ["h:mm dd/MM/yyyy", "en", /`a`/],
    ["dd/MM/yyyy HH:mm a", "en", /`a`/],
    ["dd/MM/yyyy", "en", /hour/],
    ["dd/MM HH:mm", "en", /year/],
    ["dd/yyyy HH:mm", "en", /month/],
    ["MM/yyyy HH:mm", "en", /day/],
    ["dd/MM/yyyy HH", "en", /minute/],
    ["dd/MM/yyyy dd HH:mm", "en", /twice/],
    ["d MMM yyyy HH:mm", "not a language!", /language/],
  ];
  for (const [pattern, locale, why] of cases) {
    const problem = patternProblem(pattern, locale);
    assert(problem !== undefined, `${pattern} in ${locale} has a problem`);
    assertMatch(problem, why, pattern);
    for (const value of ["2026-11-02 14:30:05", "2026-01-21 14:30:05", "2026-01-12 14:30:05"]) {
      const text = formatPattern(value, pattern, locale === "not a language!" ? "en" : locale);
      assertEquals(parseDayTime(text, pattern, locale), undefined, `${pattern}: ${text}`);
    }
  }
  // The texts rc.64 read as other days.
  assertEquals(parseDayTime("2026/211 14:30:05", "yyyy/dM HH:mm:ss"), undefined);
  assertEquals(parseDayTime("2026/211月 14:30", "yyyy/dMMM HH:mm", "zh-CN"), undefined);
  assertEquals(parseDayTime("2026112 14:30", "yyyyMMMd HH:mm", "ja-JP"), undefined);
});

test("what isn't one real day and time is refused, never moved to another", () => {
  const pattern = "dd/MM/yyyy HH:mm:ss";
  for (
    const wrong of [
      "",
      "soon",
      "31/02/2026 10:00:00",
      "29/02/2026 10:00:00",
      "31/04/2026 10:00:00",
      "00/11/2026 10:00:00",
      "16/13/2026 10:00:00",
      "16/00/2026 10:00:00",
      "16/11/2026 24:00:00",
      "16/11/2026 10:60:00",
      "16/11/2026 10:00:60",
      "16/11/2026",
      "16/11/26 10:00:00",
      "16/11/02026 10:00:00",
      "16/11/2026 10:00:00 extra",
      "16/11/2026T10:00:00",
      "16/11/2026  10:00:00:00",
      "1６/11/2026 10:00:00",
      "١6/11/2026 10:00:00",
    ]
  ) {
    assertEquals(parseDayTime(wrong, pattern, "ar-EG"), undefined, wrong);
  }
  assertEquals(parseDayTime("29/02/2024 23:59:59", pattern), "2024-02-29 23:59:59");
  // A 12-hour clock has no 13 or 0 o'clock, and needs its AM or PM.
  const twelve = "M/d/yyyy h:mm a";
  assertEquals(parseDayTime("11/16/2026 13:05 PM", twelve), undefined);
  assertEquals(parseDayTime("11/16/2026 0:05 AM", twelve), undefined);
  assertEquals(parseDayTime("11/16/2026 1:05 XM", twelve), undefined);
  assertEquals(parseDayTime("11/16/2026 1:05", twelve), undefined);
  assertEquals(parseDayTime("11/16/2026 12:05 AM", twelve), "2026-11-16 00:05");
  assertEquals(parseDayTime("11/16/2026 12:05 p.m.", twelve), "2026-11-16 12:05");
  // The century isn't guessed: two digits in a four-digit year are refused.
  assertEquals(parseDayTime("11/2/99, 2:30 PM", "M/d/yyyy, h:mm a", "en-US"), undefined);
  assertEquals(parseDayTime("11/2/99, 2:30 PM", undefined, "en-US"), undefined);
  assertEquals(parseDayTime("11/2/1999, 2:30 PM", "M/d/yyyy, h:mm a"), "1999-11-02 14:30");
  // A weekday must be the date's: November 2nd, 2026 is a Monday.
  const named = "EEE, d MMM yyyy HH:mm";
  assertEquals(parseDayTime("Mon, 2 Nov 2026 14:30", named), "2026-11-02 14:30");
  assertEquals(parseDayTime("Tue, 2 Nov 2026 14:30", named), undefined);
  // Seconds the pattern doesn't write are refused: it couldn't show them.
  assertEquals(parseDayTime("16/11/2026 10:00:05", "dd/MM/yyyy HH:mm"), undefined);
});

test("names: the language's, in any case, a final dot optional, digits and all", () => {
  for (const locale of ["fr-FR", "pt-BR"]) {
    for (const text of ["16 nov. 2026 14:30", "16 nov 2026 14:30", "16 NOV. 2026 14:30"]) {
      assertEquals(parseDayTime(text, "d MMM yyyy HH:mm", locale), "2026-11-16 14:30", text);
    }
  }
  // Japanese short months are numbers: read where a space keeps them apart.
  const ja = formatPattern("2026-11-16 14:30", "d MMM yyyy HH:mm", "ja-JP");
  assertEquals(parseDayTime(ja, "d MMM yyyy HH:mm", "ja-JP"), "2026-11-16 14:30");
  assertEquals(parseDayTime("2 11月 2026 14:30", "d MMM yyyy HH:mm", "zh-CN"), "2026-11-02 14:30");
  assertEquals(
    parseDayTime("16 de novembro de 2026 às 14:30", "d 'de' MMMM 'de' yyyy 'às' HH:mm", "pt-BR"),
    "2026-11-16 14:30",
  );
  assertEquals(parseDayTime("16 xyz 2026 14:30", "d MMM yyyy HH:mm"), undefined);
});

test("literals are as written: only their spaces are free", () => {
  const lot = "'lot,  1' dd/MM/yyyy HH:mm";
  assertEquals(parseDayTime("lot,  1 01/02/2026 13:45", lot), "2026-02-01 13:45");
  assertEquals(parseDayTime("lot, 1 01/02/2026 13:45", lot), "2026-02-01 13:45");
  assertEquals(parseDayTime("LOT,\t1 01/02/2026 13:45", lot), "2026-02-01 13:45");
  assertEquals(parseDayTime("lot1 01/02/2026 13:45", lot), undefined);
  assertEquals(parseDayTime("lot  1 01/02/2026 13:45", lot), undefined);
  const batch = "'الدفعة ١' d/M/yyyy HH:mm:ss";
  const value = "2026-11-16 14:30:05";
  assertEquals(parseDayTime("الدفعة ١ ١٦/١١/٢٠٢٦ ١٤:٣٠:٠٥", batch, "ar-EG"), value);
  assertEquals(parseDayTime("الدفعة ١ 16/11/2026 14:30:05", batch, "ar-EG"), value);
  assertEquals(parseDayTime("الدفعة 1 16/11/2026 14:30:05", batch, "ar-EG"), undefined);
  // Spaces where the pattern has none are refused.
  assertEquals(parseDayTime("16/11/2026 14: 30", "dd/MM/yyyy HH:mm"), undefined);
});

test("one digit where two are written, when a separator follows; never across fields", () => {
  assertEquals(parseDayTime("6/1/2026 9:05:07", "dd/MM/yyyy HH:mm:ss"), "2026-01-06 09:05:07");
  assertEquals(parseDayTime("20261102 143005", "yyyyMMdd HHmmss"), "2026-11-02 14:30:05");
  // `MM` is followed by digits, so it takes two; `dd` is followed by a space, so one will do.
  assertEquals(parseDayTime("2026112 143005", "yyyyMMdd HHmmss"), "2026-11-02 14:30:05");
  assertEquals(parseDayTime("202611 143005", "yyyyMMdd HHmmss"), undefined);
  assertEquals(parseDayTime("2026/2/28 14:30", "yyyy/M/d HH:mm"), "2026-02-28 14:30");
});

test("the toolkit guide's examples, as written there", () => {
  assertEquals(parseDayTime("02/11/2026 14:30:05", "dd/MM/yyyy HH:mm:ss"), "2026-11-02 14:30:05");
  assertEquals(parseDayTime("11/2/2026 2:30 PM", "M/d/yyyy h:mm a"), "2026-11-02 14:30");
  assertEquals(parseDayTime("02/11/2026 14:30", "dd/MM/yyyy HH:mm:ss"), "2026-11-02 14:30:00");
  assertEquals(parseDayTime("31/02/2026 10:00", "dd/MM/yyyy HH:mm"), undefined);
  assertEquals(parseDayTime("11/2/99, 2:30 PM", "M/d/yyyy, h:mm a"), undefined);
  assertEquals(
    parseDayTime("2 MAYIS 2026 10:00", "d MMMM yyyy HH:mm", "tr-TR"),
    "2026-05-02 10:00",
  );
  assertEquals(
    patternProblem("yyyy/dM HH:mm"),
    "`d` is followed by a digit (`M`): give it two digits or a separator",
  );
  assertEquals(patternProblem("dd/MM/yy HH:mm"), "`yy` leaves out the century: write `yyyy`");
  const typed = dayTimePattern("en-US");
  assertEquals(typed, "MM'/'dd'/'yyyy hh':'mm':'ss' 'a");
  assertEquals(formatPattern("2026-11-02 14:30:05", typed, "en-US"), "11/02/2026 02:30:05 PM");
  assertEquals(parseDayTime("11/02/2026 2:30:05 pm", typed, "en-US"), "2026-11-02 14:30:05");
  assertEquals(dayTimePattern("pt-BR"), "dd'/'MM'/'yyyy HH':'mm':'ss");
});

// Review round 1: each finding's case, then its class.

/** Whether the runtime's `Intl` supports a language (not only accepts its tag). */
const supports = (tag: string) => {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length === 1;
  } catch {
    return false;
  }
};

/** Every language the runtime supports, by its two- and three-letter codes. */
const SUPPORTED = (() => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const codes: string[] = [];
  for (const a of letters) {
    for (const b of letters) {
      codes.push(a + b);
      for (const c of letters) codes.push(a + b + c);
    }
  }
  return Intl.DateTimeFormat.supportedLocalesOf(codes);
})();

/** Each calendar the runtime has, in languages with names and with numbers for months. */
const CALENDARS = Intl.supportedValuesOf("calendar").flatMap((calendar) =>
  ["en", "th", "ja", "zh-TW"].map((language) => `${language}-u-ca-${calendar}`)
);

/**
 * Days whose month a calendar can get wrong: the first and last of every month in the first and
 * last supported years (0000, 9999), where a Julian calendar is days from the Gregorian (0000,
 * 1000), in 1582 and through its October's change, and now.
 */
const EDGES: string[] = [];
for (const year of [0, 1000, 1582, 2024, 9999]) {
  for (let month = 1; month <= 12; month++) {
    const last = +lastOfMonth(year, month).slice(8);
    for (const day of [1, last]) {
      const time = `${two((month * 7 + day) % 24)}:${two((day * 13) % 60)}:${
        two((month * 11) % 60)
      }`;
      EDGES.push(`${String(year).padStart(4, "0")}-${two(month)}-${two(day)} ${time}`);
    }
  }
}
for (let day = 1; day <= 31; day += 3) EDGES.push(`1582-10-${two(day)} 12:00:00`);

/** Patterns with month names, of every width. */
const NAMED = [
  "d MMM yyyy HH:mm:ss",
  "dd MMMM yyyy hh:mm a",
  "EEE d MMM yyyy H:mm",
  "EEEE, d 'de' MMMM 'de' yyyy HH:mm",
];

/** Text in the language's upper and lower case, as its people would type it. */
const cased = (text: string, locale: string): [string, string][] => [
  ["as written", text],
  ["upper case", text.toLocaleUpperCase(locale)],
  ["lower case", text.toLocaleLowerCase(locale)],
];

test("Thai month names: February 29th, 0000 isn't written as March 29th's", () => {
  const pattern = "d MMM yyyy HH:mm:ss";
  const problem = patternProblem(pattern, "th-TH");
  assert(problem !== undefined, "accepted");
  assertMatch(problem, /MMM/);
  for (const x of ["0000-02-29 00:00:00", "0000-03-29 00:00:00"]) {
    assertEquals(parseDayTime(formatPattern(x, pattern, "th-TH"), pattern, "th-TH"), undefined);
  }
  // Thai's Gregorian calendar keeps its months in every year.
  assertEquals(patternProblem(pattern, "th-TH-u-ca-gregory"), undefined);
});

test("every language and calendar the runtime has: an accepted pattern reads back, 0000 to 9999", () => {
  const all = [...SUPPORTED, ...CALENDARS];
  assert(all.length > 100, `${all.length} languages`);
  for (const locale of all) {
    const own = [dayTimePattern(locale), dayTimePattern(locale, false)];
    for (const pattern of own) {
      assertEquals(patternProblem(pattern, locale), undefined, `${locale}: ${pattern}`);
      assertMatch(pattern, /yyyy/);
    }
    for (const pattern of [...NAMED, ...own, "dd/MM/yyyy HH:mm:ss", "M/d/yyyy h:mm a"]) {
      if (patternProblem(pattern, locale) !== undefined) continue;
      // Names: every edge day as written, and a third of them in each case; numbers: a sample.
      const named = /MMM|EEE/.test(pattern);
      for (const [i, value] of EDGES.entries()) {
        if (!named && i % 9) continue;
        const x = kept(value, pattern);
        const texts = cased(formatPattern(x, pattern, locale), locale);
        for (const [how, typed] of i % 3 ? texts.slice(0, 1) : texts) {
          assertEquals(
            parseDayTime(typed, pattern, locale),
            x,
            `${locale} ${pattern}, ${how}: ${typed}`,
          );
        }
      }
    }
  }
});

test("names in the language's own case and punctuation: Greek, Turkish, Dzongkha, Tibetan", () => {
  const named = "d MMMM yyyy HH:mm";
  assertEquals(parseDayTime("2 ΜΑΪ́ΟΥ 2026 10:00", named, "el-GR"), "2026-05-02 10:00");
  assertEquals(parseDayTime("2 ΜΑΪΟΥ 2026 10:00", named, "el-GR"), "2026-05-02 10:00");
  assertEquals(parseDayTime("2 Μαΐου 2026 10:00", named, "el-GR"), "2026-05-02 10:00");
  assertEquals(parseDayTime("2 MAYIS 2026 10:00", named, "tr-TR"), "2026-05-02 10:00");
  assertEquals(parseDayTime("2 mayıs 2026 10:00", named, "tr-TR"), "2026-05-02 10:00");
  // Where the runtime has them (Node's ICU does; Deno's doesn't): AM and PM with their tsheg.
  for (const locale of ["dz", "dz-BT", "bo", "bo-CN"].filter(supports)) {
    for (const pattern of [dayTimePattern(locale), "dd/MM/yyyy hh:mm:ss a"]) {
      assertEquals(patternProblem(pattern, locale), undefined, `${locale}: ${pattern}`);
      for (const x of ["2026-11-02 14:30:05", "2026-11-02 02:30:05", "2026-11-02 12:00:00"]) {
        const text = formatPattern(x, pattern, locale);
        assertEquals(parseDayTime(text, pattern, locale), x, `${locale}: ${text}`);
      }
    }
  }
});

/** Patterns where a field of no fixed length meets a name or a word. */
const BOUNDARY = [
  "yyyy/dMMM HH:mm:ss",
  "yyyy/MMMd HH:mm",
  "dMMM yyyy HH:mm",
  "yyyyMMMd HH:mm",
  "d'日'MMM yyyy HH:mm",
  "EEEd MMM yyyy HH:mm",
  "MMMd, yyyy h:mm a",
  "yyyy/M/d H:mm",
];

/** A text's number fields in the language's digits; its names as the language writes them. */
function inOwnDigits(text: string, x: string, pattern: string, locale: string, digits: string[]) {
  const tokens = pattern.replace(/'[^']*'/g, "").match(/MMMM|MMM|MM|M|EEEE|EEE|a/g) ?? [];
  const names = tokens.filter((t) => /^(MMMM?|EEEE?|a)$/.test(t))
    .map((t) => formatPattern(x, t, locale).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = names.length ? text.split(new RegExp(`(${names.join("|")})`, "u")) : [text];
  return parts.map((part, i) => i % 2 ? part : part.replace(/[0-9]/g, (d) => digits[+d])).join("");
}

test("a language's own digits are digits where a field could run on: every numbering system", () => {
  assert(patternProblem("yyyy/dMMM HH:mm:ss", "ja-JP-u-nu-hanidec") !== undefined, "hanidec");
  const days: string[] = [];
  for (const month of [1, 2, 10, 11, 12]) {
    const last = +lastOfMonth(2024, month).slice(8);
    for (const day of [1, 2, 3, 10, 11, 12, 13, 19, 20, 21, 22, 28, 29, 30, 31]) {
      if (day <= last) days.push(`2024-${two(month)}-${two(day)} 10:07:09`);
    }
  }
  let read = 0;
  for (const system of Intl.supportedValuesOf("numberingSystem")) {
    for (const base of ["ja-JP", "zh-CN"]) {
      const locale = `${base}-u-nu-${system}`;
      const digits = digitsOf(locale);
      const own = new Set(digits).size === 10 && digits.every((d) => [...d].length === 1) &&
        digits[0] !== "0";
      for (const pattern of BOUNDARY) {
        if (patternProblem(pattern, locale) !== undefined) continue;
        for (const value of days) {
          const x = kept(value, pattern);
          const text = formatPattern(x, pattern, locale);
          const texts = own ? [text, inOwnDigits(text, x, pattern, locale, digits)] : [text];
          for (const typed of texts) {
            assertEquals(parseDayTime(typed, pattern, locale), x, `${locale} ${pattern}: ${typed}`);
            read++;
          }
        }
      }
    }
  }
  assert(read > 1_000, `${read} texts read`);
});

test("spaces at a pattern's edges, or doubled, read as the input's do", () => {
  // The review's case: a trailing space, and day before month.
  const p = "yyyy-dd-MM HH:mm:ss ";
  const x = "2026-11-02 09:00:07";
  assertEquals(formatPattern(x, p), "2026-02-11 09:00:07 ");
  assertEquals(parseDayTime(formatPattern(x, p), p), x);
  for (const locale of ["en-US", "de-DE", "ja-JP", "ar-EG"]) {
    for (const base of [...PATTERNS, dayTimePattern(locale), "yyyy-dd-MM HH:mm:ss"]) {
      const readable = patternProblem(base, locale) === undefined;
      const variants = [
        ` ${base}`,
        `${base} `,
        `  ${base}  `,
        `\t${base} `,
        base.replace(/\s+/g, (s) => s + s),
        `' '${base}' '`,
      ];
      for (const variant of variants) {
        const name = `${JSON.stringify(variant)} in ${locale}`;
        assertEquals(patternProblem(variant, locale) === undefined, readable, name);
        if (!readable) continue;
        for (const value of VALUES.filter((_, i) => i % 13 === 0)) {
          const x = kept(value, base);
          assertEquals(parseDayTime(formatPattern(x, variant, locale), variant, locale), x, name);
          assertEquals(parseDayTime(formatPattern(x, base, locale), variant, locale), x, name);
          assertEquals(parseDayTime(formatPattern(x, variant, locale), base, locale), x, name);
        }
      }
    }
  }
});

test("a language the runtime doesn't support gets the toolkit's own pattern", () => {
  assertEquals(dayTimePattern("zz-ZZ"), "yyyy-MM-dd HH:mm:ss");
  assertEquals(dayTimePattern("zz-ZZ", false), "yyyy-MM-dd HH:mm");
  const tags = ["zz-ZZ", "qaa", "xx", "en-ZZ", "dz", "bo", "haw", "en", "pt-BR", "not a language!"];
  for (const tag of tags) {
    const own = dayTimePattern(tag);
    assertEquals(patternProblem(own, tag), undefined, tag);
    if (!supports(tag)) {
      assertEquals(own, "yyyy-MM-dd HH:mm:ss", tag);
      assertMatch(patternProblem("d MMM yyyy HH:mm", tag)!, /language/, tag);
      assertEquals(parseDayTime("2026-11-02 14:30:05", undefined, tag), "2026-11-02 14:30:05");
    }
  }
});

test("years are four digits, 0000 (1 BC) to 9999, and no others", () => {
  const p = "dd/MM/yyyy HH:mm:ss";
  assertEquals(parseDayTime("01/01/0000 00:00:00", p), "0000-01-01 00:00:00");
  assertEquals(parseDayTime("29/02/0000 12:00:00", p), "0000-02-29 12:00:00");
  assertEquals(parseDayTime("31/12/9999 23:59:59", p), "9999-12-31 23:59:59");
  for (const wrong of ["01/01/10000 00:00:00", "01/01/-001 00:00:00", "01/01/+2026 00:00:00"]) {
    assertEquals(parseDayTime(wrong, p), undefined, wrong);
  }
});
