/**
 * A field that chooses a day (`DatePicker`) or a range of days
 * (`DateRangePicker`) from a calendar that opens under it. Days are
 * `YYYY-MM-DD`, with no time or zone, shown by the app's own `format` (a
 * pattern, `dd/MM/yyyy`, or a function: never the browser's locale), or the
 * page language's short date without one. `today` is the app's, in its
 * time zone (the page's clock when not given); `min` and `max` bound what
 * can be chosen.
 *
 * A range's popover lists the standard ranges first (`presets`: your own,
 * `true` for the toolkit's, `false` for none), choosing one at once, and
 * two months beside them (one under the other on a phone). The first day
 * picked starts the range and the second ends it; Apply takes it, and
 * Cancel or Escape leaves the value as it was. `rangePresets` makes the
 * standard ranges by name, in an order of the app's, with a fiscal year
 * that starts in any month. A day's popover is one month: picking a day
 * takes it and closes.
 *
 * The field, the presets and the foot take their look from `--date-picker-*`
 * tokens, and the days from the calendar's (`--calendar-*`).
 *
 * ```tsx
 * <DateRangePicker label="Period" value={range} onChange={setRange} today={today} max={today}
 *   format="dd/MM/yyyy" presets={rangePresets(today, { fiscalYearStart: 4, min: "2010-01-01" })} />
 * <DatePicker label="Due" value={due} onChange={setDue} format="d MMM yyyy" />
 * ```
 */
import { type ReactNode, useRef, useState } from "react";
import { Button } from "./button.tsx";
import { Calendar, type DayFormat, formatDay } from "./calendar.tsx";
import { cx } from "./cx.ts";
import {
  addMonth,
  clampRange,
  type DateRange,
  monthOf,
  monthsBetween,
  type Preset,
  presetRange,
  todayIn,
} from "./dates.ts";
import { Popover, type PopoverTrigger } from "./popover.tsx";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

export type { DateRange, DayFormat, Preset };

/** A range a picker offers by name: its words, and its days. */
export type RangePreset = { key?: string; label: string; range: DateRange };

/** The standard ranges a picker offers when given `presets: true`. */
export const STANDARD_PRESETS: Preset[] = [
  "today",
  "yesterday",
  "last7Days",
  "last30Days",
  "thisMonth",
  "lastMonth",
  "thisYear",
  "lastYear",
  "allTime",
];

/**
 * The standard ranges for a today (the app's), in the toolkit's words, by name and in the order
 * given (`keys`; the usual ones by default: see `presetRange`), each kept within `min` and `max`
 * (one wholly outside them is left out). `allTime` runs from `min`, and is left out without it.
 *
 * ```ts
 * rangePresets("2026-11-16", { keys: ["today", "yesterday", "thisFiscalYear"], fiscalYearStart: 4 })
 * ```
 */
export function rangePresets(
  today: string,
  { keys = STANDARD_PRESETS, fiscalYearStart, min, max }: {
    keys?: readonly Preset[];
    fiscalYearStart?: number;
    min?: string;
    max?: string;
  } = {},
): RangePreset[] {
  return keys.flatMap((key) => {
    const whole = presetRange(key, today, { fiscalYearStart, min });
    const range = whole && clampRange(whole, min, max);
    return range ? [{ key, label: say(key), range }] : [];
  });
}

