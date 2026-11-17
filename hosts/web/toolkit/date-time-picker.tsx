/**
 * A field that chooses a day and a time of it. The field shows them in the
 * app's own `format`: a pattern with the time's letters (`dd/MM/yyyy
 * HH:mm`; see `formatPattern`), or a function of the value; without one,
 * the page language's short date and time, never the browser's locale.
 * Opened, it shows the month and the time: hours and minutes, each a field
 * that takes typed digits and that the arrow keys step (the minutes by
 * `minuteStep`). Picking a day keeps it open, to set the time; Apply (or
 * Enter in the time) takes both, and Cancel or Escape leaves the value as
 * it was.
 *
 * Values are `YYYY-MM-DD HH:mm`: the app's clock time, with no zone, as
 * `LiveClock` writes it. A value with seconds (`YYYY-MM-DD HH:mm:ss`) is
 * read too, and keeps its seconds while the time isn't changed; `seconds`
 * adds a seconds field, and the value then always has them. With none, it opens at the app's now (its
 * `timeZone`'s, or the page's), on `today` when given. `min` and `max` are
 * days or day-times (a day as a bound takes all of it). `name` sends the
 * value with a form, as it's written.
 *
 * Its field and panel take their look from the date pickers' tokens
 * (`--date-picker-*`), the days from the calendar's, and the time's fields
 * from the input's; `--date-time-picker-*` sets the time's own.
 *
 * ```tsx
 * <DateTimePicker label="Opened" value={opened} onChange={setOpened} format="dd/MM/yyyy HH:mm"
 *   timeZone="America/Sao_Paulo" minuteStep={5} name="open_date" />
 * ```
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { formatDateTime, lang } from "../words.ts";
import { Button } from "./button.tsx";
import { Calendar, type DayFormat } from "./calendar.tsx";
import { cx } from "./cx.ts";
import {
  clampDayTime,
  type DayTime,
  dayTimeOf,
  formatPattern,
  isDayTime,
  monthOf,
  nowIn,
  partsOf,
  partsOfDayTime,
} from "./dates.ts";
import { Input } from "./input.tsx";
import { Popover, type PopoverTrigger } from "./popover.tsx";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

export type { DayTime };

/** How a day-time shows: a pattern (`dd/MM/yyyy HH:mm`) or a function of `YYYY-MM-DD HH:mm`. */
export type DayTimeFormat = string | ((value: DayTime) => string);

const SHEET = sheet(
  "date-time-picker",
  `
.copilotz-date-time-field { display: inline-flex; align-items: center; gap: 8px; min-width: var(--date-picker-width, 0);
  height: var(--date-picker-height, 40px); margin: 0; padding: var(--date-picker-padding, 0 12px);
  border: var(--date-picker-border-width, 1px) solid var(--date-picker-border, var(--input));
  border-radius: var(--date-picker-radius, var(--radius-lg)); background: var(--date-picker-background, var(--card));
  color: var(--date-picker-foreground, var(--foreground)); font-size: var(--date-picker-font-size, 14.5px);
  line-height: 1.2; text-align: left; white-space: nowrap; cursor: pointer;
  transition: border-color .15s, box-shadow .15s; }
.copilotz-date-time-field > .copilotz-icon { flex: none; color: var(--muted-foreground); }
.copilotz-date-time-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font-variant-numeric: tabular-nums; }
.copilotz-date-time-placeholder { color: var(--muted-foreground); }
.copilotz-date-time-field:focus-visible, .copilotz-date-time-field[aria-expanded=true] { outline: none;
  border-color: var(--date-picker-focus-border, var(--ring));
  box-shadow: var(--date-picker-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent)); }
.copilotz-date-time-field:disabled { opacity: .55; cursor: default; }
.copilotz-date-time-popover.copilotz-popover { width: auto; padding: var(--date-picker-panel-padding, 12px);
  font-size: var(--date-picker-panel-font-size, 13px); }
.copilotz-date-time-clock { display: flex; align-items: center; gap: var(--date-time-picker-gap, 6px);
  margin-top: var(--date-picker-foot-gap, 12px); }
.copilotz-date-time-fields { display: inline-flex; align-items: center; gap: var(--date-time-picker-gap, 6px); }
.copilotz-date-time-clock-label { margin-inline-end: auto; color: var(--muted-foreground); font-weight: 560; }
.copilotz-date-time-spin.copilotz-input { width: var(--date-time-picker-spin-width, 3.6em); padding: 0;
  justify-content: center; }
.copilotz-date-time-spin.copilotz-input > input { text-align: center; font-variant-numeric: tabular-nums; }
.copilotz-date-time-colon { color: var(--muted-foreground); font-weight: 600; }
.copilotz-date-time-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px;
  margin-top: var(--date-picker-foot-gap, 12px); padding-top: var(--date-picker-foot-gap, 12px);
  border-top: 1px solid var(--border); }
.copilotz-date-time-foot-text { margin-inline-end: auto; color: var(--muted-foreground);
  font-variant-numeric: tabular-nums; }
@media (pointer: coarse) {
  .copilotz-date-time-field { height: var(--date-picker-height-touch, 44px); }
}
`,
);

