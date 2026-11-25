/**
 * A range to the second, in a page: every text it shows for an end (the field, the foot, From and
 * To) is one pattern's, and pasting it back gives the same end, in every language; what isn't one
 * real day and time, a date in another calendar's year, or text written by a pattern that can't be
 * read back, is marked and changes nothing.
 */
import assert from "node:assert/strict";
import { test } from "../../../testing/mod.ts";
import { DateRangePicker } from "../toolkit/date-picker.tsx";
import { blur, click, ENDS, press, type } from "./date-range-steps.ts";
import { page } from "./page.ts";

type Range = { start: string; end: string };

const SEP = " – ";
const today = "2026-11-16";
const fieldText = () => document.querySelector(".copilotz-date-field-text")!.textContent!;
const footText = () => document.querySelector(".copilotz-date-foot-text")!.textContent!;
const ends = () => [...document.querySelectorAll<HTMLInputElement>(ENDS)].map((i) => i.value);
const invalid = (i: number) =>
  document.querySelectorAll(ENDS)[i].getAttribute("aria-invalid") === "true";

/** A page of a language, with a way to draw a picker in it and the values it applies. */
async function inPage(
  lang: string,
  run: (draw: (props: Record<string, unknown>) => Promise<void>, applied: Range[]) => Promise<void>,
) {
  await page(async (render) => {
    document.documentElement.lang = lang;
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.showPopover = () => {};
    proto.hidePopover = () => {};
    const applied: Range[] = [];
    let n = 0;
    await run(
      (props) =>
        render(
          <DateRangePicker
            key={n++}
            today={today}
            seconds
            onChange={(r: Range) => applied.push(r)}
            {...props}
          />,
        ),
      applied,
    );
  });
}

/** Silences `console.warn` while it runs, and gives back what was warned. */
async function warnings(run: () => Promise<void>): Promise<string[]> {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void said.push(args.join(" "));
  try {
    await run();
  } finally {
    console.warn = warn;
  }
  return said;
}

const LANGS = ["en-US", "en-GB", "de-DE", "ja-JP", "ko-KR", "ar-EG", "fa-IR", "th-TH"];
const FORMATS: unknown[] = [
  undefined,
  "dd/MM/yyyy",
  "MM/dd/yyyy",
  "d MMM yyyy",
  "dd/MM/yyyy HH:mm",
  "MM/dd/yyyy hh:mm:ss a",
  "yyyy/Md HH:mm:ss",
  (day: string) => day.split("-").reverse().join("."),
];
const VALUES: Range[] = [
  { start: "2026-11-02 00:00:00", end: "2026-11-16 12:00:00" },
  { start: "2024-02-29 11:59:59", end: "2024-02-29 23:59:59" },
  { start: "2026-03-08 02:30:00", end: "2026-12-31 13:05:09" },
];
const OTHER: Range = { start: "2025-01-10 10:10:10", end: "2025-01-20 20:20:20" };

const digitsOf = (lang: string) => {
  const format = new Intl.NumberFormat(lang, { useGrouping: false });
  return Array.from({ length: 10 }, (_, n) => format.format(n));
};

for (const lang of LANGS) {
  test(`a range to the second in ${lang}: what it shows for an end, pasted back, is that end`, () =>
    warnings(() =>
      inPage(lang, async (draw, applied) => {
        const digits = digitsOf(lang);
        for (const format of FORMATS) {
          for (const value of VALUES) {
            await draw({ value, format });
            const [from, to] = ends();
            // One pattern writes the field, the foot, From and To.
            assert.equal(fieldText(), `${from}${SEP}${to}`, `${lang} ${format}`);
            assert.equal(footText(), `${from}${SEP}${to}`);
            assert.equal(
              document.querySelector(".copilotz-date-field")!.getAttribute("aria-label"),
              `Choose dates: ${from}${SEP}${to}`,
            );
            const pastes = [[from, to]];
            if (digits[0] !== "0") {
              pastes.push([from, to].map((t) => t.replace(/[0-9]/g, (d) => digits[+d])));
            }
            for (const [a, b] of pastes) {
              await draw({ value: OTHER, format });
              await click(".copilotz-date-field");
              await type(ENDS, 0, a);
              await type(ENDS, 1, b);
              assert.ok(!invalid(0) && !invalid(1), `${lang} ${String(format)}: ${a}, ${b}`);
              await press("Apply");
              assert.deepEqual(applied.splice(0), [value], `${lang} ${String(format)}: ${a}`);
            }
          }
        }
      })
    ));
}

