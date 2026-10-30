/**
 * A schedule, picked: how often (every day, weekdays, some days, every few
 * hours, once, or cron for experts), at what time, on which days, in which
 * timezone (the person's own first), and under it what that says ("Weekdays
 * at 9:00 AM") and when the next three runs are, from the same arithmetic
 * that will run it; what's wrong instead, when something is.
 */
import { type ReactNode, useId, useMemo } from "react";
import { Icon, Input, Select } from "../../../../../hosts/web/mod.ts";
import {
  describe,
  KINDS,
  localZone,
  moment,
  nextRuns,
  normalize,
  type Schedule,
  zoneName,
  zones,
} from "../../shared/schedule.ts";
import { DAYS, EVERY, givenOf, KIND_NAMES, type Picking } from "./routines.ts";

/** What the picker says now: the schedule it makes, or what's wrong. */
export function scheduleOf(p: Picking, now = Date.now()): Schedule | { problem: string } {
  try {
    return normalize(givenOf(p), now);
  } catch (error) {
    return { problem: (error as Error).message };
  }
}

export function SchedulePicker(
  { value, onChange, disabled }: {
    value: Picking;
    onChange(patch: Partial<Picking>): void;
    disabled?: boolean;
  },
): ReactNode {
  const id = useId();
  const here = localZone();
  const all = useMemo(() => zones(here), [here]);
  const made = scheduleOf(value);
  const bad = "problem" in made;
  const runs = bad ? [] : nextRuns(made, { count: 3 });
  const timed = value.kind === "daily" || value.kind === "weekdays" || value.kind === "weekly";
  const zoned = value.kind !== "hours";
  return (
    <div className="picker" role="group" aria-labelledby={`${id}-when`}>
      <span id={`${id}-when`} className="routine-label">When</span>
      <div className="picker-kinds" role="radiogroup" aria-label="How often">
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            className="picker-kind"
            aria-checked={value.kind === kind}
            disabled={disabled}
            onClick={() => onChange({ kind })}
          >
            {KIND_NAMES[kind]}
          </button>
        ))}
      </div>
      {value.kind === "weekly"
        ? (
          <div className="picker-days" role="group" aria-label="On which days">
            {DAYS.map((d) => {
              const on = value.days.includes(d.day);
              return (
                <button
                  key={d.day}
                  type="button"
                  className="picker-day"
                  aria-pressed={on}
                  aria-label={d.name}
                  title={d.name}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      days: on
                        ? value.days.filter((x) => x !== d.day)
                        : [...value.days, d.day].sort((a, b) => a - b),
                    })}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
        )
        : null}
      <div className="picker-row">
        {timed
          ? (
            <label className="picker-time">
              At
              <Input
                type="time"
                value={value.time}
                disabled={disabled}
                required
                onChange={(event) => onChange({ time: event.target.value })}
              />
            </label>
          )
          : null}
        {value.kind === "hours"
          ? (
            <span className="picker-every">
              Every
              <Select
                aria-label="How many hours"
                value={String(value.every)}
                disabled={disabled}
                onChange={(event) => onChange({ every: Number(event.target.value) })}
              >
                {EVERY.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
              {value.every === 1 ? "hour" : "hours"}, from when it's saved
            </span>
          )
          : null}
        {value.kind === "once"
          ? (
            <label className="picker-at">
              On
              <Input
                type="datetime-local"
                value={value.at}
                disabled={disabled}
                required
                onChange={(event) => onChange({ at: event.target.value })}
              />
            </label>
          )
          : null}
        {value.kind === "cron"
          ? (
            <label className="picker-cron">
              Cron expression
              <Input
                value={value.cron}
                spellCheck={false}
                autoComplete="off"
                placeholder="0 9 * * 1-5"
                disabled={disabled}
                onChange={(event) => onChange({ cron: event.target.value })}
              />
            </label>
          )
          : null}
        {zoned
          ? (
            <label className="picker-zone">
              Timezone
              <Select
                value={value.timezone}
                disabled={disabled}
                onChange={(event) => onChange({ timezone: event.target.value })}
              >
                {all.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone === "UTC" ? "UTC" : zone.replace(/_/g, " ")}
                    {zone === here ? " (yours)" : ""}
                  </option>
                ))}
              </Select>
            </label>
          )
          : null}
      </div>
      {value.kind === "cron"
        ? (
          <p className="picker-help">
            Five fields: <code>minute hour day month weekday</code>. <code>0 9 * * 1-5</code>{" "}
            is weekdays at 9:00; <code>30 8 1 * *</code> the 1st of each month at 8:30.
          </p>
        )
        : null}
      <div className="picker-says" data-bad={bad || undefined} aria-live="polite">
        <p className="picker-says-what">
          <Icon name={bad ? "alert" : "refresh"} size={15} />
          {bad ? made.problem : describe(made, { here })}
        </p>
        {runs.length
          ? (
            <ul className="picker-says-next" aria-label="Its next runs">
              {runs.map((at, i) => (
                <li key={i}>
                  {i === 0 ? "Next: " : ""}
                  {moment(at, zoned ? value.timezone : here)}
                </li>
              ))}
            </ul>
          )
          : null}
        {!bad && zoned && value.timezone !== here && runs.length
          ? (
            <p className="picker-help">
              In {zoneName(value.timezone)} time; that's {moment(runs[0], here)} where you are.
            </p>
          )
          : null}
      </div>
    </div>
  );
}