/** A calendar with a clock's hands, drawn as the toolkit's line icons are. */
const GLYPH = (
  <svg
    className="copilotz-icon"
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
    <path d="M7 3v3M17 3v3M11 20H6.5A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5V10M4 10h16M17 14v3l2 1.5M22 17a5 5 0 1 1-10 0 5 5 0 0 1 10 0z" />
  </svg>
);

const two = (n: number) => String(n).padStart(2, "0");

/** A day-time written by a format: the pattern's, the function's, or the page language's short ones. */
export function formatDayTime(
  value: DayTime,
  format?: DayTimeFormat,
  seconds = false,
): string {
  if (typeof format === "function") return format(value);
  if (format) return formatPattern(value, format, lang());
  const { day, hour, minute, second } = partsOfDayTime(value);
  const [year, month, date] = partsOf(day);
  return formatDateTime(new Date(Date.UTC(year, month - 1, date, hour, minute, second ?? 0)), {
    dateStyle: "short",
    timeStyle: seconds || second !== undefined ? "medium" : "short",
    timeZone: "UTC",
  });
}

/** A field's name for a part of a time (the hour, the minute), in the page's language. */
function partName(part: "hour" | "minute" | "second"): string {
  try {
    return new Intl.DisplayNames([lang()], { type: "dateTimeField" }).of(part) ?? part;
  } catch {
    return part;
  }
}

/**
 * One part of a time, typed or stepped: digits only, at most `max`; the arrows step it by
 * `step` (around the clock), Home and End go to its first and last; Enter applies the picker.
 */
function Spin(
  { value, onChange, max, step, label, onEnter }: {
    value: number;
    onChange(value: number): void;
    max: number;
    step: number;
    label: string;
    onEnter(): void;
  },
): ReactNode {
  const [text, setText] = useState(two(value));
  useEffect(() => setText(two(value)), [value]);
  const span = max + 1;
  const wrap = (n: number) => ((n % span) + span) % span;
  const last = max - (max % step);
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, () => number> = {
      ArrowUp: () => wrap(Math.floor(value / step) * step + step),
      ArrowDown: () => wrap(Math.ceil(value / step) * step - step),
      Home: () => 0,
      End: () => last,
    };
    if (moves[event.key]) {
      event.preventDefault();
      onChange(moves[event.key]());
    } else if (event.key === "Enter") {
      event.preventDefault();
      onEnter();
    }
  };
  return (
    <Input
      size="sm"
      className="copilotz-date-time-spin"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      role="spinbutton"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={two(value)}
      maxLength={2}
      value={text}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, 2);
        setText(digits);
        if (digits !== "" && Number(digits) <= max) onChange(Number(digits));
      }}
      onBlur={() => setText(two(value))}
      onKeyDown={keys}
    />
  );
}

/** A time of day as the pickers hold it: its second is none for a time kept to the minute. */
export type Clock = { hour: number; minute: number; second?: number };

/**
 * A time of day's fields, hours and minutes (and seconds, with `seconds`), each typed or
 * stepped. The date-time picker's, and the range picker's when it takes times.
 */
export function TimeFields(
  { value, onChange, step = 1, seconds = false, label, onEnter }: {
    value: Clock;
    onChange(value: Clock): void;
    /** The minutes' step. */
    step?: number;
    /** Whether it has a seconds field. */
    seconds?: boolean;
    /** What the group is, said to screen readers. */
    label?: string;
    onEnter?(): void;
  },
): ReactNode {
  const enter = onEnter ?? (() => {});
  // Changing the time drops seconds a value had, unless they're shown.
  const kept = seconds ? value.second ?? 0 : undefined;
  return (
    <span className="copilotz-date-time-fields" role="group" aria-label={label}>
      {SHEET}
      <Spin
        value={value.hour}
        onChange={(hour) => onChange({ hour, minute: value.minute, second: kept })}
        max={23}
        step={1}
        label={partName("hour")}
        onEnter={enter}
      />
      <span className="copilotz-date-time-colon" aria-hidden="true">:</span>
      <Spin
        value={value.minute}
        onChange={(minute) => onChange({ hour: value.hour, minute, second: kept })}
        max={59}
        step={step}
        label={partName("minute")}
        onEnter={enter}
      />
      {seconds
        ? (
          <>
            <span className="copilotz-date-time-colon" aria-hidden="true">:</span>
            <Spin
              value={value.second ?? 0}
              onChange={(second) => onChange({ hour: value.hour, minute: value.minute, second })}
              max={59}
              step={1}
              label={partName("second")}
              onEnter={enter}
            />
          </>
        )
        : null}
    </span>
  );
}

