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
 * field's: a valid date moves the range and the months shown, and text that
 * isn't a date marks the field invalid and changes nothing. The months open
 * on the range's start. `time` gives each end a time of day too (hours and
 * minutes, like `DateTimePicker`), and the value's ends are then
 * `YYYY-MM-DD HH:mm` (a preset is its days, whole); `seconds` takes the
 * times to the second, `YYYY-MM-DD HH:mm:ss` (a preset runs from `00:00:00`
 * to `23:59:59`). With a time, From and To also read a whole day and time
 * typed in the format (`16/11/2026 14:30:05`), and `format` may be a
 * day-time pattern (`dd/MM/yyyy HH:mm:ss`), which writes each end whole.
 * The foot stays in view when the panel scrolls.
 *
 * The field, the presets and the foot take their look from `--date-picker-*`
 * tokens, and the days from the calendar's (`--calendar-*`).
 *
 * ```tsx
 * <DateRangePicker label="Period" value={range} onChange={setRange} today={today} max={today}
 *   format="dd/MM/yyyy" presets={rangePresets(today, { fiscalYearStart: 4, min: "2010-01-01" })} />
 * <DatePicker label="Due" value={due} onChange={setDue} format="d MMM yyyy" />
 * <DateRangePicker label="Report" value={range} onChange={setRange} format="dd/MM/yyyy HH:mm:ss"
 *   seconds />
 * ```
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { lang } from "../words.ts";
import { Button } from "./button.tsx";
import { Calendar, type DayFormat, formatDay, parseDay, shortPattern } from "./calendar.tsx";
import { cx } from "./cx.ts";
import {
  addMonth,
  clampRange,
  type DateRange,
  dayPatternOf,
  dayTimeOf,
  formatPattern,
  hasTime,
  isDayTime,
  monthOf,
  monthsBetween,
  parseDayTime,
  partsOfDayTime,
  type Preset,
  presetRange,
  todayIn,
} from "./dates.ts";
import { type Clock, TimeFields } from "./date-time-picker.tsx";
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

/** What an end's field reads from typed text: a day, and a time of it when one was typed. */
type Typed = { day: string; clock?: Clock };

/**
 * A typed end: its day as the field writes it, read back as it's typed; with `timed`, a whole day
 * and time typed (`16/11/2026 14:30:05`) is read too, by `dayTime` (a pattern, or the language's
 * short date and time). Wrong text is marked and changes nothing.
 */
