/**
 * A range to the second, in a page: every text it shows for an end (the field, the foot, From and
 * To) is one pattern's, and pasting it back gives the same end, in every language; what isn't one
 * real day and time, a date in another calendar's year, or text written by a pattern that can't be
 * read back, is marked and changes nothing.
 */
import assert from "node:assert/strict";
import { test } from "../../../testing/mod.ts";
import { addMonths, isDayTime } from "../toolkit/dates.ts";
import { DateRangePicker } from "../toolkit/date-picker.tsx";
import { rangeSecondsPattern, readEnd } from "../toolkit/day-time-text.ts";
import { blur, click, ENDS, fromEmpty, press, retyped, type } from "./date-range-steps.ts";
import { page } from "./page.ts";

type Range = { start: string; end: string };

const SEP = " – ";
const today = "2026-11-16";
const fieldText = () => document.querySelector(".copilotz-date-field-text")!.textContent!;
const footText = () => document.querySelector(".copilotz-date-foot-text")!.textContent!;
const ends = () => [...document.querySelectorAll<HTMLInputElement>(ENDS)].map((i) => i.value);
const invalid = (i: number) =>
  document.querySelectorAll(ENDS)[i].getAttribute("aria-invalid") === "true";
const applyOff = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Apply")!.disabled;

type Draw = (props: Record<string, unknown>) => Promise<void>;

/**
 * A page of a language, with a way to draw a picker in it (`draw`, a new one; `update`, the last
 * one with new props, open as it is) and the values it applies.
 */
