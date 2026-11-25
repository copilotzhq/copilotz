/**
 * From and To typed in a range picker without `seconds`, days alone or with `time`: what's typed is
 * text until it's left, Enter, or Apply. Only then is it read, and only then may it move either
 * end; text that can't be read stays as typed, marked, and Apply is off. Here since rc.54, where
 * each keystroke that made a valid day moved the range: typing `2` on the way to `20` in To moved
 * From to the 2nd.
 */
import assert from "node:assert/strict";
import { test } from "../../../testing/mod.ts";
import { parseDay } from "../toolkit/calendar.tsx";
import { isDayTime } from "../toolkit/dates.ts";
import { DateRangePicker } from "../toolkit/date-picker.tsx";
import { blur, click, ENDS, fromEmpty, key, press, retyped, type } from "./date-range-steps.ts";
import { page } from "./page.ts";

type Range = { start: string; end: string };
type Draw = (props: Record<string, unknown>) => Promise<void>;

const today = "2026-11-16";
const footText = () => document.querySelector(".copilotz-date-foot-text")!.textContent!;
const ends = () => [...document.querySelectorAll<HTMLInputElement>(ENDS)].map((i) => i.value);
const invalid = (i: number) =>
  document.querySelectorAll(ENDS)[i].getAttribute("aria-invalid") === "true";
const applyOff = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Apply")!.disabled;

/** A page of a language, with a way to draw a picker in it and the values it applies. */
async function inPage(lang: string, run: (draw: Draw, applied: Range[]) => Promise<void>) {
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
            key={++n}
            today={today}
            onChange={(r: Range) => applied.push(r)}
            {...props}
          />,
        ),
      applied,
    );
  });
}

test("rc.54's case: 21 to 20 in To, through 2, leaves From on the 15th", () =>
  inPage("en-GB", async (draw, applied) => {
    const value = { start: "2026-11-15", end: "2026-11-21" };
    await draw({ value, format: "dd/MM/yyyy" });
    await click(".copilotz-date-field");
    await type(ENDS, 1, "2/11/2026");
    assert.equal(ends()[0], "15/11/2026");
    await type(ENDS, 1, "20/11/2026");
    await blur(ENDS, 1);
    await press("Apply");
    assert.deepEqual(applied.splice(0), [{ start: "2026-11-15", end: "2026-11-20" }]);
    // A wrong day stays as typed, marked, and Apply is off; Enter reads a right one.
    await draw({ value, format: "dd/MM/yyyy" });
    await click(".copilotz-date-field");
    await type(ENDS, 0, "45/11/2026");
    await blur(ENDS, 0);
    assert.equal(ends()[0], "45/11/2026");
    assert.ok(invalid(0) && applyOff());
    await press("Apply");
    assert.deepEqual(applied.splice(0), []);
    await type(ENDS, 0, "16/11/2026");
    await key(ENDS, 0, "Enter");
    assert.ok(!invalid(0) && !applyOff());
    assert.equal(footText(), "16/11/2026 – 21/11/2026");
  }));

const reverse = (day: string) => day.split("-").reverse().join(".");
/** Pickers without seconds: days alone, in each kind of format, and days with times. */
const KINDS: Record<string, unknown>[] = [
  { format: undefined },
  { format: "dd/MM/yyyy" },
  { format: "d MMM yyyy" },
  { format: "yyMMdd" },
  { format: reverse },
  { format: "dd/MM/yyyy", time: true },
];
const START: Range = { start: "2026-11-15", end: "2026-11-21" };
/** For each end, a day within the range and one past the other end, whose commit moves it. */
const TARGETS: [field: number, day: string][] = [
  [1, "2026-11-20"],
  [1, "2026-11-02"],
  [0, "2026-11-16"],
  [0, "2026-11-25"],
];