function DayField(
  { label, day, format, dayTime, timed = false, min, max, onDay }: {
    label: string;
    day?: string;
    format?: DayFormat;
    /** How a whole day and time is typed: a pattern, or the page language's. */
    dayTime?: string;
    timed?: boolean;
    min?: string;
    max?: string;
    onDay(day: string, clock?: Clock): void;
  },
): ReactNode {
  const id = useId();
  const written = day ? formatDay(day, format) : "";
  const [text, setText] = useState(written);
  const [bad, setBad] = useState(false);
  const read = (typed: string): Typed | undefined => {
    const only = parseDay(typed, format);
    if (only || !timed) return only ? { day: only } : undefined;
    const at = parseDayTime(typed, dayTime, lang()) ??
      (dayTime === undefined ? parseDayTime(typed, `${shortPattern()} HH:mm`, lang()) : undefined);
    return at ? { day: at.slice(0, 10), clock: clockOf(at, START) } : undefined;
  };
  // A day chosen elsewhere (the calendar, a preset) is written; the one being typed stays as typed.
  useEffect(() => {
    if (!text || read(text)?.day !== day) {
      setText(written);
      setBad(false);
    }
  }, [day, written]);
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
        invalid={bad}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const next = event.target.value;
          const typed = read(next);
          const fits = typed !== undefined && (!min || typed.day >= min) &&
            (!max || typed.day <= max);
          setText(next);
          setBad(!fits && next.trim() !== "");
          if (fits) onDay(typed.day, typed.clock);
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

const START: Clock = { hour: 0, minute: 0 };
const END: Clock = { hour: 23, minute: 59 };
/** A whole day's ends, to the second. */
const START_SECOND: Clock = { hour: 0, minute: 0, second: 0 };
const END_SECOND: Clock = { hour: 23, minute: 59, second: 59 };

/**
 * The time of day an end of a value has: its own, or the day's first (or last) minute. To the
 * second (`seconds`), a time kept to the minute is at its `:00`.
 */
const clockOf = (value: string | undefined, whole: Clock, seconds = false): Clock => {
  if (!value || !isDayTime(value)) return whole;
  const { hour, minute, second } = partsOfDayTime(value);
  return { hour, minute, second: seconds ? second ?? 0 : second };
};

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
    /**
     * Gives each end a time of day: the value's ends are then `YYYY-MM-DD HH:mm`. `format` may then
     * be a day-time pattern (`dd/MM/yyyy HH:mm`), which writes each end whole.
     */
    time?: boolean;
    /**
     * Times to the second (and a time with it): each end's time has a seconds field, and the
     * value's ends are `YYYY-MM-DD HH:mm:ss`; a preset runs from `00:00:00` to `23:59:59`.
     */
    seconds?: boolean;
  },
): ReactNode {
  const today = given ?? todayIn();
  const panel = useRef<HTMLDivElement>(null);
  const timed = time || seconds;
  const [first, last] = seconds ? [START_SECOND, END_SECOND] : [START, END];
  // A day-time pattern writes each end whole; its day alone is what From and To show.
  const whole = typeof format === "string" && hasTime(format) ? format : undefined;
  const dayFormat = whole ? dayPatternOf(whole) : format;
  const dayTime = whole ?? (typeof format === "string" ? `${format} HH:mm:ss` : undefined);
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
  const [month, setMonth] = useState(() => firstMonth(start, min, max));
  const list = presets === true ? rangePresets(today, { min, max }) : presets || [];
  const written = (day: string, clock: Clock) =>
    !timed
      ? formatDay(day, dayFormat)
      : whole
      ? formatPattern(dayTimeOf(day, clock.hour, clock.minute, clock.second), whole, lang())
      : `${formatDay(day, dayFormat)} ${clockText(clock)}`;
  const show = (range: DateRange) => {
    const [a, b] = [days(range), clocks(range)];
    return `${written(a.start, b.from)}${separator}${written(a.end, b.to)}`;
  };
  const shown = draft.end === undefined
    ? `${written(draft.start, times.from)}${separator}…`
    : `${written(draft.start, times.from)}${separator}${written(draft.end, times.to)}`;
  const allDay = secondsOf(times.from) === 0 && secondsOf(times.to) === secondsOf(last);
  const active = list.find((p) =>
    p.range.start === draft.start && p.range.end === (draft.end ?? draft.start) &&
    (!timed || allDay)
  );
  const out = (day: string, clock: Clock) =>
    timed ? dayTimeOf(day, clock.hour, clock.minute, clock.second) : day;
  const give = (start: string, end: string, from: Clock, to: Clock) => {
    // On one day the end can't come before the start.
    const later = timed && start === end && secondsOf(to) < secondsOf(from) ? from : to;
    onChange({ start: out(start, from), end: out(end, later) });
  };
  const open = () => {
    setDraft(start);
    setTimes(clocks(value));
    setMonth(firstMonth(start, min, max));
  };
  // A time typed to the minute, in a picker to the second, is at its `:00`.
  const kept = (clock: Clock): Clock => seconds ? { ...clock, second: clock.second ?? 0 } : clock;
  const typedFrom = (day: string, clock?: Clock) => {
    const range = { start: day, end: draft.end !== undefined && draft.end < day ? day : draft.end };
    setDraft(range);
    if (clock) setTimes((now) => ({ ...now, from: kept(clock) }));
    setMonth(firstMonth(range, min, max));
  };
  const typedTo = (day: string, clock?: Clock) => {
    const range = { start: day < draft.start ? day : draft.start, end: day };
    setDraft(range);
    if (clock) setTimes((now) => ({ ...now, to: kept(clock) }));
    const second = addMonth(month, 1);
    if (monthOf(day) < month || monthOf(day) > second) {
      setMonth(firstMonth(range, min, max, "end"));
    }
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
                  <span className="copilotz-date-end">
                    <DayField
                      label={say("rangeFrom")}
                      day={draft.start}
                      format={dayFormat}
                      dayTime={dayTime}
                      timed={timed}
                      min={min}
                      max={max}
                      onDay={typedFrom}
                    />
                    {timed
                      ? (
                        <TimeFields
                          value={times.from}
                          onChange={(from) => setTimes({ ...times, from })}
                          seconds={seconds}
                          label={`${say("rangeFrom")}: ${say("time")}`}
                        />
                      )
                      : null}
                  </span>
                  <span className="copilotz-date-end">
                    <DayField
                      label={say("rangeTo")}
                      day={draft.end}
                      format={dayFormat}
                      dayTime={dayTime}
                      timed={timed}
                      min={min}
                      max={max}
                      onDay={typedTo}
                    />
                    {timed
                      ? (
                        <TimeFields
                          value={times.to}
                          onChange={(to) => setTimes({ ...times, to })}
                          seconds={seconds}
                          label={`${say("rangeTo")}: ${say("time")}`}
                        />
                      )
                      : null}
                  </span>
                </div>
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
                  give(draft.start, draft.end, times.from, times.to);
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
