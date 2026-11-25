/**
 * An end of a range to the second (`DateRangePicker` with `seconds`): one field holding the end's
 * day and time, written by the range's pattern and read back by it as it's typed. Text it can't
 * read, or an end outside the range's bounds, is marked and changes nothing; leaving the field
 * writes the end again. Its width is `--date-picker-end-time-width`.
 */
import { type ReactNode, useEffect, useId, useState } from "react";
import { lang } from "../words.ts";
import { type DayTime, formatPattern } from "./dates.ts";
import { rangeSecondsPattern, readEnd } from "./day-time-text.ts";
import { Input } from "./input.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "date-range-seconds",
  `
.copilotz-date-end-input.copilotz-date-end-time.copilotz-input { width: var(--date-picker-end-time-width, 15em); }
`,
);

const warned = new Set<string>();

/**
 * The pattern a range to the second shows and reads its ends by, in the page's language (see
 * `rangeSecondsPattern`); a `format` set aside is said once, on the console, with why.
 */
export function secondsPatternOf(format: unknown): string {
  const locale = lang();
  const { pattern, setAside } = rangeSecondsPattern(format, locale);
  const given = typeof format === "string" ? `the format "${format}"` : "a function format";
  const id = `${given}\u0000${locale}`;
  if (setAside && !warned.has(id)) {
    warned.add(id);
    console.warn(
      `DateRangePicker: ${given} can't be read back in ${locale} (${setAside}); with seconds, ` +
        `its ends show and read as "${pattern}"`,
    );
  }
  return pattern;
}

/**
 * A range's end to the second, typed: its day and time written by `pattern` in the page's
 * language, read back as it's typed (`readEnd`), and handed to `onEnd` when it's within `low` and
 * `high`. What `DateRangePicker` shows as From and To with `seconds`.
 */
export function DayTimeField(
  { label, value, pattern, low, high, onEnd }: {
    label: string;
    /** The end, `YYYY-MM-DD HH:mm:ss`; none while the range's second end is being picked. */
    value?: DayTime;
    pattern: string;
    /** The earliest and latest ends it takes, `YYYY-MM-DD HH:mm:ss`. */
    low: string;
    high: string;
    onEnd(value: DayTime): void;
  },
): ReactNode {
  const id = useId();
  const locale = lang();
  const written = value ? formatPattern(value, pattern, locale) : "";
  const [text, setText] = useState(written);
  const [bad, setBad] = useState(false);
  // An end set elsewhere (the calendar, the other field) is written; one being typed stays as typed.
  useEffect(() => {
    if (!text || readEnd(text, pattern, locale) !== value) {
      setText(written);
      setBad(false);
    }
  }, [value, written]);
  return (
    <>
      {SHEET}
      <label htmlFor={id} className="copilotz-date-end-label">{label}</label>
      <Input
        id={id}
        size="sm"
        className="copilotz-date-end-input copilotz-date-end-time"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={text}
        invalid={bad}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const next = event.target.value;
          const typed = readEnd(next, pattern, locale);
          const fits = typed !== undefined && typed >= low && typed <= high;
          setText(next);
          setBad(!fits && next.trim() !== "");
          if (fits) onEnd(typed);
        }}
        onBlur={() => {
          setText(written);
          setBad(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
    </>
  );
}