for (const lang of ["en-US", "ar-EG"]) {
  test(`typing an end without seconds in ${lang}, a key at a time: nothing moves, then it's as if pasted`, () =>
    inPage(lang, async (draw, applied) => {
      for (const kind of KINDS) {
        const name = (text: string) => `${lang} ${JSON.stringify(kind)}: "${text}"`;
        for (const [field, day] of TARGETS) {
          const other = 1 - field;
          await draw({ ...kind, value: { start: day, end: day } });
          const target = ends()[0];
          // Pasted whole, then left.
          await draw({ ...kind, value: START });
          await click(".copilotz-date-field");
          const before = { ends: ends(), foot: footText() };
          await type(ENDS, field, target);
          await blur(ENDS, field);
          await press("Apply");
          const pasted = applied.splice(0);
          // What the field shows reads back, but for a function format, and the Arabic short
          // date `parseDay` doesn't read: there typing the shown text is refused, and moves nothing.
          const readable = parseDay(target, kind.format as string) !== undefined;
          assert.equal(pasted.length, readable ? 1 : 0, name(target));
          // A digit wrong where it can't be: a day, month or year of 99.
          const wrong = target.replace(/\p{Nd}+/u, "99");
          const ways: [string[], Range[]][] = [
            [retyped(before.ends[field], target), pasted],
            [fromEmpty(target), pasted],
            [retyped(before.ends[field], wrong), []],
          ];
          for (const [keys, expected] of ways) {
            await draw({ ...kind, value: START });
            await click(".copilotz-date-field");
            for (const text of keys) {
              await type(ENDS, field, text);
              assert.equal(ends()[other], before.ends[other], name(text));
              assert.equal(footText(), before.foot, name(text));
              assert.deepEqual(applied, [], name(text));
            }
            await blur(ENDS, field);
            await press("Apply");
            assert.deepEqual(applied.splice(0), expected, name(keys.at(-1)!));
          }
        }
      }
    }));
}

test("with a first day picked, To is empty until the second is: in every language and format", () =>
  inPage("ar-EG", async (draw) => {
    for (const kind of KINDS) {
      await draw({ ...kind, value: START });
      await click(".copilotz-date-field");
      await click('[data-day="2026-11-10"]');
      // rc.64 still showed the old end here where it couldn't read that end's text back.
      assert.equal(ends()[1], "", JSON.stringify(kind));
      assert.ok(applyOff());
      await click('[data-day="2026-11-12"]');
      assert.notEqual(ends()[1], "");
    }
  }));

// Review round 3.

test("rc.64 apps at the edge of the change: empty, the field's own text, and wrong text", () =>
  (async () => {
    for (const lang of ["en-US", "ar-EG"]) {
      await inPage(lang, async (draw, applied) => {
        for (const format of [undefined, reverse, "dd/MM/yyyy"]) {
          for (const field of [0, 1]) {
            const at = (what: string) => `${lang} ${String(format)}, field ${field}: ${what}`;
            // Empty while typing: not marked; left empty, its end's text again.
            await draw({ format, value: START });
            await click(".copilotz-date-field");
            const shown = ends();
            await type(ENDS, field, "");
            assert.ok(!invalid(field) && !applyOff(), at("empty"));
            await blur(ENDS, field);
            assert.deepEqual(ends(), shown, at("left empty"));
            assert.ok(!invalid(field), at("left empty"));
            await press("Apply");
            assert.deepEqual(applied.splice(0), [START], at("empty, applied"));
            // The field's own text, typed again, is its end, though parseDay can't read it.
            await draw({ format, value: START });
            await click(".copilotz-date-field");
            await type(ENDS, field, shown[field]);
            assert.ok(!invalid(field) && !applyOff(), at("own text"));
            await blur(ENDS, field);
            assert.deepEqual(ends(), shown, at("own text, left"));
            await press("Apply");
            assert.deepEqual(applied.splice(0), [START], at("own text, applied"));
            // Wrong text: marked, kept, and Apply off.
            await draw({ format, value: START });
            await click(".copilotz-date-field");
            const wrong = shown[field].replace(/\p{Nd}+/u, "99");
            await type(ENDS, field, wrong);
            await blur(ENDS, field);
            assert.equal(ends()[field], wrong, at("wrong"));
            assert.ok(invalid(field) && applyOff(), at("wrong"));
            await press("Apply");
            assert.deepEqual(applied.splice(0), [], at("wrong, applied"));
          }
        }
      });
    }
  })());

