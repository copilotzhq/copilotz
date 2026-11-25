/**
 * The date pieces as the page draws them: a calendar is a grid with one day in the tab order,
 * each day named by its whole date, today and the chosen marked, and days past `max` refused;
 * a range picker shows its value in the app's format, its presets in the toolkit's words with
 * the matching one pressed; the clock draws no time on the server.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Calendar, formatDay, parseDay, weekStartOf } from "../toolkit/calendar.tsx";
import { DatePicker, DateRangePicker, rangePresets } from "../toolkit/date-picker.tsx";
import { clockText, LiveClock } from "../toolkit/live-clock.tsx";

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");
const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

test("a calendar: a grid, one day to tab to, whole dates as names, today and bounds marked", () => {
  const html = markup(
    <Calendar
      month="2026-11"
      onMonth={() => {}}
      value="2026-11-10"
      onPick={() => {}}
      today="2026-11-16"
      max="2026-11-16"
      weekStart={0}
    />,
  );
  assertEquals(count(html, /role="grid"/g), 1);
  assertEquals(count(html, /tabindex="0"/g), 1);
  assertStringIncludes(html, 'tabindex="0" aria-label="Tuesday, November 10, 2026"');
  assertStringIncludes(html, 'aria-label="Monday, November 16, 2026" aria-current="date"');
  // The 17th to the 30th can't be chosen; the month's days only, 30 of them.
  assertEquals(count(html, /aria-disabled="true"/g), 14);
  assertEquals(count(html, /class="copilotz-calendar-day"/g), 30);
  assertEquals(count(html, /aria-selected="true"/g), 1);
  assertStringIncludes(html, 'aria-label="Next month" disabled=""');
  assertStringIncludes(html, ">November 2026</h2>");
});

test("a range: its ends chosen, the days between marked, over two months", () => {
  const html = markup(
    <Calendar
      months={2}
      month="2026-10"
      onMonth={() => {}}
      value={{ start: "2026-10-30", end: "2026-11-02" }}
      onPick={() => {}}
      weekStart={1}
      monthFormat="MMM yyyy"
    />,
  );
  assertEquals(count(html, /role="grid"/g), 2);
  assertEquals(count(html, /aria-selected="true"/g), 2);
  assertEquals(count(html, /data-between=""/g), 2); // the 31st and the 1st
  assertStringIncludes(html, ">Oct 2026</h2>");
  assertStringIncludes(html, ">Nov 2026</h2>");
  assertEquals(count(html, /tabindex="0"/g), 1);
});

test("the week starts where the language starts it", () => {
  assertEquals(weekStartOf("en-US"), 0);
  assertEquals(weekStartOf("pt-BR"), 0);
  assert([0, 1].includes(weekStartOf("en-GB"))); // Monday, where the runtime knows weeks
  assertEquals(weekStartOf("not a language!"), 0);
});

test("days in the app's format: a pattern, its own function, or the page's short date", () => {
  assertEquals(formatDay("2026-11-06", "dd/MM/yyyy"), "06/11/2026");
  assertEquals(formatDay("2026-11-06", (day) => `«${day}»`), "«2026-11-06»");
  assertEquals(formatDay("2026-11-06"), "11/6/2026");
});

test("presets: the toolkit's words, in the order asked, kept within bounds", () => {
  const today = "2026-11-16";
  const standard = rangePresets(today, { max: today });
  assertEquals(standard.map((p) => p.label), [
    "Today",
    "Yesterday",
    "Last 7 days",
    "Last 30 days",
    "This month",
    "Last month",
    "This year",
    "Last year",
  ]);
  assertEquals(standard[4].range, { start: "2026-11-01", end: today });
  const asked = rangePresets(today, {
    keys: ["thisFiscalYear", "allTime", "today"],
    fiscalYearStart: 4,
    min: "2010-01-01",
    max: today,
  });
  assertEquals(asked.map((p) => [p.key, p.range]), [
    ["thisFiscalYear", { start: "2026-04-01", end: today }],
    ["allTime", { start: "2010-01-01", end: today }],
    ["today", { start: today, end: today }],
  ]);
});

test("a range picker: its value in the app's format, the matching preset pressed", () => {
  const html = markup(
    <DateRangePicker
      label="Period"
      value={{ start: "2026-11-01", end: "2026-11-16" }}
      onChange={() => {}}
      today="2026-11-16"
      max="2026-11-16"
      format="dd/MM/yyyy"
    />,
  );
  assertStringIncludes(html, 'aria-label="Period: 01/11/2026 – 16/11/2026"');
  assertStringIncludes(html, 'aria-pressed="true">This month</button>');
  assertStringIncludes(html, 'aria-pressed="false">Custom range</button>');
  assertStringIncludes(html, ">Apply</button>");
  assertEquals(count(html, /role="grid"/g), 2);
  // The months shown end with the one that holds today: October and November.
  assertStringIncludes(html, ">October 2026</h2>");
  assertStringIncludes(html, ">November 2026</h2>");
});

test("a range picker with no presets, and a day picker with nothing chosen yet", () => {
  const none = markup(
    <DateRangePicker
      value={{ start: "2026-11-01", end: "2026-11-16" }}
      onChange={() => {}}
      today="2026-11-16"
      presets={false}
      separator=" - "
      format={(day) => day.split("-").reverse().join(".")}
    />,
  );
  assert(!none.includes("copilotz-date-preset"));
  assertStringIncludes(none, "01.11.2026 - 16.11.2026");
  const day = markup(
    <DatePicker
      value={undefined}
      onChange={() => {}}
      placeholder="Pick a day"
      today="2026-11-16"
    />,
  );
  assertStringIncludes(day, 'aria-label="Choose a date"');
  assertStringIncludes(day, "copilotz-date-field-placeholder");
  assertStringIncludes(day, ">Pick a day</span>");
  assertEquals(count(day, /role="grid"/g), 1);
});

test("the clock: no time drawn on the server; the app's zone and format when it ticks", () => {
  const html = markup(<LiveClock format="dd/MM/yyyy HH:mm:ss" label="Shop time" />);
  assertEquals(
    html,
    '<time class="copilotz-live-clock"><span class="copilotz-sr">Shop time</span></time>',
  );
  const now = new Date("2026-11-17T01:30:05Z");
  assertEquals(clockText(now, "dd/MM/yyyy HH:mm:ss", "America/Sao_Paulo"), "16/11/2026 22:30:05");
  assertEquals(clockText(now, (at) => `[${at}]`, "Asia/Tokyo"), "[2026-11-17 10:30:05]");
  assertStringIncludes(clockText(now, undefined, "UTC"), "1:30:05");
});

test("typed days read back in the format the field shows", () => {
  assertEquals(parseDay("16/11/2026", "dd/MM/yyyy"), "2026-11-16");
  assertEquals(parseDay("11/16/2026"), "2026-11-16"); // the page language's short date
  assertEquals(parseDay("2026-11-16", (day) => day.split("-").reverse().join(".")), "2026-11-16");
  assertEquals(parseDay("16/11/2026", "dd/MM/yyyy"), "2026-11-16");
  assertEquals(parseDay("45/11/2026", "dd/MM/yyyy"), undefined);
  assertEquals(parseDay("hello"), undefined);
});

test("a range picker: From and To typed over the months, in the field's format", () => {
  const html = markup(
    <DateRangePicker
      value={{ start: "2026-11-01", end: "2026-11-16" }}
      onChange={() => {}}
      today="2026-11-16"
      format="dd/MM/yyyy"
    />,
  );
  assertStringIncludes(html, ">From</label>");
  assertStringIncludes(html, ">To</label>");
  assertStringIncludes(html, 'value="01/11/2026"');
  assertStringIncludes(html, 'value="16/11/2026"');
  assert(!html.includes("spinbutton"));
});

test("a long range opens its months on its start", () => {
  const html = markup(
    <DateRangePicker
      value={{ start: "2010-01-01", end: "2026-11-16" }}
      onChange={() => {}}
      today="2026-11-16"
    />,
  );
  assertStringIncludes(html, ">January 2010</h2>");
  assertStringIncludes(html, ">February 2010</h2>");
  assert(!html.includes("November 2026</h2>"));
});

test("a range picker with times: each end has a time of day, from the value's day-times", () => {
  const html = markup(
    <DateRangePicker
      time
      value={{ start: "2026-11-01 08:15", end: "2026-11-16 17:45" }}
      onChange={() => {}}
      today="2026-11-16"
      format="dd/MM/yyyy"
    />,
  );
  assertStringIncludes(html, 'aria-label="From: Time of day"');
  assertStringIncludes(html, 'aria-label="To: Time of day"');
  assertEquals(count(html, /role="spinbutton"/g), 4);
  assertStringIncludes(html, 'aria-valuenow="8"');
  assertStringIncludes(html, 'aria-valuenow="45"');
  assertStringIncludes(html, "01/11/2026 08:15 – 16/11/2026 17:45");
});

test("a range to the second: a seconds field at each end, and ends that always have them", () => {
  const html = markup(
    <DateRangePicker
      seconds
      label="Report"
      value={{ start: "2026-11-01 08:15:30", end: "2026-11-16 17:45" }}
      onChange={() => {}}
      today="2026-11-16"
      format="dd/MM/yyyy"
    />,
  );
  assertEquals(count(html, /role="spinbutton"/g), 6);
  assertEquals(count(html, /aria-label="second"/g), 2);
  assertStringIncludes(html, 'aria-valuenow="30"');
  // An end kept to the minute is at its `:00`.
  assertStringIncludes(html, 'aria-label="Report: 01/11/2026 08:15:30 – 16/11/2026 17:45:00"');
  // From and To each show the date alongside its time fields.
  assertStringIncludes(html, 'value="01/11/2026"');
  assertStringIncludes(html, 'value="16/11/2026"');
});

test("a whole day to the second is its preset's: 00:00:00 to 23:59:59", () => {
  const html = markup(
    <DateRangePicker
      seconds
      value={{ start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:59" }}
      onChange={() => {}}
      today="2026-11-16"
      format="dd/MM/yyyy"
    />,
  );
  assertStringIncludes(html, 'aria-pressed="true">This month</button>');
  const minute = markup(
    <DateRangePicker
      seconds
      value={{ start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:00" }}
      onChange={() => {}}
      today="2026-11-16"
      format="dd/MM/yyyy"
    />,
  );
  assertStringIncludes(minute, 'aria-pressed="true">Custom range</button>');
});

test("a range in the app's day-time pattern: each end written whole, its day typed alone", () => {
  const html = markup(
    <DateRangePicker
      seconds
      label="Report"
      value={{ start: "2026-11-01 08:15:30", end: "2026-11-16 17:45:05" }}
      onChange={() => {}}
      today="2026-11-16"
      format="MM/dd/yyyy hh:mm:ss a"
    />,
  );
  assertStringIncludes(
    html,
    'aria-label="Report: 11/01/2026 08:15:30 AM – 11/16/2026 05:45:05 PM"',
  );
  assertStringIncludes(html, 'value="11/01/2026"');
  assertStringIncludes(html, 'value="11/16/2026"');
  // `time` alone, in a pattern without seconds: the ends to the minute.
  const minutes = markup(
    <DateRangePicker
      time
      label="Shifts"
      value={{ start: "2026-11-01 08:00", end: "2026-11-01 17:30" }}
      onChange={() => {}}
      today="2026-11-16"
      format="dd/MM/yyyy HH:mm"
    />,
  );
  assertStringIncludes(minutes, 'aria-label="Shifts: 01/11/2026 08:00 – 01/11/2026 17:30"');
  assertEquals(count(minutes, /role="spinbutton"/g), 4);
});
