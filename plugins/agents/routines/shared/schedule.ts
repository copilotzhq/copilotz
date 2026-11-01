/**
 * When a routine runs, as people say it: every day at a time, on weekdays,
 * on some days of the week, every few hours, once, or by a cron expression
 * for experts; each at a time in a timezone. From it: the runtime's timer
 * (`whenOf`), the next runs (`nextRuns`, by the runtime's own cron library,
 * so the preview is what will happen), and the words for it (`describe`:
 * "Weekdays at 9:00 AM"). Pure, for the Actions, the tools and the browser.
 */
import { Cron } from "croner";
import type { When } from "../../../../runtime/mod.ts";
import { invalid } from "../../../../runtime/mod.ts";

export type Schedule =
  | { kind: "daily"; time: string; timezone: string }
  | { kind: "weekdays"; time: string; timezone: string }
  /** `days`: 0 (Sunday) to 6. */
  | { kind: "weekly"; days: number[]; time: string; timezone: string }
  /** `every` so many hours, from when it was set. */
  | { kind: "hours"; every: number }
  /** `at`: the instant (ISO); `timezone`, how it's shown. */
  | { kind: "once"; at: string; timezone: string }
  | { kind: "cron"; cron: string; timezone: string };

export type Kind = Schedule["kind"];
export const KINDS: Kind[] = ["daily", "weekdays", "weekly", "hours", "once", "cron"];

/** A schedule, as Actions and tools take it (`normalize` makes it a `Schedule`). */
export const scheduleSchema = {
  type: "object",
  properties: {
    kind: { enum: KINDS },
    /** "09:00": for daily, weekdays and weekly. */
    time: { type: "string" },
    /** For weekly: 0 (Sunday) to 6 (Saturday). */
    days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, maxItems: 7 },
    /** For hours: how many. */
    every: { type: "integer", minimum: 1, maximum: 168 },
    /** For once: "2026-11-03T09:00" in `timezone`, or an instant with its offset. */
    at: { type: "string" },
    /** For cron: five fields, minute hour day month weekday. */
    cron: { type: "string", maxLength: 120 },
    /** An IANA timezone ("Europe/Lisbon"); UTC when none is given. */
    timezone: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

/** A schedule as given: any of its fields, checked by `normalize`. */
export type Given = {
  kind: Kind;
  time?: string;
  days?: number[];
  every?: number;
  at?: string;
  cron?: string;
  timezone?: string;
};

const HOUR = 3_600_000;

/** Whether a timezone is one this platform knows. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const clockOf = (time: string) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : undefined;
};

/** "9:05" as a schedule keeps it: "09:05". */
const tidy = (time: string) => {
  const c = clockOf(time)!;
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
};

/** The parts of an instant's wall clock in `zone`. */
function wall(at: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    }).formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

/** The instant a wall-clock time in `zone` is ("2026-11-03T09:00" in Lisbon). */
export function instantOf(local: string, zone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map((part) => Number(part ?? 0));
  const wanted = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wanted;
  // The zone's offset at that time, found by asking what the guess reads as (twice, for DST).
  for (let i = 0; i < 3; i++) {
    const seen = wall(guess, zone);
    const read = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    if (read === wanted) break;
    guess += wanted - read;
  }
  return guess;
}

