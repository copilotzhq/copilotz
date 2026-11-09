/**
 * Due dates (`YYYY-MM-DD`) against today: how many days away one is, and
 * today as a day where the reader is (the browser's own zone; the server's
 * clock for agents). Pure.
 */

/** Today, as `YYYY-MM-DD`, in the local zone. */
export const todayOf = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${
    String(now.getDate()).padStart(2, "0")
  }`;

/** Days from `today` to `due`: 0 today, 1 tomorrow, -2 two days ago. */
export const daysUntil = (due: string, today: string) =>
  Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/** A due date as an agent reads it: "due 2026-11-02 (in 4 days)", "overdue since 2026-10-27". */
export function dueSaid(due: string, today: string, done = false): string {
  const days = daysUntil(due, today);
  if (done) return `was due ${due}`;
  if (days < 0) return `overdue: was due ${due} (${-days} day${days === -1 ? "" : "s"} ago)`;
  if (days === 0) return `due today (${due})`;
  if (days === 1) return `due tomorrow (${due})`;
  return `due ${due} (in ${days} days)`;
}
