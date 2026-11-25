/**
 * From and To typed in a range picker without `seconds`, days alone or with `time`: what's typed is
 * text until it's left, Enter, or Apply. Only then is it read, and only then may it move either
 * end; text that can't be read stays as typed, marked, and Apply is off. Here since rc.54, where
 * each keystroke that made a valid day moved the range: typing `2` on the way to `20` in To moved
 * From to the 2nd.
 */
import assert from "node:assert/strict";
import { test } from "../../../testing/mod.ts";
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
          assert.equal(pasted.length, 1, name(target));
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
