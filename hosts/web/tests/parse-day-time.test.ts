/**
 * Typed day-times read back: in the app's pattern (day and month in its order, a 24-hour or a
 * 12-hour clock, seconds or none) or the language's own short date and time, as the toolkit keeps
 * them (`YYYY-MM-DD HH:mm`, `…:ss` with seconds); impossible days and times refused; written back
 * by the same pattern; a day-time pattern's day alone; and the moment a day-time is in a zone.
 */
import process from "node:process";
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  dateOfDayTime,
  dayPatternOf,
  dayTimePattern,
  formatPattern,
  hasTime,
  parseDayTime,
  parsePattern,
} from "../toolkit/dates.ts";

test("a day-time in the app's pattern: day first or month first, 24 or 12 hours", () => {
  assertEquals(parseDayTime("16/11/2026 14:30", "dd/MM/yyyy HH:mm"), "2026-11-16 14:30");
  assertEquals(parseDayTime("11/16/2026 2:30 PM", "M/d/yyyy h:mm a"), "2026-11-16 14:30");
  assertEquals(parseDayTime("11/16/2026 2:30 pm", "MM/dd/yyyy hh:mm a"), "2026-11-16 14:30");
  // Midnight and noon on a 12-hour clock.
  assertEquals(parseDayTime("11/16/2026 12:05 AM", "M/d/yyyy h:mm a"), "2026-11-16 00:05");
  assertEquals(parseDayTime("11/16/2026 12:05 PM", "M/d/yyyy h:mm a"), "2026-11-16 12:05");
  // One digit or two; spaces as typed; a month by its name, in the language's words.
  assertEquals(parseDayTime("6/1/2026 9:05", "d/M/yyyy H:mm"), "2026-01-06 09:05");
  assertEquals(parseDayTime("  16/11/2026   14:30 ", "dd/MM/yyyy HH:mm"), "2026-11-16 14:30");
  assertEquals(
    parseDayTime("16 de novembro de 2026 às 14:30", "d 'de' MMMM 'de' yyyy 'às' HH:mm", "pt-BR"),
    "2026-11-16 14:30",
  );
  assertEquals(parseDayTime("Nov 16, 2026, 2:30 PM", "MMM d, yyyy, h:mm a"), "2026-11-16 14:30");
});

test("seconds: kept when typed, `:00` when the pattern writes them and they weren't typed", () => {
  assertEquals(parseDayTime("16/11/2026 14:30:05", "dd/MM/yyyy HH:mm:ss"), "2026-11-16 14:30:05");
  assertEquals(parseDayTime("16/11/2026 14:30", "dd/MM/yyyy HH:mm:ss"), "2026-11-16 14:30:00");
  // Typed where the pattern has none: kept, not refused.
  assertEquals(parseDayTime("16/11/2026 14:30:05", "dd/MM/yyyy HH:mm"), "2026-11-16 14:30:05");
  assertEquals(
    parseDayTime("11/16/2026 11:59:59 PM", "MM/dd/yyyy hh:mm:ss a"),
    "2026-11-16 23:59:59",
  );
});

test("edge days: February 29th in a leap year only, a month's last day and no later", () => {
  assertEquals(parseDayTime("29/02/2024 23:59:59", "dd/MM/yyyy HH:mm:ss"), "2024-02-29 23:59:59");
  assertEquals(parseDayTime("29/02/2026 10:00", "dd/MM/yyyy HH:mm"), undefined);
  assertEquals(parseDayTime("30/04/2026 10:00", "dd/MM/yyyy HH:mm"), "2026-04-30 10:00");
  assertEquals(parseDayTime("31/04/2026 10:00", "dd/MM/yyyy HH:mm"), undefined);
  assertEquals(parseDayTime("31/12/2026 23:59", "dd/MM/yyyy HH:mm"), "2026-12-31 23:59");
  assertEquals(parseDayTime("01/01/2027 00:00", "dd/MM/yyyy HH:mm"), "2027-01-01 00:00");
});

test("what isn't a day and a time is refused", () => {
  const pattern = "dd/MM/yyyy HH:mm:ss";
  for (
    const wrong of [
      "",
      "hello",
      "16/11/2026", // no time
      "16/13/2026 10:00", // no 13th month
      "00/11/2026 10:00",
      "16/11/2026 24:00",
      "16/11/2026 10:60",
      "16/11/2026 10:00:60",
      "16/11/2026 10:00:05 extra",
      "2026-11-16 10:00", // not the app's pattern
    ]
  ) {
    assertEquals(parseDayTime(wrong, pattern), undefined, wrong);
  }
  // A 12-hour clock has no 13 o'clock, nor 0, and needs to know AM from PM when it says so.
  assertEquals(parseDayTime("11/16/2026 13:05 PM", "M/d/yyyy h:mm a"), undefined);
  assertEquals(parseDayTime("11/16/2026 0:05 AM", "M/d/yyyy h:mm a"), undefined);
  assertEquals(parseDayTime("11/16/2026 1:05 XM", "M/d/yyyy h:mm a"), undefined);
});