test("no spin fields with seconds: From and To hold the whole end", () =>
  inPage("en-GB", async (draw) => {
    await draw({ value: VALUES[0], format: "dd/MM/yyyy" });
    assert.equal(document.querySelectorAll("[role=spinbutton]").length, 0);
    assert.deepEqual(ends(), ["02/11/2026 00:00:00", "16/11/2026 12:00:00"]);
    assert.ok(document.querySelector(".copilotz-date-end-time"));
  }));

test("English with no format: a 12-hour clock, shown and read alike", () =>
  inPage("en-US", async (draw, applied) => {
    await draw({ value: { start: "2026-11-16 13:00:00", end: "2026-11-16 23:59:59" } });
    assert.equal(fieldText(), "11/16/2026 01:00:00 PM – 11/16/2026 11:59:59 PM");
    await click(".copilotz-date-field");
    await type(ENDS, 0, "11/16/2026 13:00:00");
    assert.ok(invalid(0), "a 24-hour time where the field writes AM and PM");
    await type(ENDS, 0, "11/16/2026 1:00 pm");
    assert.ok(!invalid(0));
    await press("Apply");
    assert.deepEqual(applied, [{ start: "2026-11-16 13:00:00", end: "2026-11-16 23:59:59" }]);
  }));

test("an app wanting 24 hours gives a format with HH", () =>
  inPage("en-US", async (draw) => {
    await draw({ value: VALUES[0], format: "MM/dd/yyyy HH:mm:ss" });
    assert.equal(fieldText(), "11/02/2026 00:00:00 – 11/16/2026 12:00:00");
  }));

test("a format that can't be read back: never shown, never read, and said once", async () => {
  const said = await warnings(() =>
    inPage("en-US", async (draw, applied) => {
      const value = { start: "2026-11-02 14:30:05", end: "2026-11-30 18:00:00" };
      await draw({ value, format: "yyyy/dM HH:mm:ss" });
      assert.ok(!fieldText().includes("2026/211"), fieldText());
      assert.equal(ends()[0], "11/02/2026 02:30:05 PM");
      await click(".copilotz-date-field");
      await type(ENDS, 0, "2026/211 14:30:05");
      assert.ok(invalid(0));
      await press("Apply");
      assert.deepEqual(applied.splice(0), [value]);
      await draw({ value, format: "yyyy/dM HH:mm:ss" });
    })
  );
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /yyyy\/dM HH:mm:ss/);
  assert.match(said[0], /MM'\/'dd'\/'yyyy hh':'mm':'ss' 'a/);
});

