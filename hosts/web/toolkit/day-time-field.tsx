/**
 * An end of a range to the second (`DateRangePicker` with `seconds`): one field holding the end's
 * day and time as text. What's typed is only text until it's committed, on leaving the field or
 * Enter (or the range's Apply): the range reads it then, and marks it while it can't be read.
 * Its width is `--date-picker-end-time-width`.
 */
import { type ReactNode, useId } from "react";
import { lang } from "../words.ts";
import { rangeSecondsPattern } from "./day-time-text.ts";
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
 * A range's end to the second, typed: the end as the range's pattern writes it, or what's being
 * typed (`onText`), marked `invalid` while it can't be read as an end. Leaving it, or Enter,
 * commits it (`onCommit`). What `DateRangePicker` shows as From and To with `seconds`.
 */
export function DayTimeField(
  { label, text, invalid, onText, onCommit }: {
    label: string;
    /** What the field holds: the end as the pattern writes it, or what's being typed. */
    text: string;
    /** Whether what's typed can't be read as an end within the range's bounds. */
    invalid: boolean;
    onText(text: string): void;
    /** Leaving the field, or Enter: what's typed becomes the end, if it can be read. */
    onCommit(): void;
  },
): ReactNode {
  const id = useId();
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
        invalid={invalid}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => onText(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onCommit();
        }}
      />
    </>
  );
}
