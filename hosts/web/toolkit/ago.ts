/**
 * How long ago a date was, as a list or a message header says it ("5m",
 * "Yesterday", "Oct 12"), or `long`, as a sentence would ("5 minutes ago",
 * "Tuesday"). One still to come says how soon ("in 3h", "Tomorrow", "Nov 14").
 * The words are the app's (`toolkit.minutesAgo`…), the dates the page's language.
 */
import { formatDate } from "../words.ts";
import { say } from "./words.ts";

/** The day of a date further off: "Oct 12", and its year when it isn't this one. */
const day = (date: Date, now: number) =>
  formatDate(date, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });

export function ago(date: Date, now: number = Date.now(), long: boolean = false): string {
  const seconds = (now - date.getTime()) / 1000;
  if (seconds < -45) return ahead(date, now, long);
  if (seconds < 45) return long ? say("justNow") : say("now");
  if (seconds < 3_600) {
    const count = Math.max(1, Math.round(seconds / 60));
    return say(long ? "minutesAgo" : "minutesShort", { count });
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (seconds < 6 * 3_600 || date >= today) {
    const count = Math.floor(seconds / 3_600);
    return say(long ? "hoursAgo" : "hoursShort", { count });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date >= yesterday) return say("yesterday");
  if (seconds < 6 * 86_400) return formatDate(date, { weekday: long ? "long" : "short" });
  return day(date, now);
}

/** How soon `date` comes: within hours, tomorrow, or its day. */
function ahead(date: Date, now: number, long: boolean): string {
  const seconds = (date.getTime() - now) / 1000;
  if (seconds < 3_600) {
    const count = Math.max(1, Math.round(seconds / 60));
    return say(long ? "inMinutes" : "inMinutesShort", { count });
  }
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (seconds < 6 * 3_600 || date < tomorrow) {
    const count = Math.floor(seconds / 3_600);
    return say(long ? "inHours" : "inHoursShort", { count });
  }
  const after = new Date(tomorrow);
  after.setDate(tomorrow.getDate() + 1);
  return date < after ? say("tomorrow") : day(date, now);
}
