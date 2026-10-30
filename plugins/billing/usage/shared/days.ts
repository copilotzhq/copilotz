/**
 * Days, as the ledger's times name them: the first ten characters of an ISO
 * time (`2026-10-27`), so a day is a UTC day.
 */

/** A day's name: `YYYY-MM-DD`. */
export const DAY = "^\\d{4}-\\d{2}-\\d{2}$";

export const dayOf = (at: string): string => at.slice(0, 10);

/** The day `n` days after (or before) `day`. */
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

const isDay = (value: string) => new RegExp(DAY).test(value.slice(0, 10));

/**
 * The first day all of whose times are at or after `bound` (as strings
 * compare: every time in day `d` sorts after `${d}T`), or undefined when the
 * bound isn't a time.
 */
export function firstWholeDay(bound: string): string | undefined {
  if (!isDay(bound)) return undefined;
  const day = dayOf(bound);
  return `${day}T` >= bound ? day : addDays(day, 1);
}

/** The last day all of whose times are before `bound` (they sort before `${d}U`). */
export function lastWholeDay(bound: string): string | undefined {
  if (!isDay(bound)) return undefined;
  const day = dayOf(bound);
  return `${day}U` <= bound ? day : addDays(day, -1);
}