export function DateTimePicker(
  {
    value,
    onChange,
    today,
    timeZone,
    format,
    min,
    max,
    minuteStep = 1,
    seconds = false,
    weekStart,
    monthFormat,
    label = say("chooseDateTime"),
    placeholder,
    id,
    name,
    className,
    disabled,
  }: {
    /** The day and time chosen, `YYYY-MM-DD HH:mm`; none shows the placeholder. */
    value?: DayTime;
    onChange(value: DayTime): void;
    /** The app's today, `YYYY-MM-DD`: marked, and where it opens with no value. */
    today?: string;
    /** The app's time zone (IANA): its now is where it opens with no value (the page's otherwise). */
    timeZone?: string;
    /** How it shows: a pattern (`dd/MM/yyyy HH:mm`) or a function; the page language's by default. */
    format?: DayTimeFormat;
    /** The earliest it allows: a day, or a day-time. */
    min?: string;
    /** The latest it allows: a day (all of it), or a day-time. */
    max?: string;
    /** The minutes' step: what the arrows move by, and where a new time starts (1 by default). */
    minuteStep?: number;
    /** Shows a seconds field; the value then always has seconds (`YYYY-MM-DD HH:mm:ss`). */
    seconds?: boolean;
    /** The week's first day: 0 Sunday … 6 Saturday (the page language's by default). */
    weekStart?: number;
    /** The month's heading: a pattern (`MMM yyyy`) or a function of its first day. */
    monthFormat?: DayFormat;
    /** What it chooses, said to screen readers (and the popover's name). */
    label?: string;
    /** What the field says with nothing chosen. */
    placeholder?: string;
    /** The field's id: a `Field`'s label names it. */
    id?: string;
    /** Sends the value with a form, under this name. */
    name?: string;
    /** The field's class. */
    className?: string;
    disabled?: boolean;
  },
): ReactNode {
  const step = Math.max(1, Math.min(30, Math.floor(minuteStep)));
  const start = (): { day: string } & Clock => {
    if (value && isDayTime(value)) {
      const at = partsOfDayTime(value);
      return seconds ? { ...at, second: at.second ?? 0 } : at;
    }
    const now = partsOfDayTime(nowIn(timeZone, step, new Date(), seconds));
    return today ? { ...now, day: today } : now;
  };
  const [draft, setDraft] = useState(start);
  const [month, setMonth] = useState(() => monthOf(draft.day));
  const time = useId();
  const chosen = dayTimeOf(draft.day, draft.hour, draft.minute, draft.second);
  const text = value && isDayTime(value) ? formatDayTime(value, format, seconds) : "";
  const days = { min: min?.slice(0, 10), max: max?.slice(0, 10) };

  const open = () => {
    const at = start();
    setDraft(at);
    setMonth(monthOf(at.day));
  };

  return (
    <>
      {SHEET}
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
      <Popover
        label={label}
        align="start"
        className="copilotz-date-time-popover"
        trigger={(trigger: PopoverTrigger) => (
          <button
            type="button"
            {...trigger}
            id={id}
            disabled={disabled}
            className={cx("copilotz-date-time-field", className)}
            aria-label={text ? `${label}: ${text}` : label}
            onClick={() => {
              if (!trigger["aria-expanded"]) open();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") open();
              trigger.onKeyDown(event);
            }}
          >
            {GLYPH}
            <span
              className={cx("copilotz-date-time-text", !text && "copilotz-date-time-placeholder")}
            >
              {text || placeholder}
            </span>
          </button>
        )}
      >
        {(close) => {
          const apply = () => {
            onChange(clampDayTime(chosen, min, max));
            close();
          };
          return (
            <>
              <Calendar
                month={month}
                onMonth={setMonth}
                value={draft.day}
                onPick={(day) => setDraft({ ...draft, day })}
                min={days.min}
                max={days.max}
                today={today}
                weekStart={weekStart}
                monthFormat={monthFormat}
                label={label}
              />
              <div className="copilotz-date-time-clock" role="group" aria-labelledby={time}>
                <span id={time} className="copilotz-date-time-clock-label">{say("time")}</span>
                <TimeFields
                  value={draft}
                  onChange={(clock) => setDraft({ ...draft, ...clock })}
                  step={step}
                  seconds={seconds}
                  onEnter={apply}
                />
              </div>
              <div className="copilotz-date-time-foot">
                <span className="copilotz-date-time-foot-text" aria-live="polite">
                  {formatDayTime(clampDayTime(chosen, min, max), format, seconds)}
                </span>
                <Button size="sm" onClick={close}>{say("cancel")}</Button>
                <Button size="sm" variant="primary" onClick={apply}>{say("apply")}</Button>
              </div>
            </>
          );
        }}
      </Popover>
    </>
  );
}
