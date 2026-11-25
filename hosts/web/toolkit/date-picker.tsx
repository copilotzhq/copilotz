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
 * Over the months, From and To are typed fields in the same format as the
 * field's, read when they're left, on Enter or on Apply: only then does a
 * date move the range and the months shown, and text that isn't a date stays
 * as typed, marked invalid, with Apply off. A field left empty is its end
 * again, and its own text reads as its end. The months open on the range's
 * start. `time` gives each end a time of day too (hours and
 * minutes, like `DateTimePicker`), and the value's ends are then
 * `YYYY-MM-DD HH:mm` (a preset is its days, whole). The foot stays in view
 * when the panel scrolls.
 *
 * `seconds` takes each end to the second, `YYYY-MM-DD HH:mm:ss` (a preset
 * runs from `00:00:00` to `23:59:59`): From and To are then each one typed
 * field of the end's day and time, and the field, the foot, From and To all
 * write the ends by one pattern, which reads them back too. It's `format`
 * when that can be read back (a day's pattern gets the page language's time
 * after it), or else the language's own (`dayTimePattern`). A typed end is
 * kept within `min` and `max`, and within 200 years of `today` (and 0000 to
 * 9999) where they don't bound it.
 *
 * The field, the presets and the foot take their look from `--date-picker-*`
 * tokens, and the days from the calendar's (`--calendar-*`).
 *
 * ```tsx
 * <DateRangePicker label="Period" value={range} onChange={setRange} today={today} max={today}
 *   format="dd/MM/yyyy" presets={rangePresets(today, { fiscalYearStart: 4, min: "2010-01-01" })} />
 * <DatePicker label="Due" value={due} onChange={setDue} format="d MMM yyyy" />
 * <DateRangePicker label="Sales" value={range} onChange={setRange} today={today} seconds
 *   format="dd/MM/yyyy" />
 * ```
 */
import { type ReactNode, useId, useRef, useState } from "react";
import { lang } from "../words.ts";
import { Button } from "./button.tsx";
import { Calendar, type DayFormat, formatDay, parseDay } from "./calendar.tsx";
import { cx } from "./cx.ts";
import {
  addMonth,
  addMonths,
  boundOf,
  clampRange,
  type DateRange,
  dayTimeOf,
  formatPattern,
  isDay,
  isDayTime,
  monthOf,
  monthsBetween,
  partsOf,
  partsOfDayTime,
  type Preset,
  presetRange,
  todayIn,
} from "./dates.ts";
import { type Clock, TimeFields } from "./date-time-picker.tsx";
import { DayTimeField, secondsPatternOf } from "./day-time-field.tsx";
import { FIRST_DAY_TIME, LAST_DAY_TIME, readEnd } from "./day-time-text.ts";
import { Input } from "./input.tsx";
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
  position: sticky; bottom: calc(-1 * var(--date-picker-panel-padding, 12px)); z-index: 1;
  margin: var(--date-picker-foot-gap, 12px) 0 calc(-1 * var(--date-picker-panel-padding, 12px));
  padding: var(--date-picker-foot-gap, 12px) 0 var(--date-picker-panel-padding, 12px);
  border-top: 1px solid var(--border); background: var(--popover); }
.copilotz-date-months { display: grid; gap: var(--date-picker-fields-gap, 10px); min-width: 0; }
.copilotz-date-ends { display: flex; flex-wrap: wrap; align-items: center; gap: var(--date-picker-fields-gap, 10px); }
.copilotz-date-end { display: inline-flex; align-items: center; gap: var(--date-picker-fields-gap, 10px); }
.copilotz-date-end-label { color: var(--muted-foreground); font-weight: 560; }
.copilotz-date-end-input.copilotz-input { width: var(--date-picker-end-width, 9.5em); }
.copilotz-date-end-input.copilotz-input > input { font-variant-numeric: tabular-nums; }
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

/**
 * The first of the two months a range shows: its start's, so a long range opens where it begins.
 * Kept within `min` and `max`; `towards: "end"` shows the end instead when it's out of view.
 */
function firstMonth(
  range: { start: string; end?: string },
  min?: string,
  max?: string,
  towards: "start" | "end" = "start",
): string {
  const end = range.end ?? range.start;
  let first = towards === "end" && monthsBetween(range.start, end) >= 2
    ? addMonth(monthOf(end), -1)
    : monthOf(range.start);
  if (max && first >= monthOf(max)) first = addMonth(monthOf(max), -1);
  if (min && first < monthOf(min)) first = monthOf(min);
  return first;
}

/**
 * A typed day: the day as the field writes it, or what's being typed (`onText`), marked `invalid`
 * while it can't be read. Leaving it, or Enter, commits it (`onCommit`): only then is it read.
 */