test("with no pattern: the language's own short date and time, or a day-time as kept", () => {
  assertEquals(parseDayTime("11/16/2026, 2:30 PM", undefined, "en-US"), "2026-11-16 14:30");
  assertEquals(parseDayTime("11/16/26 2:30:05 PM", undefined, "en-US"), "2026-11-16 14:30:05");
  assertEquals(parseDayTime("16/11/2026 14:30", undefined, "pt-BR"), "2026-11-16 14:30");
  assertEquals(parseDayTime("16/11/2026, 14:30:05", undefined, "pt-BR"), "2026-11-16 14:30:05");
  assertEquals(parseDayTime("31/11/2026 14:30", undefined, "pt-BR"), undefined);
  assertEquals(parseDayTime("2026-11-16 14:30"), "2026-11-16 14:30");
  assertEquals(parseDayTime("2026-11-16T14:30:05"), "2026-11-16 14:30:05");
  // Its words as they are, less quotes; some runtimes put a narrow space before AM and PM.
  const plain = (pattern: string) => pattern.replaceAll("'", "").replace(/\s/g, " ");
  assertEquals(plain(dayTimePattern("pt-BR")), "dd/MM/yyyy, HH:mm:ss");
  assertEquals(plain(dayTimePattern("en-US")), "M/d/yy, h:mm:ss a");
  assertEquals(dayTimePattern("not a language!"), dayTimePattern("en"));
});

test("read back, then written by the same pattern, it's the same text", () => {
  for (
    const [text, pattern, locale] of [
      ["16/11/2026 14:30:05", "dd/MM/yyyy HH:mm:ss", "pt-BR"],
      ["11/16/2026 02:30:05 PM", "MM/dd/yyyy hh:mm:ss a", "en-US"],
      ["29/02/2024 00:00", "dd/MM/yyyy HH:mm", "pt-BR"],
      ["16 nov 2026 09:05", "d MMM yyyy HH:mm", "en"],
    ]
  ) {
    const value = parseDayTime(text, pattern, locale);
    assertEquals(formatPattern(value!, pattern, locale).toLowerCase(), text.toLowerCase(), text);
  }
});

test("a day-time pattern's day alone, and which patterns write a time", () => {
  assertEquals(dayPatternOf("dd/MM/yyyy HH:mm:ss"), "dd/MM/yyyy");
  assertEquals(dayPatternOf("M/d/yyyy, h:mm a"), "M/d/yyyy");
  assertEquals(dayPatternOf("d 'de' MMMM 'às' HH:mm"), "d 'de' MMMM");
  assertEquals(dayPatternOf("HH:mm, dd/MM/yyyy"), "dd/MM/yyyy");
  assertEquals(dayPatternOf("dd/MM/yyyy"), "dd/MM/yyyy");
  assertEquals(hasTime("dd/MM/yyyy HH:mm"), true);
  assertEquals(hasTime("d 'at' MMMM"), false);
  // A day's reader still reads days only.
  assertEquals(parsePattern("16/11/2026", "dd/MM/yyyy"), "2026-11-16");
  assertEquals(parsePattern("16/11/2026 10:00", "dd/MM/yyyy HH:mm"), undefined);
});

test("the moment a day-time is in the app's time zone, as a Date", () => {
  const at = (value: string, zone?: string) => dateOfDayTime(value, zone)?.toISOString();
  assertEquals(at("2026-11-16 14:30", "America/Sao_Paulo"), "2026-11-16T17:30:00.000Z");
  assertEquals(at("2026-11-16 14:30:05", "UTC"), "2026-11-16T14:30:05.000Z");
  assertEquals(at("2026-11-16", "Asia/Tokyo"), "2026-11-15T15:00:00.000Z");
  // Summer time and winter time in one zone.
  assertEquals(at("2026-07-01 12:00", "America/New_York"), "2026-07-01T16:00:00.000Z");
  assertEquals(at("2026-01-15 12:00", "America/New_York"), "2026-01-15T17:00:00.000Z");
  assertEquals(at("2026-03-08 03:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  assertEquals(dateOfDayTime("2026-02-30 10:00", "UTC"), undefined);
  assertEquals(dateOfDayTime("soon"), undefined);
});

test("a skipped local time moves forward by the gap and a repeated time uses its earlier instant", () => {
  const at = (value: string, zone: string) => dateOfDayTime(value, zone)?.toISOString();
  assertEquals(at("2026-03-08 02:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  assertEquals(at("2026-11-01 01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assertEquals(at("2026-10-04 02:15", "Australia/Lord_Howe"), "2026-10-03T15:45:00.000Z");
  assertEquals(at("2026-04-05 01:45", "Australia/Lord_Howe"), "2026-04-04T14:45:00.000Z");
  assertEquals(at("2011-12-30 12:00", "Pacific/Apia"), "2011-12-30T22:00:00.000Z");
  assertEquals(at("0000-01-01", "UTC"), "0000-01-01T00:00:00.000Z");
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    for (const local of ["2026-03-08 02:30", "2026-11-01 01:30"]) {
      assertEquals(dateOfDayTime(local)?.toISOString(), at(local, "America/New_York"));
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("Japanese numeric month names round trip through a custom pattern", () => {
  const value = "2026-11-16 14:30";
  const by = "d MMM yyyy HH:mm";
  assertEquals(parseDayTime(formatPattern(value, by, "ja-JP"), by, "ja-JP"), value);
});

test("Arabic short date and time including locale digits round trips", () => {
  for (const locale of ["ar-EG", "ar-EG-u-nu-arab"]) {
    const text = new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date("2026-11-16T14:30:05Z"));
    assertEquals(parseDayTime(text, undefined, locale), "2026-11-16 14:30:05");
  }
});
