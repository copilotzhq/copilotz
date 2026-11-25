/**
 * The range and day pickers as rc.64 has them, pinned: without `seconds`, `DateRangePicker` and
 * `DatePicker` draw the same markup (their styles included) as rc.64's own copy
 * (`rc64-date-picker.tsx`), and in a page they make the same DOM and the same `onChange` calls, in
 * the same order, for the same steps, unmounting included.
 */
import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import * as live from "../toolkit/date-picker.tsx";
import * as frozen from "./rc64-date-picker.tsx";
import { blur, click, ENDS, key, press, session, type Step, type } from "./date-range-steps.ts";
import { page } from "./page.ts";

type Range = { start: string; end: string };
type Props = Record<string, unknown> & { value?: Range };

const today = "2026-11-16";
const days = { start: "2026-11-01", end: "2026-11-16" };
const timed = { start: "2026-11-01 08:15", end: "2026-11-16 17:45:30" };
const reverse = (day: string) => day.split("-").reverse().join(".");
const presets = [{ key: "q4", label: "Q4", range: { start: "2026-10-01", end: "2026-12-31" } }];

// One prop at a time over a base, then some together.
const base: Props = { value: days, today, format: "dd/MM/yyyy" };
const variants: Props[] = [
  base,
  { ...base, value: undefined },
  { ...base, value: undefined, placeholder: "Pick a period", label: "Period", id: "period" },
  { ...base, format: undefined },
  { ...base, format: "yyMMdd" },
  { ...base, format: "d MMM yyyy" },
  { ...base, format: "dd/MM/yyyy HH:mm" },
  { ...base, format: reverse },
  { ...base, time: true },
  { ...base, time: true, value: timed },
  { ...base, time: true, value: timed, format: undefined },
  { ...base, value: { start: "2026-11-16 23:00", end: "2026-11-16 07:00" }, time: true },
  { ...base, presets: false },
  { ...base, presets },
  { ...base, presets: true, min: "2026-10-05", max: today },
  { ...base, value: { start: "2010-01-01", end: today } },
  { ...base, value: { start: "2026-12-30", end: "2027-03-02" }, max: "2027-01-15" },
  { ...base, separator: " → ", className: "report", disabled: true },
  { ...base, weekStart: 1, monthFormat: "MMM yyyy" },
  { ...base, time: true, presets: false, separator: " - ", min: "2026-11-02" },
];

const LANGS = ["en", "pt-BR", "ar-EG", "th-TH"];

/** Static markup, styles kept, in a page of a language. */
async function drawn(nodes: ReactNode[], lang: string): Promise<string[]> {
  const out: string[] = [];
  await page(async () => {
    document.documentElement.lang = lang;
    for (const node of nodes) out.push(renderToStaticMarkup(<>{node}</>));
  });
  return out;
}

const noop = () => {};

test("rc.64 parity: a range picker without seconds draws what rc.64's draws", async () => {
  for (const lang of LANGS) {
    const [now, then] = [live, frozen].map((m) =>
      variants.map((props) => <m.DateRangePicker onChange={noop} {...props} />)
    );
    const [a, b] = [await drawn(now, lang), await drawn(then, lang)];
    for (const [i, html] of a.entries()) {
      assert.equal(html, b[i], `${lang}, variant ${i}`);
    }
  }
});

test("rc.64 parity: a day picker draws what rc.64's draws", async () => {
  const props: Record<string, unknown>[] = [
    { value: "2026-11-10", today },
    { value: undefined, today, placeholder: "Due" },
    { value: "2026-11-10", today, format: "d MMM yyyy", min: "2026-11-05", max: "2026-11-20" },
    { value: "2026-11-10", today, format: reverse, weekStart: 1, monthFormat: "MMM yyyy" },
    { value: "2026-11-10", label: "Due", id: "due", className: "due", disabled: true, today },
  ];
  for (const lang of LANGS) {
    const [now, then] = [live, frozen].map((m) =>
      props.map((p) => <m.DatePicker onChange={noop} {...p} />)
    );
    assert.deepEqual(await drawn(now, lang), await drawn(then, lang), lang);
  }
});

test("rc.64 parity: the presets helper and the standard list", () => {
  assert.deepEqual(live.STANDARD_PRESETS, frozen.STANDARD_PRESETS);
  for (const options of [{}, { max: today }, { min: "2010-01-01", fiscalYearStart: 4 }]) {
    assert.deepEqual(live.rangePresets(today, options), frozen.rangePresets(today, options));
  }
});

/**
 * The same steps on rc.64's picker and on this one: the same pages and calls, step by step. The
 * pages after the steps named in `apart` aren't compared: there rc.64 read From or To as it was
 * typed, a key at a time (since rc.65 they're read when they're left, Enter or Apply), or kept
 * showing an end no longer there.
 */
