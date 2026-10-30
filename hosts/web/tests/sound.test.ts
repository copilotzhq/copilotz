/**
 * How sound is told and drawn: a length as a clock shows it (`clock`), and a
 * recording's loudness as as many bars as there's room for (`resample`).
 */
import { assertEquals } from "@std/assert";
import { clock } from "../toolkit/clock.ts";
import { resample } from "../toolkit/resample.ts";
import { test } from "../../../testing/mod.ts";

test("clock: minutes and seconds, hours when there are some; down, or to the nearest", () => {
  assertEquals(clock(0), "0:00");
  assertEquals(clock(7_400), "0:07");
  assertEquals(clock(7_600), "0:07");
  assertEquals(clock(7_600, true), "0:08");
  assertEquals(clock(600_000), "10:00");
  assertEquals(clock(3_723_000), "1:02:03");
  assertEquals(clock(-5), "0:00");
  assertEquals(clock(Infinity), "0:00");
  assertEquals(clock(NaN), "0:00");
});

test("resample: fewer levels average their stretch; more are drawn between; none stay none", () => {
  assertEquals(resample([0.2, 0.4, 0.6, 0.8], 2), [0.3, 0.7]);
  assertEquals(resample([0, 1], 3), [0, 0.5, 1]);
  assertEquals(resample([0.5], 4), [0.5, 0.5, 0.5, 0.5]);
  assertEquals(resample([0.1, 0.2, 0.3], 3), [0.1, 0.2, 0.3]);
  assertEquals(resample([], 8), []);
  assertEquals(resample([0.5, 0.5], 0), []);
  // Ten minutes of levels every 50 ms, as the peaks a voice message sends: 64, 0 to 1.
  const long = Array.from({ length: 12_000 }, (_, i) => (Math.sin(i / 40) + 1) / 2);
  const peaks = resample(long, 64);
  assertEquals(peaks.length, 64);
  assertEquals(peaks.every((p) => p >= 0 && p <= 1), true);
  assertEquals(resample([2, -1], 2), [1, 0]);
});