async function inPage(
  lang: string,
  run: (draw: Draw, applied: Range[], update: Draw) => Promise<void>,
) {
  await page(async (render) => {
    document.documentElement.lang = lang;
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.showPopover = () => {};
    proto.hidePopover = () => {};
    const applied: Range[] = [];
    let n = 0;
    const picker = (key: number, props: Record<string, unknown>) =>
      render(
        <DateRangePicker
          key={key}
          today={today}
          seconds
          onChange={(r: Range) => applied.push(r)}
          {...props}
        />,
      );
    await run((props) => picker(++n, props), applied, (props) => picker(n, props));
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
  "yyyy-dd-MM HH:mm:ss",
  "dd/MM/yyyy HH:mm:ss ",
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
      assert.ok(applyOff(), "text that can't be read blocks Apply");
      await press("Apply");
      assert.deepEqual(applied.splice(0), []);
      await type(ENDS, 0, "11/02/2026 02:30:05 PM");
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
      assert.ok(applyOff(), wrong);
    }
    await press("Apply");
    assert.deepEqual(applied.splice(0), []);
    await type(ENDS, 0, "01/11/2026 00:00:00");
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

test("days picked keep each end's time; on one day, an end before the start is marked", () =>
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
    assert.ok(invalid(1) && applyOff());
    await type(ENDS, 1, "10/11/2026 19:00:00");
    await press("Apply");
    assert.deepEqual(applied, [
      { start: "2026-11-10 18:00:00", end: "2026-11-12 07:30:15" },
      { start: "2026-11-10 18:00:00", end: "2026-11-10 19:00:00" },
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

// Review round 1: each finding's case, then its class.

test("an end being typed moves nothing until it's left or applied", () =>
  inPage("en-GB", async (draw, applied) => {
    const value = { start: "2026-11-15 00:00:00", end: "2026-11-21 23:59:59" };
    const format = "dd/MM/yyyy HH:mm:ss";
    // 21 to 20 in To, through 2: From stays on the 15th.
    await draw({ value, format });
    await click(".copilotz-date-field");
    await type(ENDS, 1, "2/11/2026 23:59:59");
    assert.deepEqual(ends()[0], "15/11/2026 00:00:00");
    await type(ENDS, 1, "20/11/2026 23:59:59");
    await blur(ENDS, 1);
    await press("Apply");
    assert.deepEqual(applied.splice(0), [{ start: value.start, end: "2026-11-20 23:59:59" }]);
    // Seconds of 61, through 6: refused, and Apply with them.
    await draw({ value, format });
    await click(".copilotz-date-field");
    await type(ENDS, 1, "21/11/2026 23:59:6");
    await type(ENDS, 1, "21/11/2026 23:59:61");
    await blur(ENDS, 1);
    assert.equal(ends()[1], "21/11/2026 23:59:61");
    assert.ok(invalid(1));
    assert.ok(applyOff());
    await press("Apply");
    assert.deepEqual(applied.splice(0), []);
  }));

const KEYED: unknown[] = [undefined, "dd/MM/yyyy", "d MMM yyyy", "MM/dd/yyyy hh:mm:ss a"];
const START: Range = { start: "2026-11-15 08:00:00", end: "2026-11-21 23:59:59" };
/** For each end, a day within the range and one past the other end, which moves it. */
const TARGETS: [field: number, end: string][] = [
  [1, "2026-11-20 23:59:58"],
  [1, "2026-11-02 07:05:09"],
  [0, "2026-11-16 12:30:01"],
  [0, "2026-11-25 00:00:00"],
];

for (const lang of ["en-US", "ar-EG"]) {
  test(`typing an end in ${lang}, a key at a time: nothing moves, then it's as if pasted`, () =>
    warnings(() =>
      inPage(lang, async (draw, applied) => {
        for (const format of KEYED) {
          for (const [field, end] of TARGETS) {
            const other = 1 - field;
            await draw({ value: { start: end, end }, format });
            const target = ends()[0];
            // Pasted whole, then left.
            await draw({ value: START, format });
            await click(".copilotz-date-field");
            const before = { ends: ends(), foot: footText() };
            await type(ENDS, field, target);
            await blur(ENDS, field);
            await press("Apply");
            const pasted = applied.splice(0);
            // An end past the other one moves its day, keeping its time; if it then ends before it
            // starts, it's marked, and Apply is off.
            const crosses = field === 1
              ? end < START.start && end < `${end.slice(0, 10)}${START.start.slice(10)}`
              : end > START.end && end > `${end.slice(0, 10)}${START.end.slice(10)}`;
            assert.equal(pasted.length, crosses ? 0 : 1, `${lang} ${String(format)}: ${target}`);
            // A digit wrong where it can't be: a day, month, year or hour of 99.
            const wrong = target.replace(/\p{Nd}+/u, "99");
            const ways: [string[], Range[]][] = [
              [retyped(before.ends[field], target), pasted],
              [fromEmpty(target), pasted],
              [retyped(before.ends[field], wrong), []],
            ];
            for (const [keys, expected] of ways) {
              await draw({ value: START, format });
              await click(".copilotz-date-field");
              for (const text of keys) {
                await type(ENDS, field, text);
                const at = `${lang} ${String(format)}: "${text}"`;
                assert.equal(ends()[other], before.ends[other], at);
                assert.equal(footText(), before.foot, at);
                assert.deepEqual(applied, [], at);
              }
              await blur(ENDS, field);
              await press("Apply");
              assert.deepEqual(
                applied.splice(0),
                expected,
                `${lang} ${String(format)}: ${keys.at(-1)}`,
              );
            }
          }
        }
      })
    ));
}

test("a kept end pasted is that end, even with a format that writes year, day, month", () =>
  warnings(() =>
    inPage("en-AU", async (draw, applied) => {
      await draw({ value: OTHER, format: "yyyy-dd-MM HH:mm:ss" });
      await click(".copilotz-date-field");
      await type(ENDS, 0, "2026-11-02 09:00:07");
      await type(ENDS, 1, "2026-11-20T09:00:07");
      await press("Apply");
      assert.deepEqual(applied, [{ start: "2026-11-02 09:00:07", end: "2026-11-20 09:00:07" }]);
    })
  ));

test("a format with spaces at its edges: what it shows reads back", () =>
  warnings(() =>
    inPage("en-US", async (draw, applied) => {
      const value = { start: "2026-11-02 09:00:07", end: "2026-12-01 10:00:00" };
      for (const format of ["dd/MM/yyyy HH:mm:ss ", " dd/MM/yyyy", "yyyy-dd-MM HH:mm:ss "]) {
        await draw({ value, format });
        const [from, to] = ends();
        await draw({ value: OTHER, format });
        await click(".copilotz-date-field");
        await type(ENDS, 0, from);
        await type(ENDS, 1, to);
        await press("Apply");
        assert.deepEqual(applied.splice(0), [value], JSON.stringify(format));
      }
    })
  ));

/** A day-time a number of seconds on, or undefined outside 0000 to 9999. */
function shifted(value: string, seconds: number): string | undefined {
  const [y, m, d, h, mi, s] = value.split(/[- :]/).map(Number);
  const at = new Date(0);
  at.setUTCFullYear(y, m - 1, d);
  at.setUTCHours(h, mi, s + seconds);
  const iso = at.toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 19).replace("T", " ") : undefined;
}

test("the window an end is typed in: 200 years either side of today, within 0000 to 9999", () =>
  inPage("en-GB", async (draw, applied) => {
    const todays = [
      "0000-01-01",
      "0001-06-15",
      "0100-11-16",
      "0199-12-31",
      "0200-02-28",
      "2026-11-16",
      "9799-12-31",
      "9800-01-01",
      "9900-11-16",
      "9999-12-31",
    ];
    for (const day of todays) {
      const year = +day.slice(0, 4);
      const low = year < 200 ? "0000-01-01 00:00:00" : `${addMonths(day, -2400)} 00:00:00`;
      const high = year > 9799 ? "9999-12-31 23:59:59" : `${addMonths(day, 2400)} 23:59:59`;
      await draw({
        today: day,
        presets: false,
        value: { start: `${day} 00:00:00`, end: `${day} 23:59:59` },
      });
      await click(".copilotz-date-field");
      const candidates = [
        "0000-01-01 00:00:00",
        "0001-01-01 00:00:00",
        low,
        high,
        shifted(low, -1),
        shifted(high, 1),
        "9999-12-31 23:59:59",
      ];
      for (const end of candidates) {
        if (!end) continue;
        // Typed where it doesn't pass the other end: To from today on, From before it.
        const field = end >= `${day} 00:00:00` ? 1 : 0;
        await type(ENDS, field, end.replace(" ", "T"));
        const fits = isDayTime(end) && end >= low && end <= high;
        assert.equal(invalid(field), !fits, `today ${day}: ${end}`);
        await type(ENDS, field, "");
      }
      // Every preset offered gives real ends, within 0000 to 9999.
      await draw({ today: day });
      const count = document.querySelectorAll(".copilotz-date-preset").length - 1;
      for (let i = 0; i < count; i++) {
        await draw({ today: day });
        await click(".copilotz-date-preset", i);
      }
      assert.equal(applied.length, count);
      for (const range of applied.splice(0)) {
        assert.ok(isDayTime(range.start) && isDayTime(range.end), `today ${day}: ${range.start}`);
      }
    }
  }));

test("seconds turned on while open: Apply gives each end to the second, as From and To show it", () =>
  inPage("en-GB", async (draw, applied, update) => {
    const { pattern } = rangeSecondsPattern("dd/MM/yyyy", "en-GB");
    const values = [
      undefined,
      { start: "2026-11-02", end: "2026-11-05" },
      { start: "2026-11-02 08:30", end: "2026-11-05 17:45" },
      { start: "2026-11-02 08:30:15", end: "2026-11-05 17:45:59" },
    ];
    for (const time of [false, true]) {
      for (const value of values) {
        for (const pick of [false, true]) {
          const props = { value, time, format: "dd/MM/yyyy" };
          await draw({ ...props, seconds: false });
          await click(".copilotz-date-field");
          if (pick) {
            await click('[data-day="2026-11-10"]');
            await click('[data-day="2026-11-12"]');
          }
          await update({ ...props, seconds: true });
          const [from, to] = ends();
          await press("Apply");
          const at = `time ${time}, ${JSON.stringify(value)}, picked ${pick}`;
          assert.deepEqual(
            applied.splice(0),
            [{ start: readEnd(from, pattern, "en-GB"), end: readEnd(to, pattern, "en-GB") }],
            at,
          );
        }
      }
    }
  }));

test("text typed in one pattern is never read by another", () =>
  inPage("en-GB", async (draw, applied, update) => {
    const value = { start: "2026-11-02 08:00:00", end: "2026-11-20 18:00:00" };
    await draw({ value, format: "dd/MM/yyyy" });
    await click(".copilotz-date-field");
    await type(ENDS, 0, "03/11/2026 08:00:00");
    await update({ value, format: "MM/dd/yyyy" });
    assert.deepEqual(ends(), ["11/02/2026 08:00:00", "11/20/2026 18:00:00"]);
    await press("Apply");
    assert.deepEqual(applied, [value]);
  }));

// Review round 3.

/**
 * What the picker shows is what it applies: with Apply on, the foot is From and To, and Apply gives
 * From and To as they read; with it off, a field is marked.
 */
async function shownIsApplied(applied: Range[], pattern: string, at: string) {
  const [from, to] = ends();
  if (applyOff()) {
    assert.ok(invalid(0) || invalid(1) || to === "", `${at}: Apply off, nothing marked`);
    return;
  }
  assert.equal(footText(), `${from}${SEP}${to}`, `${at}: the foot`);
  await press("Apply");
  assert.deepEqual(
    applied.splice(0),
    [{ start: readEnd(from, pattern, "en-GB"), end: readEnd(to, pattern, "en-GB") }],
    `${at}: applied`,
  );
}

test("an end that would end before the start is marked, never saved as another: same day or another, typed or picked, either end", () =>
  inPage("en-GB", async (draw, applied) => {
    const { pattern } = rangeSecondsPattern("dd/MM/yyyy", "en-GB");
    const value = { start: "2026-11-15 10:00:00", end: "2026-11-21 18:00:00" };
    // Typed: [what, field, text, whether it ends before it starts]. A day past the other end moves
    // that end's day, as since rc.54, keeping its time.
    const typed: [string, number, string, boolean][] = [
      ["To, From's day, earlier", 1, "15/11/2026 08:00:00", true],
      ["To, an earlier day, earlier than From's time", 1, "10/11/2026 08:00:00", true],
      ["To, an earlier day, later than From's time", 1, "10/11/2026 12:00:00", false],
      ["From, To's day, later", 0, "21/11/2026 20:00:00", true],
      ["From, a later day, later than To's time", 0, "25/11/2026 20:00:00", true],
      ["From, a later day, earlier than To's time", 0, "25/11/2026 08:00:00", false],
    ];
    for (const [name, field, text, crosses] of typed) {
      await draw({ value, format: "dd/MM/yyyy" });
      await click(".copilotz-date-field");
      const before = { ends: ends(), foot: footText() };
      await type(ENDS, field, text);
      await blur(ENDS, field);
      assert.equal(ends()[field], text, name);
      if (crosses) {
        // Kept as typed, marked, the other end where it was, and Apply off.
        assert.equal(ends()[1 - field], before.ends[1 - field], name);
        assert.equal(footText(), before.foot, name);
        assert.ok(invalid(field) && applyOff(), name);
        await press("Apply");
        assert.deepEqual(applied.splice(0), [], name);
        // Put right in the other field: both read, and what's shown is what's applied.
        const fix = field === 1 ? "01/11/2026 00:00:00" : "30/11/2026 23:59:59";
        await type(ENDS, 1 - field, fix);
        assert.ok(!invalid(0) && !invalid(1) && !applyOff(), `${name}, put right`);
        await blur(ENDS, 1 - field);
        assert.deepEqual(ends(), field === 1 ? [fix, text] : [text, fix], `${name}, put right`);
      }
      await shownIsApplied(applied, pattern, name);
    }
    // Picked: one day, To's time earlier (marked) or later; a second day before the first.
    const nights = { start: "2026-11-01 18:00:00", end: "2026-11-30 07:30:15" };
    const picks: [string, Range, string[], boolean][] = [
      ["one day, To's time earlier", nights, ["2026-11-10", "2026-11-10"], true],
      ["one day, To's time later", value, ["2026-11-10", "2026-11-10"], false],
      ["the second day first", nights, ["2026-11-20", "2026-11-12"], false],
    ];
    for (const [name, from, days, crosses] of picks) {
      await draw({ value: from, format: "dd/MM/yyyy" });
      await click(".copilotz-date-field");
      for (const day of days) await click(`[data-day="${day}"]`);
      assert.equal(invalid(1) && applyOff(), crosses, name);
      await shownIsApplied(applied, pattern, name);
    }
    // A value that ends before it starts, from the app: To is marked, and Apply is off.
    await draw({ value: { start: "2026-11-16 23:00:00", end: "2026-11-16 07:00:00" } });
    await click(".copilotz-date-field");
    assert.ok(invalid(1) && applyOff());
  }));