test("min and max to the minute hold in time mode too: typed, picked, each preset", () =>
  inPage("en-GB", async (draw, applied) => {
    const bounds = [
      { min: "2026-11-02 08:30", max: "2026-11-16 12:00" },
      { max: "2026-11-16 12:00" },
      { min: "2026-11-02 08:30" },
    ];
    const fits = (end: string, b: { min?: string; max?: string }) =>
      (!b.min || end >= b.min) && (!b.max || end.slice(0, 16) <= b.max);
    const value = { start: "2026-11-05 07:00", end: "2026-11-10 23:00" };
    for (const b of bounds) {
      const at = JSON.stringify(b);
      // Picked on a bound's day: its time is held to the bound, in the foot and applied.
      await draw({ ...b, value, time: true, format: "dd/MM/yyyy", presets: false });
      await click(".copilotz-date-field");
      await click(`[data-day="${b.min ? "2026-11-02" : "2026-11-03"}"]`);
      await click(`[data-day="${b.max ? "2026-11-16" : "2026-11-15"}"]`);
      const foot = footText();
      await press("Apply");
      const [range] = applied.splice(0);
      assert.ok(fits(range.start, b) && fits(range.end, b), `${at}: ${range.start} – ${range.end}`);
      const said = (end: string) =>
        `${end.slice(8, 10)}/${end.slice(5, 7)}/${end.slice(0, 4)} ${end.slice(11, 16)}`;
      assert.equal(foot, `${said(range.start)} – ${said(range.end)}`, `${at}: the foot`);
      // Each preset.
      await draw({ ...b, value, time: true, presets: true });
      const count = document.querySelectorAll(".copilotz-date-preset").length - 1;
      for (let i = 0; i < count; i++) {
        await draw({ ...b, value, time: true, presets: true });
        await click(".copilotz-date-preset", i);
        const [preset] = applied.splice(0);
        assert.ok(isDayTime(preset.start) && isDayTime(preset.end), `${at}, preset ${i}`);
        assert.ok(
          fits(preset.start, b) && fits(preset.end, b),
          `${at}, preset ${i}: ${preset.start} – ${preset.end}`,
        );
      }
      // Typed: a bound's day reads, and a day past it doesn't.
      await draw({ ...b, value, time: true, format: "dd/MM/yyyy", presets: false });
      await click(".copilotz-date-field");
      if (b.max) {
        await type(ENDS, 1, "16/11/2026");
        assert.ok(!invalid(1), `${at}: max's day`);
        await type(ENDS, 1, "17/11/2026");
        assert.ok(invalid(1), `${at}: after max`);
      }
      if (b.min) {
        await type(ENDS, 0, "02/11/2026");
        assert.ok(!invalid(0), `${at}: min's day`);
      }
    }
  }));

test("the months never pass December 9999: Next is off there, and nothing breaks", () =>
  inPage("en-GB", async (draw) => {
    const month = () =>
      [...document.querySelectorAll(".copilotz-calendar-title")].map((h) => h.textContent).join(
        " | ",
      );
    for (const props of [{}, { seconds: true }, { time: true }]) {
      for (const today of ["9999-12-15", "9999-10-01"]) {
        await draw({ ...props, today, value: { start: today, end: today } });
        await click(".copilotz-date-field");
        for (let i = 0; i < 4; i++) {
          const next = document.querySelectorAll<HTMLButtonElement>(".copilotz-calendar-nav")[1];
          if (next.disabled) break;
          await click(".copilotz-calendar-nav", 1);
        }
        const nav = document.querySelectorAll<HTMLButtonElement>(".copilotz-calendar-nav");
        assert.ok(nav[1].disabled, `${JSON.stringify(props)} ${today}: Next`);
        assert.match(month(), /December 9999/, `${JSON.stringify(props)} ${today}`);
        assert.doesNotMatch(month(), /10000|\+0/, `${JSON.stringify(props)} ${today}`);
      }
    }
  }));
