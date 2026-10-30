/**
 * How long ago a date was, as a list or a message header says it ("5m",
 * "Yesterday", "Oct 12"), or `long`, as a sentence would ("5 minutes ago",
 * "Tuesday"). One still to come says how soon ("in 3h", "Tomorrow", "Nov 14").
 */

/** "5 minutes", "1 hour": a count of something, in words. */
const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The day of a date further off: "Oct 12", and its year when it isn't this one. */
const day = (date: Date, now: number) =>
  date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });

export function ago(date: Date, now = Date.now(), long = false): string {
  const seconds = (now - date.getTime()) / 1000;
  if (seconds < -45) return ahead(date, now, long);
  if (seconds < 45) return long ? "just now" : "now";
  if (seconds < 3_600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return long ? `${count(minutes, "minute")} ago` : `${minutes}m`;
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (seconds < 6 * 3_600 || date >= today) {
    const hours = Math.floor(seconds / 3_600);
    return long ? `${count(hours, "hour")} ago` : `${hours}h`;
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date >= yesterday) return "Yesterday";
  if (seconds < 6 * 86_400) {
    return date.toLocaleDateString(undefined, { weekday: long ? "long" : "short" });
  }
  return day(date, now);
}

/** How soon `date` comes: within hours, tomorrow, or its day. */
function ahead(date: Date, now: number, long: boolean): string {
  const seconds = (date.getTime() - now) / 1000;
  if (seconds < 3_600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return long ? `in ${count(minutes, "minute")}` : `in ${minutes}m`;
  }
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (seconds < 6 * 3_600 || date < tomorrow) {
    const hours = Math.floor(seconds / 3_600);
    return long ? `in ${count(hours, "hour")}` : `in ${hours}h`;
  }
  const after = new Date(tomorrow);
  after.setDate(tomorrow.getDate() + 1);
  return date < after ? "Tomorrow" : day(date, now);
}
