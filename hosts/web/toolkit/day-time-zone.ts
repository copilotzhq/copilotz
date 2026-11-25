/**
 * The moment a day-time names in a time zone: what a timestamp to store, or a report's range to
 * compare stored timestamps with, needs from the app's clock time. One rule where the clocks
 * change, wherever the zone comes from (Temporal's "compatible"): a time they skip moves forward
 * by the gap, a time they repeat is its first pass.
 *
 * ```ts
 * dateOfDayTime("2026-11-16 14:30", "America/Sao_Paulo")?.toISOString(); // "2026-11-16T17:30:00.000Z"
 * dateOfDayTime("2026-03-08 02:30", "America/New_York")?.toISOString(); // "2026-03-08T07:30:00.000Z"
 * ```
 */
import { isDay, isDayTime, partsOf, partsOfDayTime } from "./dates.ts";

const DAY = 86_400_000;

const clocks = new Map<string, Intl.DateTimeFormat>();

/** A zone's clock: its wall time, era and all, so year 0 is 1 BC. Throws for a zone `Intl` doesn't know. */
function clockOf(zone: string): Intl.DateTimeFormat {
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    clocks.set(zone, clock);
  }
  return clock;
}

/** A wall time, in milliseconds as if it were UTC. */
function wallMs(year: number, month: number, day: number, h: number, m: number, s: number) {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(h, m, s, 0);
  return at.getTime();
}

/** What a named zone's clock shows at an instant, as `wallMs` writes it. */
function wallAt(zone: string, ms: number): number {
  const parts: Record<string, string> = {};
  for (const { type, value } of clockOf(zone).formatToParts(new Date(ms))) parts[type] = value;
  const year = /^B/.test(parts.era) ? 1 - Number(parts.year) : Number(parts.year);
  return wallMs(
    year,
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * What the page's own clock (the process's) shows at an instant, as `Date` reads it: its zone may
 * have no IANA name `Intl` reads alike (`TZ=GMT+3` is three hours behind UTC by POSIX's sign, and
 * `Intl` may read it as ahead).
 */
function localWallAt(ms: number): number {
  const at = new Date(ms);
  return wallMs(
    at.getFullYear(),
    at.getMonth() + 1,
    at.getDate(),
    at.getHours(),
    at.getMinutes(),
    at.getSeconds(),
  );
}

/**
 * The moment a day-time (or a day, at 00:00:00) is in a time zone (IANA: `America/Sao_Paulo`;
 * the page's when none is given), as a `Date`: for a timestamp to store, or the ends of a report's
 * range to compare stored timestamps with. `dateOfDayTime("2026-11-16 14:30", "America/Sao_Paulo")`
 * is `2026-11-16T17:30:00.000Z`.
 *
 * Where the clocks change, one rule, Temporal's "compatible": a time they skip moves forward by
 * the gap (02:30 on the night New York springs forward is 03:30 there, `07:30Z`), and a time they
 * repeat is its first pass (01:30 on the night New York falls back is `05:30Z`, not `06:30Z`).
 * It's what `new Date(y, m - 1, d, h, mi, s)` does in the page's zone, and a named zone and the
 * page's own follow it alike. With no zone, the page's clock is read as `Date` reads it, so a
 * zone set the POSIX way (`TZ=GMT+3`, `EST5EDT`) is the one `Date` uses. Years are 0000 to 9999.
 * `undefined` when the value isn't a day (`YYYY-MM-DD`) or a day-time (`YYYY-MM-DD HH:mm`,
 * `YYYY-MM-DD HH:mm:ss`); a zone `Intl` doesn't know throws its `RangeError`.
 */
export function dateOfDayTime(value: string, timeZone?: string): Date | undefined {
  const timed = isDayTime(value);
  if (!timed && !isDay(value)) return undefined;
  const [year, month, day] = partsOf(value);
  const { hour, minute, second = 0 } = timed ? partsOfDayTime(value) : { hour: 0, minute: 0 };
  const wall = wallMs(year, month, day, hour, minute, second);
  const clock = timeZone === undefined ? localWallAt : (ms: number) => wallAt(timeZone, ms);
  // The zone's offsets a day either side: one, or the two a change of the clocks is between.
  const before = clock(wall - DAY) - (wall - DAY);
  const after = clock(wall + DAY) - (wall + DAY);
  const shown = [wall - before, wall - after].filter((at) => clock(at) === wall);
  // A time the clock shows: its first instant. A skipped one: by the offset before the change.
  return new Date(shown.length ? Math.min(...shown) : wall - before);
}