function DayField(
  { label, text, invalid, onText, onCommit }: {
    label: string;
    text: string;
    invalid: boolean;
    onText(text: string): void;
    onCommit(): void;
  },
): ReactNode {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="copilotz-date-end-label">{label}</label>
      <Input
        id={id}
        size="sm"
        className="copilotz-date-end-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
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

const START: Clock = { hour: 0, minute: 0 };
const END: Clock = { hour: 23, minute: 59 };
/** A whole day's ends, to the second. */
const START_SECOND: Clock = { hour: 0, minute: 0, second: 0 };
const END_SECOND: Clock = { hour: 23, minute: 59, second: 59 };
/** How far from today a typed end may be, in years, where `min` and `max` don't bound it. */
const REACH = 200;

/**
 * The time of day an end of a value has: its own, or the day's first (or last) minute. To the
 * second (`seconds`), a time kept to the minute is at its `:00`.
 */
const clockOf = (value: string | undefined, whole: Clock, seconds = false): Clock => {
  if (!value || !isDayTime(value)) return whole;
  const { hour, minute, second } = partsOfDayTime(value);
  return { hour, minute, second: seconds ? second ?? 0 : second };
};

/** A bound to the second: a day is all of it, and a time to the minute its first or last second. */
const boundTo = (bound: string | undefined, end: "min" | "max") => {
  const at = boundOf(bound, end, true);
  return at && at.length === 16 ? `${at}:${end === "min" ? "00" : "59"}` : at;
};

/**
 * The earliest and latest ends a range to the second takes: `min` and `max`, and on a side they
 * don't bound, `REACH` years from today, within the years read (0000 to 9999).
 */
function windowOf(today: string, min?: string, max?: string): [low: string, high: string] {
  const [year] = partsOf(today);
  const before = year < REACH ? FIRST_DAY_TIME : `${addMonths(today, -REACH * 12)} 00:00:00`;
  const after = year > 9999 - REACH ? LAST_DAY_TIME : `${addMonths(today, REACH * 12)} 23:59:59`;
  return [boundTo(min, "min") ?? before, boundTo(max, "max") ?? after];
}

/** A range whose start is typed: its end moves to that day if it was before it. */
const fromDay = (range: { start: string; end?: string }, day: string) => ({
  start: day,
  end: range.end !== undefined && range.end < day ? day : range.end,
});

/** A range whose end is typed: its start moves to that day if it was after it. */
const toDay = (range: { start: string; end?: string }, day: string) => ({
  start: day < range.start ? day : range.start,
  end: day,
});

const two = (n: number) => String(n).padStart(2, "0");
const clockText = (c: Clock): string =>
  `${two(c.hour)}:${two(c.minute)}${c.second === undefined ? "" : `:${two(c.second)}`}`;
const secondsOf = (c: Clock): number => c.hour * 3600 + c.minute * 60 + (c.second ?? 0);

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
    time = false,
    seconds = false,
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
    /** Gives each end a time of day: the value's ends are then `YYYY-MM-DD HH:mm`. */
    time?: boolean;
    /**
     * Times to the second: each end is a day and a time, `YYYY-MM-DD HH:mm:ss`, typed whole in
     * From and To and shown whole in the field (a preset runs from `00:00:00` to `23:59:59`). One
     * pattern writes and reads them: `format` when it can be read back (a day's pattern gets the
     * page language's time after it, and a day-time pattern to the minute gets `:ss`), or else the
     * language's (`dayTimePattern`); a pattern that would read an end typed as the toolkit keeps
     * it (`2026-11-02 14:30:05`) as another end is set aside too. What's typed is read when it's
     * left, on Enter or on Apply: only then may it move either end, and while it can't be read, or
     * the range would end before it starts, it's marked and Apply is off. Implies `time`.
     */
    seconds?: boolean;
  },
): ReactNode {
  const today = given ?? todayIn();
  const panel = useRef<HTMLDivElement>(null);
  // To the second, the ends have times, and one pattern shows and reads them.
  const timed = time || seconds;
  const [first, last] = seconds ? [START_SECOND, END_SECOND] : [START, END];
  const locale = lang();
  const pattern = seconds ? secondsPatternOf(format) : undefined;
  // To the second, an end is within its window, typed or picked: the calendar's bounds are the
  // window's days where `min` and `max` aren't given, so it shows no month past 0000 to 9999.
  const [low, high] = pattern ? windowOf(today, min, max) : ["", ""];
  const [dayMin, dayMax] = pattern
    ? [min ?? low.slice(0, 10), max ?? high.slice(0, 10)]
    : [min, max];
  const days = (v?: DateRange) => ({
    start: v?.start.slice(0, 10) ?? today,
    end: v?.end.slice(0, 10) ?? today,
  });
  const clocks = (v?: DateRange) => ({
    from: clockOf(v?.start, first, seconds),
    to: clockOf(v?.end, last, seconds),
  });
  const start = days(value);
  const [draft, setDraft] = useState<{ start: string; end?: string }>(start);
  const [times, setTimes] = useState(() => clocks(value));
  const [month, setMonth] = useState(() => firstMonth(start, dayMin, dayMax));
  // What's typed in From and To is text until it's left, Enter, or Apply: only then is it read,
  // and only then may it move either end. Text typed by one pattern (`by`: the range's to the
  // second, else `format`) isn't read by another.
  const by = `${
    pattern ?? (typeof format === "function" ? String(format) : format)
  }\u0000${locale}`;
  const [typed, setTyped] = useState<{ by?: string; from?: string; to?: string }>({});
  const typing = typed.by === by ? typed : {};
  const offered = presets === true ? rangePresets(today, { min, max }) : presets || [];
  // To the second, a preset whose days aren't real ones (before 0000) isn't offered.
  const list = pattern
    ? offered.filter((p) => isDay(p.range.start) && isDay(p.range.end))
    : offered;
  const written = (day: string, clock: Clock) =>
    pattern
      ? formatPattern(out(day, clock), pattern, locale)
      : time
      ? `${formatDay(day, format)} ${clockText(clock)}`
      : formatDay(day, format);
  const show = (range: DateRange) => {
    const [a, b] = [days(range), clocks(range)];
    return `${written(a.start, b.from)}${separator}${written(a.end, b.to)}`;
  };
  const shown = draft.end === undefined
    ? `${written(draft.start, times.from)}${separator}…`
    : `${written(draft.start, times.from)}${separator}${written(draft.end, times.to)}`;
  const whole = secondsOf(times.from) === 0 && secondsOf(times.to) === secondsOf(last);
  const active = list.find((p) =>
    p.range.start === draft.start && p.range.end === (draft.end ?? draft.start) &&
    (!timed || whole)
  );
  function out(day: string, clock: Clock) {
    // To the second, every end has its seconds, though its clock came from before `seconds` was.
    const second = seconds ? clock.second ?? 0 : clock.second;
    return timed ? dayTimeOf(day, clock.hour, clock.minute, second) : day;
  }
  const give = (start: string, end: string, from: Clock, to: Clock) => {
    // On one day the end can't come before the start.
    const later = timed && start === end && secondsOf(to) < secondsOf(from) ? from : to;
    onChange({ start: out(start, from), end: out(end, later) });
  };
  const open = () => {
    setDraft(start);
    setTimes(clocks(value));
    setMonth(firstMonth(start, dayMin, dayMax));
    setTyped({});
  };
  /** The text a field shows for its end. */
  const ownText = (which: "from" | "to") => {
    const day = which === "from" ? draft.start : draft.end;
    if (day === undefined) return "";
    return pattern
      ? written(day, which === "from" ? times.from : times.to)
      : formatDay(day, format);
  };
  /**
   * An end read from what's typed in a field, within the bounds: its day, and to the second its
   * time (else the end keeps its own); undefined when it can't be read. The field's own text is
   * its end, even where it couldn't be read back (a function format, Arabic's short date).
   */
  const endOf = (
    text: string,
    which: "from" | "to",
  ): { day: string; clock?: Clock } | undefined => {
    if (text.trim() === ownText(which).trim()) {
      const day = which === "from" ? draft.start : draft.end!;
      return { day, clock: pattern ? (which === "from" ? times.from : times.to) : undefined };
    }
    if (pattern) {
      const end = readEnd(text, pattern, locale);
      if (end === undefined || end < low || end > high) return undefined;
      return { day: end.slice(0, 10), clock: clockOf(end, first, true) };
    }
    const day = parseDay(text, format);
    return day !== undefined && (!min || day >= min) && (!max || day <= max) ? { day } : undefined;
  };
  /**
   * The draft with what's typed read as its ends, From first (empty text is none); undefined
   * while some can't be read, or, to the second, when it would end before it starts.
   */
  const withTyped = (texts: { from?: string; to?: string }) => {
    let range: { start: string; end?: string } = draft;
    let clock = times;
    for (const which of ["from", "to"] as const) {
      const text = texts[which];
      if (text === undefined || !text.trim()) continue;
      const end = endOf(text, which);
      if (!end) return undefined;
      range = which === "from" ? fromDay(range, end.day) : toDay(range, end.day);
      if (end.clock) clock = { ...clock, [which]: end.clock };
    }
    const backwards = pattern && range.end !== undefined &&
      out(range.end, clock.to) < out(range.start, clock.from);
    return backwards ? undefined : { range, clock };
  };
  // What's typed in both read together, when it can be: what Apply gives, and what leaving a
  // field takes; else each alone.
  const both = withTyped(typing);
  /**
   * Leaving From or To: left empty, it's its end again. Else what's typed is read, with the other
   * field's text if that reads too, and is the range; text that can't be, stays, marked.
   */
  const commit = (which: "from" | "to") => {
    const text = typing[which];
    if (text === undefined) return;
    if (!text.trim()) return setTyped({ ...typing, by, [which]: undefined });
    const next = both ?? withTyped({ [which]: text });
    if (!next) return;
    setTyped(both ? { by } : { ...typing, by, [which]: undefined });
    setTimes(next.clock);
    setDraft(next.range);
    const day = which === "from" ? next.range.start : next.range.end!;
    if (which === "from") setMonth(firstMonth(next.range, dayMin, dayMax));
    else if (monthOf(day) < month || monthOf(day) > addMonth(month, 1)) {
      setMonth(firstMonth(next.range, dayMin, dayMax, "end"));
    }
  };
  /**
   * A field is marked while what's typed in it can't be its end; To, too, while the range given
   * ends before it starts.
   */
  const marked = (which: "from" | "to") => {
    const text = typing[which];
    if (text === undefined || !text.trim()) {
      return which === "to" && !typing.from?.trim() && !withTyped({});
    }
    return !both && !withTyped({ [which]: text });
  };
  const typeIn = (which: "from" | "to") => (text: string) =>
    setTyped((now) => ({ ...(now.by === by ? now : {}), by, [which]: text }));
  const pick = (day: string) => {
    setTyped({});
    setDraft((range) =>
      range.end !== undefined
        ? { start: day }
        : day < range.start
        ? { start: day, end: range.start }
        : { start: range.start, end: day }
    );
  };
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
                            onChange({
                              start: out(preset.range.start, first),
                              end: out(preset.range.end, last),
                            });
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
              <div className="copilotz-date-months">
                <div className="copilotz-date-ends">
                  {pattern
                    ? (
                      <>
                        <span className="copilotz-date-end">
                          <DayTimeField
                            label={say("rangeFrom")}
                            text={typing.from ?? ownText("from")}
                            invalid={marked("from")}
                            onText={typeIn("from")}
                            onCommit={() => commit("from")}
                          />
                        </span>
                        <span className="copilotz-date-end">
                          <DayTimeField
                            label={say("rangeTo")}
                            text={typing.to ?? ownText("to")}
                            invalid={marked("to")}
                            onText={typeIn("to")}
                            onCommit={() => commit("to")}
                          />
                        </span>
                      </>
                    )
                    : (
                      <>
                        <span className="copilotz-date-end">
                          <DayField
                            label={say("rangeFrom")}
                            text={typing.from ?? ownText("from")}
                            invalid={marked("from")}
                            onText={typeIn("from")}
                            onCommit={() => commit("from")}
                          />
                          {time
                            ? (
                              <TimeFields
                                value={times.from}
                                onChange={(from) => setTimes({ ...times, from })}
                                label={`${say("rangeFrom")}: ${say("time")}`}
                              />
                            )
                            : null}
                        </span>
                        <span className="copilotz-date-end">
                          <DayField
                            label={say("rangeTo")}
                            text={typing.to ?? ownText("to")}
                            invalid={marked("to")}
                            onText={typeIn("to")}
                            onCommit={() => commit("to")}
                          />
                          {time
                            ? (
                              <TimeFields
                                value={times.to}
                                onChange={(to) => setTimes({ ...times, to })}
                                label={`${say("rangeTo")}: ${say("time")}`}
                              />
                            )
                            : null}
                        </span>
                      </>
                    )}
                </div>
                <Calendar
                  months={2}
                  month={month}
                  onMonth={setMonth}
                  value={draft}
                  onPick={pick}
                  min={dayMin}
                  max={dayMax}
                  today={today}
                  weekStart={weekStart}
                  monthFormat={monthFormat}
                  label={label}
                />
              </div>
            </div>
            <div className="copilotz-date-foot">
              <span className="copilotz-date-foot-text" aria-live="polite">{shown}</span>
              <Button size="sm" onClick={close}>{say("cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={both?.range.end === undefined}
                onClick={() => {
                  if (both?.range.end === undefined) return;
                  give(both.range.start, both.range.end, both.clock.from, both.clock.to);
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