test("other calendars' years, impossible days, and instants are refused", () =>
  inPage("th-TH", async (draw, applied) => {
    const value = { start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:59" };
    await draw({ value });
    await click(".copilotz-date-field");
    for (
      const wrong of [
        "02/11/2569 14:30:00", // the Buddhist year
        "31/02/2026 10:00:00",
        "2026-11-02T14:30:05Z",
        "2026-11-02 14:30:05-03:00",
        "02/11/26 14:30:00",
      ]
    ) {
      await type(ENDS, 0, wrong);
      assert.ok(invalid(0), wrong);
    }
    await press("Apply");
    assert.deepEqual(applied.splice(0), [value]);
    // Where the app's bounds allow it, a far year is the app's to allow.
    await draw({ value, max: "2600-12-31" });
    await click(".copilotz-date-field");
    await type(ENDS, 1, "02/11/2569 14:30:00");
    assert.ok(!invalid(1));
    await press("Apply");
    assert.deepEqual(applied.splice(0), [{ start: value.start, end: "2569-11-02 14:30:00" }]);
  }));

test("a Persian year typed in Persian digits is refused; the Gregorian one is read", () =>
  inPage("fa-IR", async (draw, applied) => {
    const value = { start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:59" };
    await draw({ value });
    await click(".copilotz-date-field");
    await type(ENDS, 0, "۱۴۰۵/۰۸/۱۱ ۱۴:۳۰:۰۰");
    assert.ok(invalid(0));
    await type(ENDS, 0, "۲۰۲۶/۱۱/۰۲ ۱۴:۳۰:۰۰");
    assert.ok(!invalid(0));
    await press("Apply");
    assert.deepEqual(applied, [{ start: "2026-11-02 14:30:00", end: value.end }]);
  }));

test("typing: seconds left out are :00, the toolkit's own form is read, bounds hold", () =>
  inPage("en-GB", async (draw, applied) => {
    const value = { start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:59" };
    await draw({ value, min: "2026-10-01", max: "2026-12-31" });
    await click(".copilotz-date-field");
    await type(ENDS, 0, "02/11/2026 14:30");
    assert.ok(!invalid(0));
    await type(ENDS, 1, "2026-11-20T08:00:05");
    assert.ok(!invalid(1));
    await type(ENDS, 1, "01/01/2027 00:00:00");
    assert.ok(invalid(1), "after max");
    await type(ENDS, 1, "31/12/2026 23:59:59");
    assert.ok(!invalid(1), "max's last second");
    await type(ENDS, 1, "2026-11-20 08:00:05");
    await blur(ENDS, 1);
    assert.equal(ends()[1], "20/11/2026 08:00:05");
    await press("Apply");
    assert.deepEqual(applied, [{ start: "2026-11-02 14:30:00", end: "2026-11-20 08:00:05" }]);
  }));

test("days picked keep each end's time; on one day the end never comes before the start", () =>
  inPage("en-GB", async (draw, applied) => {
    await draw({ value: { start: "2026-11-01 18:00:00", end: "2026-11-30 07:30:15" } });
    await click(".copilotz-date-field");
    await click('[data-day="2026-11-10"]');
    await click('[data-day="2026-11-12"]');
    assert.deepEqual(ends(), ["10/11/2026 18:00:00", "12/11/2026 07:30:15"]);
    await press("Apply");
    await click(".copilotz-date-field");
    await click('[data-day="2026-11-10"]');
    await click('[data-day="2026-11-10"]');
    await press("Apply");
    assert.deepEqual(applied, [
      { start: "2026-11-10 18:00:00", end: "2026-11-12 07:30:15" },
      { start: "2026-11-10 18:00:00", end: "2026-11-10 18:00:00" },
    ]);
  }));

test("presets run from 00:00:00 to 23:59:59, and show pressed only for whole days", () =>
  inPage("en-GB", async (draw, applied) => {
    await draw({ value: { start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:59" } });
    const pressed = () => document.querySelector(".copilotz-date-preset[aria-pressed=true]")!;
    assert.equal(pressed().textContent, "This month");
    await draw({ value: { start: "2026-11-01 00:00:00", end: "2026-11-30 23:59:00" } });
    assert.equal(pressed().textContent, "Custom range");
    await draw({ value: { start: "2026-11-01", end: "2026-11-30 17:45" } });
    assert.deepEqual(ends(), ["01/11/2026 00:00:00", "30/11/2026 17:45:00"]);
    await click(".copilotz-date-preset", 0);
    assert.deepEqual(applied, [{ start: `${today} 00:00:00`, end: `${today} 23:59:59` }]);
  }));

test("with no value: today, from its first second to its last", () =>
  inPage("en-GB", async (draw) => {
    await draw({});
    assert.deepEqual(ends(), ["16/11/2026 00:00:00", "16/11/2026 23:59:59"]);
    assert.equal(fieldText(), "");
  }));