const SHEET = sheet(
  "date-picker",
  `
.copilotz-date-field { display: inline-flex; align-items: center; gap: 8px; min-width: var(--date-picker-width, 0);
  height: var(--date-picker-height, 40px); margin: 0; padding: var(--date-picker-padding, 0 12px);
  border: var(--date-picker-border-width, 1px) solid var(--date-picker-border, var(--input));
  border-radius: var(--date-picker-radius, var(--radius-lg)); background: var(--date-picker-background, var(--card));
  color: var(--date-picker-foreground, var(--foreground)); font-size: var(--date-picker-font-size, 14.5px);
  line-height: 1.2; text-align: left; white-space: nowrap; cursor: pointer;
  transition: border-color .15s, box-shadow .15s; }
.copilotz-date-field-icon { flex: none; color: var(--muted-foreground); }
.copilotz-date-field-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font-variant-numeric: tabular-nums; }
.copilotz-date-field-placeholder { color: var(--muted-foreground); }
.copilotz-date-field:focus-visible, .copilotz-date-field[aria-expanded=true] { outline: none;
  border-color: var(--date-picker-focus-border, var(--ring));
  box-shadow: var(--date-picker-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent)); }
.copilotz-date-field:disabled { opacity: .55; cursor: default; }
.copilotz-date-popover.copilotz-popover { width: auto; padding: var(--date-picker-panel-padding, 12px);
  font-size: var(--date-picker-panel-font-size, 13px); }
.copilotz-date-range { display: flex; align-items: flex-start; gap: var(--date-picker-panel-gap, 16px); }
.copilotz-date-presets { display: grid; align-content: start; gap: var(--date-picker-preset-gap, 2px);
  width: var(--date-picker-presets-width, 180px); margin: 0; padding: 0; list-style: none; }
.copilotz-date-preset { display: flex; align-items: center; width: 100%; min-height: var(--date-picker-preset-height, 32px);
  margin: 0; padding: var(--date-picker-preset-padding, 0 10px); border: 0;
  border-radius: var(--date-picker-preset-radius, var(--radius-md)); background: transparent; color: inherit;
  font: inherit; font-size: var(--date-picker-preset-font-size, 13.5px); text-align: left; cursor: pointer; }
.copilotz-date-preset:hover { background: var(--accent); color: var(--accent-foreground); }
.copilotz-date-preset[aria-pressed=true], .copilotz-date-preset[aria-pressed=true]:hover {
  background: var(--date-picker-preset-active-background, var(--primary-soft));
  color: var(--date-picker-preset-active-foreground, var(--primary-text)); font-weight: 600; }
.copilotz-date-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px;
  margin-top: var(--date-picker-foot-gap, 12px); padding-top: var(--date-picker-foot-gap, 12px);
  border-top: 1px solid var(--border); }
.copilotz-date-foot-text { margin-inline-end: auto; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
/* Phones: the presets over the months, which stack */
@media (max-width: 640px) {
  .copilotz-date-range { flex-direction: column; }
  .copilotz-date-presets { width: 100%; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
}
@media (pointer: coarse) {
  .copilotz-date-field { height: var(--date-picker-height-touch, 44px); }
  .copilotz-date-preset { min-height: var(--date-picker-preset-height-touch, 40px); }
}
`,
);

/** A calendar, drawn as the toolkit's line icons are. */
const GLYPH = (
  <svg
    className="copilotz-icon copilotz-date-field-icon"
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 3v3M17 3v3M6.5 5h11A2.5 2.5 0 0 1 20 7.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-11A2.5 2.5 0 0 1 6.5 5zM4 10h16" />
  </svg>
);

/** The field both pickers open from: what's chosen (or the placeholder), named by its label. */
function Field(
  { trigger, text, placeholder, label, id, disabled, className, onOpen }: {
    trigger: PopoverTrigger;
    text: string;
    placeholder?: string;
    label: string;
    id?: string;
    disabled?: boolean;
    className?: string;
    onOpen(): void;
  },
): ReactNode {
  return (
    <button
      type="button"
      {...trigger}
      id={id}
      disabled={disabled}
      className={cx("copilotz-date-field", className)}
      aria-label={text ? `${label}: ${text}` : label}
      onClick={() => {
        if (!trigger["aria-expanded"]) onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") onOpen();
        trigger.onKeyDown(event);
      }}
    >
      {GLYPH}
      <span className={cx("copilotz-date-field-text", !text && "copilotz-date-field-placeholder")}>
        {text || placeholder}
      </span>
    </button>
  );
}

/** The first of the two months a range shows: its start's, unless its end then wouldn't show. */
function firstMonth(range: { start: string; end?: string }, min?: string, max?: string): string {
  const end = range.end ?? range.start;
  let first = monthsBetween(range.start, end) >= 2
    ? addMonth(monthOf(end), -1)
    : monthOf(range.start);
  if (max && first >= monthOf(max)) first = addMonth(monthOf(max), -1);
  if (min && first < monthOf(min)) first = monthOf(min);
  return first;
}

/** The props both pickers take. */
type Common = {
  /** The app's today, `YYYY-MM-DD` (its time zone's): marked, and what presets count from. */
  today?: string;
  /** How a day shows: a pattern (`dd/MM/yyyy`) or a function; the page language's short date by default. */
  format?: DayFormat;
  min?: string;
  max?: string;
  /** The week's first day: 0 Sunday … 6 Saturday (the page language's by default). */
  weekStart?: number;
  /** Each month's heading in the calendar: a pattern (`MMM yyyy`) or a function. */
  monthFormat?: DayFormat;
  /** What it chooses, said to screen readers (and the popover's name). */
  label?: string;
  /** What the field says with nothing chosen. */
  placeholder?: string;
  /** The field's id. */
  id?: string;
  /** The field's class. */
  className?: string;
  disabled?: boolean;
};