/** An instant as a wall-clock time in `zone`, the way a `datetime-local` field takes it. */
export function localOf(at: string | number, zone: string): string {
  const w = wall(new Date(at).getTime(), zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}`;
}

/** The cron expression a schedule that keeps a time is (all but `hours` and `once`). */
export function cronOf(s: Schedule): string | undefined {
  if (s.kind === "cron") return s.cron;
  if (s.kind === "hours" || s.kind === "once") return undefined;
  const { hour, minute } = clockOf(s.time)!;
  const days = s.kind === "daily" ? "*" : s.kind === "weekdays" ? "1-5" : s.days.join(",");
  return `${minute} ${hour} * * ${days}`;
}

const cronIn = (expression: string, zone: string) =>
  new Cron(expression, { timezone: zone, paused: true });

/**
 * A schedule as given, checked and completed: its timezone (UTC when none
 * is given), its time as "09:00", its days in order, a once's time as an
 * instant. Throws `invalid` saying what's wrong; `now` says what's past.
 */
export function normalize(given: Given, now = Date.now()): Schedule {
  const zone = given.timezone?.trim() || "UTC";
  if (!knownZone(zone)) throw invalid(`"${zone}" isn't a timezone (try "Europe/Lisbon").`);
  const time = () => {
    if (!given.time || !clockOf(given.time)) {
      throw invalid('Say at what time, as "09:00" (24-hour clock).');
    }
    return tidy(given.time);
  };
  switch (given.kind) {
    case "daily":
    case "weekdays":
      return { kind: given.kind, time: time(), timezone: zone };
    case "weekly": {
      const days = [...new Set(given.days ?? [])].filter((d) =>
        Number.isInteger(d) && d >= 0 && d < 7
      )
        .sort((a, b) => a - b);
      if (!days.length) throw invalid("Pick at least one day of the week.");
      return { kind: "weekly", days, time: time(), timezone: zone };
    }
    case "hours": {
      const every = given.every ?? 0;
      if (!Number.isInteger(every) || every < 1 || every > 168) {
        throw invalid("Every 1 to 168 hours.");
      }
      return { kind: "hours", every };
    }
    case "once": {
      const at = given.at?.trim() ?? "";
      const instant = /[zZ]|[+-]\d{2}:?\d{2}$/.test(at) ? Date.parse(at) : instantOf(at, zone);
      if (!Number.isFinite(instant)) {
        throw invalid('Say when, as "2026-11-03T09:00" in its timezone.');
      }
      if (instant <= now) throw invalid("That time has passed: pick one still to come.");
      return { kind: "once", at: new Date(instant).toISOString(), timezone: zone };
    }
    case "cron": {
      const cron = given.cron?.trim().replace(/\s+/g, " ") ?? "";
      if (cron.split(" ").length !== 5) {
        throw invalid("A cron expression has five fields: minute hour day month weekday.");
      }
      let next: Date | null;
      try {
        next = cronIn(cron, zone).nextRun(new Date(now));
      } catch (error) {
        throw invalid(`That cron expression doesn't read: ${(error as Error).message}.`);
      }
      if (!next) throw invalid("That cron expression never comes round again.");
      return { kind: "cron", cron, timezone: zone };
    }
    default:
      throw invalid(`A schedule is one of ${KINDS.join(", ")}.`);
  }
}

/** The runtime's timer for a schedule (`ctx.schedule`). */
export function whenOf(s: Schedule): When {
  if (s.kind === "hours") return { every: s.every * HOUR };
  if (s.kind === "once") return { at: s.at };
  return { cron: cronOf(s)!, timezone: s.timezone };
}

/**
 * The next `count` runs after `from`. An `hours` schedule keeps the beat it
 * started on (`since`, when it was set); a `once` has one run, until it's past.
 */