async function same(props: Props, steps: Step[], lang = "en", apart: string[] = []) {
  // One page at a time: a page sets the global window and document.
  const run = (m: typeof live) =>
    session((onChange) => <m.DateRangePicker {...props} onChange={onChange} />, steps, lang);
  const a = await run(live);
  const b = await run(frozen);
  assert.equal(a.length, b.length);
  for (const [i, [name, html, calls]] of a.entries()) {
    if (!apart.includes(name)) assert.equal(html, b[i][1], `${lang}: the page after ${name}`);
    assert.deepEqual(calls, b[i][2], `${lang}: the calls after ${name}`);
  }
  // The steps did something: every session applies a range.
  assert.ok(a.some(([, , calls]) => calls.length), "no onChange call");
}

const SPIN = "[role=spinbutton]";

test("rc.64 parity: typing days, picking days, presets, Apply and Cancel", async () => {
  const steps: Step[] = [
    ["open", () => click(".copilotz-date-field")],
    ["From after To", () => type(ENDS, 0, "25/11/2026")],
    ["From left", () => blur(ENDS, 0)],
    ["From half typed", () => type(ENDS, 0, "05/1")],
    ["From wrong", () => type(ENDS, 0, "45/11/2026")],
    ["From typed", () => type(ENDS, 0, "05/11/2026")],
    ["From left", () => blur(ENDS, 0)],
    ["To typed", () => type(ENDS, 1, "20/11/2026")],
    ["To left", () => blur(ENDS, 1)],
    ["To out of bounds", () => type(ENDS, 1, "01/01/2030")],
    ["To before From", () => type(ENDS, 1, "01/10/2026")],
    ["Enter in To", () => key(ENDS, 1, "Enter")],
    ["Apply", () => press("Apply")],
    ["reopen", () => click(".copilotz-date-field")],
    ["a day", () => click('[data-day="2026-11-10"]')],
    ["another day, before it", () => click('[data-day="2026-11-03"]')],
    ["Cancel", () => press("Cancel")],
    ["reopen", () => click(".copilotz-date-field")],
    ["a day", () => click('[data-day="2026-11-12"]')],
    ["a day after it", () => click('[data-day="2026-11-14"]')],
    ["Apply", () => press("Apply")],
    ["a preset", () => click(".copilotz-date-preset", 2)],
    ["Custom range", () => press("Custom range")],
    ["next months", () => click(".copilotz-calendar-nav", 1)],
  ];
  const typed = [
    "From after To",
    "From half typed",
    "From wrong",
    "From typed",
    "To typed",
    "To out of bounds",
    "To before From",
  ];
  for (const lang of LANGS) await same({ ...base, max: "2026-12-31" }, steps, lang, typed);
  await same(
    { ...base, format: "yyMMdd" },
    [
      ["open", () => click(".copilotz-date-field")],
      ["From compact", () => type(ENDS, 0, "261112")],
      ["From left", () => blur(ENDS, 0)],
      ["To compact", () => type(ENDS, 1, "261120")],
      ["To left", () => blur(ENDS, 1)],
      ["Apply", () => press("Apply")],
    ],
    "en",
    ["From compact", "To compact"],
  );
  await same(
    { ...base, format: undefined },
    [
      ["open", () => click(".copilotz-date-field")],
      ["From in the language's short date", () => type(ENDS, 0, "11/5/2026")],
      ["From as kept", () => type(ENDS, 0, "2026-11-04")],
      ["From left", () => blur(ENDS, 0)],
      ["Apply", () => press("Apply")],
    ],
    "en",
    ["From in the language's short date", "From as kept"],
  );
});

test("rc.64 parity: ranges with times, their spin fields, and one day", async () => {
  const steps: Step[] = [
    ["open", () => click(".copilotz-date-field")],
    ["From hour", () => type(SPIN, 0, "9")],
    ["From minute up", () => key(SPIN, 1, "ArrowUp")],
    ["To hour home", () => key(SPIN, 2, "Home")],
    ["To minute end", () => key(SPIN, 3, "End")],
    ["To minute digits", () => type(SPIN, 3, "7x")],
    ["To minute left", () => blur(SPIN, 3)],
    ["one day", () => click('[data-day="2026-11-10"]')],
    ["the same day", () => click('[data-day="2026-11-10"]')],
    ["Enter in a time", () => key(SPIN, 0, "Enter")],
    ["Apply", () => press("Apply")],
    ["reopen", () => click(".copilotz-date-field")],
    ["a preset", () => click(".copilotz-date-preset", 0)],
  ];
  for (const lang of LANGS) {
    await same({ ...base, time: true, value: timed }, steps, lang);
  }
  await same({ ...base, time: true, value: timed, format: undefined }, steps, "ar-EG", ["one day"]);
});
