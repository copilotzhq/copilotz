/**
 * Days as the date pieces count them: moving by days and months (a month on from January 31 is
 * February's last day), a month's weeks from any week start, the app's today in its time zone,
 * patterns in the page's language, and the standard ranges, fiscal years included.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  addDays,
  addMonth,
  addMonths,
  clampRange,
  formatPattern,
  isDay,
  monthsBetween,
  monthWeeks,
  type Preset,
  presetRange,
  showsSeconds,
  todayIn,
  weekOf,
} from "../toolkit/dates.ts";

test("days: real ones only, and moving by days over months and years", () => {
  assert(isDay("2024-02-29"));
  assert(!isDay("2026-02-29"));
  assert(!isDay("2026-11-16T10:00"));
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  assertEquals(addDays("0099-12-31", 1), "0100-01-01");
});

test("months: the same day kept in its month, and months apart", () => {
  assertEquals(addMonths("2026-01-31", 1), "2026-02-28");
  assertEquals(addMonths("2024-01-31", 1), "2024-02-29");
  assertEquals(addMonths("2026-03-31", -1), "2026-02-28");
  assertEquals(addMonths("2028-02-29", -12), "2027-02-28");
  assertEquals(addMonth("2026-12", 1), "2027-01");
  assertEquals(addMonth("2026-01", -1), "2025-12");
  assertEquals(monthsBetween("2025-11-30", "2026-01-01"), 2);
});

test("a month's weeks: six of seven days, from the week's first day", () => {
  const sunday = monthWeeks("2026-11", 0);
  assertEquals(sunday.length, 6);
  assert(sunday.every((week) => week.length === 7));
  assertEquals(sunday[0][0], "2026-11-01"); // a Sunday
  assertEquals(sunday[5][6], "2026-12-12");
  assertEquals(monthWeeks("2026-11", 1)[0][0], "2026-10-26"); // the Monday before
  assertEquals(weekOf("2026-11-18", 1), { start: "2026-11-16", end: "2026-11-22" });
});

test("today is the app's, in its time zone, not the page's", () => {
  const now = new Date("2026-11-17T01:30:00Z");
  assertEquals(todayIn("America/Sao_Paulo", now), "2026-11-16");
  assertEquals(todayIn("Asia/Tokyo", now), "2026-11-17");
  assertEquals(todayIn("UTC", now), "2026-11-17");
});

test("patterns: the app's format, names in the page's language, quoted words as they are", () => {
  assertEquals(formatPattern("2026-11-06", "dd/MM/yyyy"), "06/11/2026");
  assertEquals(formatPattern("2026-11-06", "M/d/yy"), "11/6/26");
  assertEquals(formatPattern("2026-11-16", "MMM d, yyyy"), "Nov 16, 2026");
  assertEquals(formatPattern("2026-11-16", "EEEE, MMMM d"), "Monday, November 16");
  assertEquals(
    formatPattern("2026-11-16", "d 'de' MMMM 'de' yyyy", "pt-BR"),
    "16 de novembro de 2026",
  );
  const moment = { year: 2026, month: 11, day: 16, hour: 21, minute: 5, second: 7 };
  assertEquals(formatPattern(moment, "HH:mm:ss"), "21:05:07");
  assertEquals(formatPattern(moment, "h:mm a"), "9:05 PM");
  assertEquals(formatPattern("2026-11-16 08:30:00", "hh:mm"), "08:30");
  assert(showsSeconds("HH:mm:ss"));
  assert(!showsSeconds("HH:mm 'ss'"));
});

test("the standard ranges, for a today: months and years whole", () => {
  const today = "2026-11-16";
  const at = (preset: Preset, options = {}) => presetRange(preset, today, options);
  assertEquals(at("today"), { start: today, end: today });
  assertEquals(at("yesterday"), { start: "2026-11-15", end: "2026-11-15" });
  assertEquals(at("todayLastYear"), { start: "2025-11-16", end: "2025-11-16" });
  assertEquals(at("last7Days"), { start: "2026-11-10", end: today });
  assertEquals(at("last30Days"), { start: "2026-10-18", end: today });
  assertEquals(at("thisMonth"), { start: "2026-11-01", end: "2026-11-30" });
  assertEquals(at("sameMonthToDateLastYear"), { start: "2025-11-01", end: "2025-11-16" });
  assertEquals(at("sameMonthLastYear"), { start: "2025-11-01", end: "2025-11-30" });
  assertEquals(at("lastMonth"), { start: "2026-10-01", end: "2026-10-31" });
  assertEquals(at("thisYear"), { start: "2026-01-01", end: "2026-12-31" });
  assertEquals(at("lastYear"), { start: "2025-01-01", end: "2025-12-31" });
  assertEquals(at("allTime"), undefined);
  assertEquals(at("allTime", { min: "2010-01-01" }), { start: "2010-01-01", end: today });
  assertEquals(presetRange("lastMonth", "2026-01-10"), { start: "2025-12-01", end: "2025-12-31" });
  assertEquals(presetRange("todayLastYear", "2028-02-29"), {
    start: "2027-02-28",
    end: "2027-02-28",
  });
});

test("fiscal years start in their month, this one or the last year's", () => {
  const today = "2026-11-16";
  assertEquals(presetRange("thisFiscalYear", today), { start: "2026-01-01", end: "2026-12-31" });
  assertEquals(presetRange("thisFiscalYear", today, { fiscalYearStart: 4 }), {
    start: "2026-04-01",
    end: "2027-03-31",
  });
  assertEquals(presetRange("lastFiscalYear", today, { fiscalYearStart: 4 }), {
    start: "2025-04-01",
    end: "2026-03-31",
  });
  // November, in a year that starts in December: it began last December.
  assertEquals(presetRange("thisFiscalYear", today, { fiscalYearStart: 12 }), {
    start: "2025-12-01",
    end: "2026-11-30",
  });
});

test("a range kept within bounds, or none when it's wholly outside", () => {
  const range = { start: "2026-11-01", end: "2026-11-30" };
  assertEquals(clampRange(range, undefined, "2026-11-16"), {
    start: "2026-11-01",
    end: "2026-11-16",
  });
  assertEquals(clampRange(range, "2026-11-10"), { start: "2026-11-10", end: "2026-11-30" });
  assertEquals(clampRange(range, "2026-12-01"), undefined);
  assertEquals(clampRange(range, undefined, "2026-10-31"), undefined);
});