export function nextRuns(
  s: Schedule,
  { from = Date.now(), count = 3, since }: { from?: number; count?: number; since?: string } = {},
): Date[] {
  if (s.kind === "once") {
    const at = Date.parse(s.at);
    return at > from ? [new Date(at)] : [];
  }
  if (s.kind === "hours") {
    const every = s.every * HOUR;
    const start = since ? Date.parse(since) : from;
    const k = from < start ? 1 : Math.floor((from - start) / every) + 1;
    return Array.from({ length: count }, (_, i) => new Date(start + (k + i) * every));
  }
  try {
    return cronIn(cronOf(s)!, s.timezone).nextRuns(count, new Date(from));
  } catch {
    return [];
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "9:00 AM", as the reader's locale writes a time of day. */
export function clockText(time: string, locale?: string): string {
  const c = clockOf(time);
  if (!c) return time;
  return new Date(Date.UTC(2020, 0, 1, c.hour, c.minute)).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Names in a sentence: "a", "a and b", "a, b and c". */
const listed = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * How many times a day it runs, when that's at least hourly (a new chat each
 * run gets to be a lot of chats); otherwise undefined.
 */
export function oftenPerDay(s: Schedule, from = Date.now()): number | undefined {
  const [first, second] = nextRuns(s, { from, count: 2 });
  if (!first || !second) return undefined;
  const gap = second.getTime() - first.getTime();
  return gap > 0 && gap <= HOUR ? Math.round(24 * HOUR / gap) : undefined;
}

/** A timezone, as a place: "Sao Paulo" for America/Sao_Paulo, UTC as UTC. */
export const zoneName = (zone: string) =>
  zone === "UTC" ? "UTC" : (zone.split("/").at(-1) ?? zone).replace(/_/g, " ");

/** An instant, as its day and time in `zone`: "Mon, Nov 3, 9:00 AM". */
export function moment(at: Date | string | number, zone: string, locale?: string): string {
  const date = new Date(at);
  // The day, then the time: platforms join the two differently ("at", ","), so it's said once here.
  return `${
    date.toLocaleDateString(locale, {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  }, ${date.toLocaleTimeString(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" })}`;
}

/** A cron expression a friendlier kind says as well, as that kind; else undefined. */
export function friendlier(cron: string, timezone: string): Schedule | undefined {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== "*" || f[3] !== "*") return undefined;
  if (!/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || Number(f[0]) > 59 || Number(f[1]) > 23) {
    return undefined;
  }
  const time = `${f[1].padStart(2, "0")}:${f[0].padStart(2, "0")}`;
  if (f[4] === "*") return { kind: "daily", time, timezone };
  if (f[4] === "1-5") return { kind: "weekdays", time, timezone };
  if (/^[0-7](,[0-7])*$/.test(f[4])) {
    const days = [...new Set(f[4].split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b);
    return { kind: "weekly", days, time, timezone };
  }
  return undefined;
}

/**
 * A schedule in words: "Every day at 9:00 AM", "Weekdays at 9:00 AM",
 * "Mondays and Thursdays at 5:30 PM", "Every 3 hours", "Once, on Mon, Nov
 * 3, 9:00 AM". The timezone is named unless it's the reader's (`here`).
 */
export function describe(
  s: Schedule,
  { locale, here }: { locale?: string; here?: string } = {},
): string {
  const zone = "timezone" in s && s.timezone !== here ? ` (${zoneName(s.timezone)} time)` : "";
  switch (s.kind) {
    case "daily":
      return `Every day at ${clockText(s.time, locale)}${zone}`;
    case "weekdays":
      return `Weekdays at ${clockText(s.time, locale)}${zone}`;
    case "weekly": {
      const at = clockText(s.time, locale);
      if (s.days.length === 7) return `Every day at ${at}${zone}`;
      if (s.days.join() === "1,2,3,4,5") return `Weekdays at ${at}${zone}`;
      if (s.days.join() === "0,6") return `Weekends at ${at}${zone}`;
      return `${listed(s.days.map((d) => `${DAYS[d]}s`))} at ${at}${zone}`;
    }
    case "hours":
      return s.every === 1 ? "Every hour" : `Every ${s.every} hours`;
    case "once":
      return `Once, on ${moment(s.at, s.timezone, locale)}${zone}`;
    case "cron": {
      const friendly = friendlier(s.cron, s.timezone);
      return friendly ? describe(friendly, { locale, here }) : `On a custom schedule${zone}`;
    }
  }
}

/** The timezones this platform knows, the reader's own and UTC first. */
export function zones(here = localZone()): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?(key: string): string[] })
      .supportedValuesOf?.("timeZone") ?? [];
  } catch { /* Older platforms know only theirs and UTC. */ }
  return [...new Set([here, "UTC", ...all])];
}

/** The reader's own timezone. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * When a run comes, shortly: "in 12 minutes", "in 3 hours" within the next
 * twelve; then "Tomorrow, 9:00 AM", "Mon, 9:00 AM", or "Nov 12, 9:00 AM",
 * in `zone`.
 */
export function soon(at: Date, zone: string, { now = Date.now(), locale }: {
  now?: number;
  locale?: string;
} = {}): string {
  const ms = at.getTime() - now;
  if (ms < 60_000) return "in a moment";
  if (ms < HOUR) {
    const minutes = Math.round(ms / 60_000);
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms < 12 * HOUR) {
    const hours = Math.round(ms / HOUR);
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const time = at.toLocaleTimeString(locale, {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  });
  const day = (ms: number) => {
    const w = wall(ms, zone);
    return Date.UTC(w.year, w.month - 1, w.day);
  };
  const days = Math.round((day(at.getTime()) - day(now)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days < 7) {
    return `${at.toLocaleDateString(locale, { timeZone: zone, weekday: "short" })}, ${time}`;
  }
  return `${
    at.toLocaleDateString(locale, { timeZone: zone, month: "short", day: "numeric" })
  }, ${time}`;
}
