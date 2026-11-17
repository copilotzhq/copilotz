/**
 * A day and a time of it, as the date-time picker keeps them (`YYYY-MM-DD HH:mm`, the app's clock):
 * what's one, its parts, bounds given as days or day-times, minutes on a step, and the app's now.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  boundOf,
  clampDayTime,
  dayTimeOf,
  isDayTime,
  nowIn,
  partsOfDayTime,
  roundMinute,
} from "../toolkit/dates.ts";

test("a day-time is a real day and a time of it, to the minute or the second", () => {
  assert(isDayTime("2026-11-16 14:30"));
  assert(isDayTime("2024-02-29 00:00"));
  assert(isDayTime("2026-12-31 23:59"));
  assert(isDayTime("2026-11-16 14:30:00"));
  assert(isDayTime("2026-11-16 23:59:59"));
  for (
    const not of [
      "2026-11-16",
      "2026-11-16 24:00",
      "2026-11-16 12:60",
      "2026-02-30 10:00",
      "2026-11-16T14:30",
      "2026-11-16 14:30:60",
      "2026-11-16 14:30:5",
      "2026-11-16 9:30",
      20261116,
    ]
  ) {
    assert(!isDayTime(not), String(not));
  }
});

test("a day-time's parts, and one made of them", () => {
  assertEquals(partsOfDayTime("2026-11-16 09:05"), { day: "2026-11-16", hour: 9, minute: 5 });
  assertEquals(dayTimeOf("2026-11-16", 9, 5), "2026-11-16 09:05");
  assertEquals(dayTimeOf("2026-01-01", 0, 0), "2026-01-01 00:00");
});

test("a day as a bound takes all of it; a day-time stays as it is", () => {
  assertEquals(boundOf("2026-11-16", "min"), "2026-11-16 00:00");
  assertEquals(boundOf("2026-11-16", "max"), "2026-11-16 23:59");
  assertEquals(boundOf("2026-11-16 08:00", "max"), "2026-11-16 08:00");
  assertEquals(boundOf(undefined, "min"), undefined);
});

test("a day-time kept within its bounds: the evening of a max day is in", () => {
  assertEquals(clampDayTime("2026-11-16 21:00", undefined, "2026-11-16"), "2026-11-16 21:00");
  assertEquals(clampDayTime("2026-11-17 01:00", undefined, "2026-11-16"), "2026-11-16 23:59");
  assertEquals(clampDayTime("2026-11-16 07:00", "2026-11-16 08:00"), "2026-11-16 08:00");
  assertEquals(clampDayTime("2009-12-31 23:00", "2010-01-01"), "2010-01-01 00:00");
  assertEquals(clampDayTime("2026-11-16 12:00"), "2026-11-16 12:00");
});

test("minutes on a step, never past the hour's last", () => {
  assertEquals(roundMinute(7, 5), 5);
  assertEquals(roundMinute(8, 5), 10);
  assertEquals(roundMinute(58, 5), 55);
  assertEquals(roundMinute(44, 15), 45);
  assertEquals(roundMinute(59), 59);
  assertEquals(roundMinute(13, 0), 13); // a step under one is one
});

test("the app's now, in its time zone, its minute on the step", () => {
  const at = new Date(Date.UTC(2026, 10, 17, 1, 38, 20)); // 22:38 on the 16th in São Paulo
  assertEquals(nowIn("America/Sao_Paulo", 1, at), "2026-11-16 22:38");
  assertEquals(nowIn("America/Sao_Paulo", 15, at), "2026-11-16 22:45");
  assertEquals(nowIn("UTC", 5, at), "2026-11-17 01:40");
});

test("seconds: parts and values keep them, bounds compare to the second, now can have them", () => {
  assertEquals(partsOfDayTime("2026-11-16 09:05:42"), {
    day: "2026-11-16",
    hour: 9,
    minute: 5,
    second: 42,
  });
  assertEquals(dayTimeOf("2026-11-16", 9, 5, 7), "2026-11-16 09:05:07");
  assertEquals(boundOf("2026-11-16", "max", true), "2026-11-16 23:59:59");
  // The last evening second of a max day is in, and seconds are not dropped.
  assertEquals(clampDayTime("2026-11-16 23:59:30", undefined, "2026-11-16"), "2026-11-16 23:59:30");
  assertEquals(clampDayTime("2026-11-17 00:00:01", undefined, "2026-11-16"), "2026-11-16 23:59:59");
  assertEquals(clampDayTime("2026-11-16 08:00:10", "2026-11-16 08:00"), "2026-11-16 08:00:10");
  assertEquals(clampDayTime("2026-11-16 07:59:59", "2026-11-16 08:00"), "2026-11-16 08:00");
  const at = new Date("2026-11-16T12:34:56Z");
  assertEquals(nowIn("UTC", 5, at), "2026-11-16 12:35");
  assertEquals(nowIn("UTC", 5, at, true), "2026-11-16 12:34:56");
});