export function DateRangePicker(
  {
    value,
    onChange,
    today: given,
    format,
    min,
    max,
    presets = true,
    separator = " – ",
    weekStart,
    monthFormat,
    label = say("chooseDates"),
    placeholder,
    id,
    className,
    disabled,
  }: Common & {
    value?: DateRange;
    onChange(range: DateRange): void;
    /** The ranges offered beside the months: your own, the toolkit's (`true`), or none. */
    presets?: RangePreset[] | boolean;
    /** Between the two days, in the field and the foot. */
    separator?: string;
  },
): ReactNode {
  const today = given ?? todayIn();
  const panel = useRef<HTMLDivElement>(null);
  const start = value ?? { start: today, end: today };
  const [draft, setDraft] = useState<{ start: string; end?: string }>(start);
  const [month, setMonth] = useState(() => firstMonth(start, min, max));
  const list = presets === true ? rangePresets(today, { min, max }) : presets || [];
  const show = (range: DateRange) =>
    `${formatDay(range.start, format)}${separator}${formatDay(range.end, format)}`;
  const shown = draft.end === undefined
    ? `${formatDay(draft.start, format)}${separator}…`
    : show({ start: draft.start, end: draft.end });
  const active = list.find((p) =>
    p.range.start === draft.start && p.range.end === (draft.end ?? draft.start)
  );
  const open = () => {
    setDraft(start);
    setMonth(firstMonth(start, min, max));
  };
  const pick = (day: string) =>
    setDraft((range) =>
      range.end !== undefined
        ? { start: day }
        : day < range.start
        ? { start: day, end: range.start }
        : { start: range.start, end: day }
    );
  return (
    <>
      {SHEET}
      <Popover
        label={label}
        align="start"
        className="copilotz-date-popover"
        trigger={(trigger) => (
          <Field
            trigger={trigger}
            text={value ? show(value) : ""}
            placeholder={placeholder}
            label={label}
            id={id}
            disabled={disabled}
            className={className}
            onOpen={open}
          />
        )}
      >
        {(close) => (
          <div ref={panel}>
            <div className="copilotz-date-range">
              {list.length
                ? (
                  <ul className="copilotz-date-presets">
                    {list.map((preset) => (
                      <li key={preset.key ?? preset.label}>
                        <button
                          type="button"
                          className="copilotz-date-preset"
                          data-popover-item=""
                          aria-pressed={preset === active}
                          onClick={() => {
                            onChange(preset.range);
                            close();
                          }}
                        >
                          {preset.label}
                        </button>
                      </li>
                    ))}
                    <li>
                      <button
                        type="button"
                        className="copilotz-date-preset"
                        data-popover-item=""
                        aria-pressed={!active}
                        onClick={() =>
                          panel.current?.querySelector<HTMLElement>(
                            ".copilotz-calendar-day[tabindex='0']",
                          )?.focus()}
                      >
                        {say("customRange")}
                      </button>
                    </li>
                  </ul>
                )
                : null}
              <Calendar
                months={2}
                month={month}
                onMonth={setMonth}
                value={draft}
                onPick={pick}
                min={min}
                max={max}
                today={today}
                weekStart={weekStart}
                monthFormat={monthFormat}
                label={label}
              />
            </div>
            <div className="copilotz-date-foot">
              <span className="copilotz-date-foot-text" aria-live="polite">{shown}</span>
              <Button size="sm" onClick={close}>{say("cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={draft.end === undefined}
                onClick={() => {
                  if (draft.end === undefined) return;
                  onChange({ start: draft.start, end: draft.end });
                  close();
                }}
              >
                {say("apply")}
              </Button>
            </div>
          </div>
        )}
      </Popover>
    </>
  );
}

export function DatePicker(
  {
    value,
    onChange,
    today: given,
    format,
    min,
    max,
    weekStart,
    monthFormat,
    label = say("chooseDate"),
    placeholder,
    id,
    className,
    disabled,
  }: Common & {
    value?: string;
    onChange(day: string): void;
  },
): ReactNode {
  const today = given ?? todayIn();
  const [month, setMonth] = useState(() => monthOf(value ?? today));
  return (
    <>
      {SHEET}
      <Popover
        label={label}
        align="start"
        className="copilotz-date-popover"
        trigger={(trigger) => (
          <Field
            trigger={trigger}
            text={value ? formatDay(value, format) : ""}
            placeholder={placeholder}
            label={label}
            id={id}
            disabled={disabled}
            className={className}
            onOpen={() => setMonth(monthOf(value ?? today))}
          />
        )}
      >
        {(close) => (
          <Calendar
            month={month}
            onMonth={setMonth}
            value={value}
            onPick={(day) => {
              onChange(day);
              close();
            }}
            min={min}
            max={max}
            today={today}
            weekStart={weekStart}
            monthFormat={monthFormat}
            label={label}
          />
        )}
      </Popover>
    </>
  );
}
