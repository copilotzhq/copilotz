/**
 * The two readers of a range's end to the second: the pattern it shows its ends in, and the form
 * the toolkit keeps an end in (`2026-11-02 14:30:05`, or with a `T`). For every format an app may
 * give, in several languages, what the picker shows reads back as that end, and a kept end pasted
 * reads as itself: the two readers never read one text as two values.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { formatPattern, lastOfMonth } from "../toolkit/dates.ts";
import { rangeSecondsPattern, readEnd } from "../toolkit/day-time-text.ts";

const two = (n: number) => String(n).padStart(2, "0");

test("a kept end pasted with a year-day-month format is its own day, not another", () => {
  const { pattern, setAside } = rangeSecondsPattern("yyyy-dd-MM HH:mm:ss", "en-US");
  assertMatch(setAside ?? "", /2026-11-02 14:30:05/);
  assertEquals(readEnd("2026-11-02 09:00:07", pattern, "en-US"), "2026-11-02 09:00:07");
  assertEquals(readEnd("2026-11-02T09:00:07", pattern, "en-US"), "2026-11-02 09:00:07");
  // A format that reads the kept form as the same end keeps it.
  assertEquals(rangeSecondsPattern("yyyy-MM-dd HH:mm:ss", "en-US").setAside, undefined);
  assertEquals(rangeSecondsPattern("yyyy-MM-dd'T'HH:mm:ss", "en-US").setAside, undefined);
  assertEquals(rangeSecondsPattern("dd/MM/yyyy", "en-GB").setAside, undefined);
});

/** Formats an app may give: the day's fields in each order, by each separator, with each time. */
const FORMATS: string[] = [];
const ORDERS = [
  ["yyyy", "MM", "dd"],
  ["yyyy", "dd", "MM"],
  ["dd", "MM", "yyyy"],
  ["MM", "dd", "yyyy"],
  ["yyyy", "M", "d"],
  ["yyyy", "d", "M"],
  ["d", "M", "yyyy"],
];
const TIMES = ["", " HH:mm", " HH:mm:ss", "'T'HH:mm:ss", " mm:HH:ss", " HH-mm-ss", " hh:mm:ss a"];
for (const order of ORDERS) {
  for (const separator of ["-", "/", ".", " ", ""]) {
    for (const time of TIMES) FORMATS.push(order.join(separator) + time);
  }
}

/** Ends whose day and month could trade places, and ones they couldn't, at times to the second. */
const ENDS: string[] = [];
for (const month of [1, 2, 11, 12]) {
  const last = +lastOfMonth(2026, month).slice(8);
  for (let day = 1; day <= last; day += 2) {
    ENDS.push(`2026-${two(month)}-${two(day)} ${two((day * 5) % 24)}:${two(day)}:${two(month)}`);
  }
}
ENDS.push("0000-01-01 00:00:00", "9999-12-31 23:59:59", "2026-11-02 12:00:00");

test("every format, in several languages: what's shown, and a kept end, each read as the end", () => {
  let checked = 0;
  for (const locale of ["en-US", "pt-BR", "sv-SE", "ar-EG"]) {
    for (const format of FORMATS) {
      const { pattern } = rangeSecondsPattern(format, locale);
      const name = `${format} in ${locale} (${pattern})`;
      for (const end of ENDS) {
        const shown = formatPattern(end, pattern, locale);
        assertEquals(readEnd(shown, pattern, locale), end, `${name}: shown ${shown}`);
        for (const kept of [end, end.replace(" ", "T")]) {
          assertEquals(readEnd(kept, pattern, locale), end, `${name}: kept ${kept}`);
        }
        const minute = end.slice(0, 16);
        assertEquals(readEnd(minute, pattern, locale), `${minute}:00`, `${name}: kept ${minute}`);
        checked++;
      }
    }
  }
  assert(checked > 10_000, `${checked} ends`);
});
