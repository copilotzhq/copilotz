/**
 * Routines as their web front end says them: each one's page and its
 * space's tab, how it stands (set to run, paused, done, failing, or unable
 * to run as its maker), what a schedule picker starts with and keeps, the
 * examples an empty tab teaches with, and a routine as a form holds it.
 * Pure, so tested.
 */
import type { Listed } from "../../collections/routine.ts";
import { type Given, type Kind, localOf, type Schedule } from "../../shared/schedule.ts";

/** A routine's page, where the person is; `edit`, open to change it. */
export { routinePath } from "../../shared/routines.ts";

/** A chat, where its space is. */
export const threadPath = (thread: string, space?: string) =>
  `/thread/${encodeURIComponent(thread)}${space ? `?in=${encodeURIComponent(space)}` : ""}`;

/** A space's Routines tab. */
export const routinesTab = (space: string) => `/space/${encodeURIComponent(space)}?tab=routines`;

/** How a routine stands, said in a word, with a tone. */
export type Standing = {
  key: "left" | "paused" | "done" | "failing" | "set";
  label: string;
  tone: "neutral" | "success" | "warning" | "destructive" | "info";
};

export function standingOf(r: Pick<Listed, "left" | "paused" | "next" | "last">): Standing {
  if (r.left) return { key: "left", label: "Can't run", tone: "destructive" };
  if (r.paused) return { key: "paused", label: "Paused", tone: "neutral" };
  if (!r.next) return { key: "done", label: "Done", tone: "neutral" };
  if (r.last && r.last.outcome !== "sent") {
    return { key: "failing", label: "Last run failed", tone: "warning" };
  }
  return { key: "set", label: "On", tone: "success" };
}

/** A schedule as the picker holds it: every field any kind takes, so switching kinds keeps them. */
export type Picking = {
  kind: Kind;
  time: string;
  days: number[];
  every: number;
  /** A wall-clock time in `timezone`, as a `datetime-local` field takes it. */
  at: string;
  cron: string;
  timezone: string;
};

/** Tomorrow at nine, where the person is: what a once starts with. */
const tomorrowAtNine = (zone: string, now: number) =>
  `${localOf(now + 86_400_000, zone).slice(0, 10)}T09:00`;

/** What the picker starts with: a schedule's fields, or every weekday at nine where they are. */
export function picking(zone: string, from?: Schedule, now = Date.now()): Picking {
  const base: Picking = {
    kind: "weekdays",
    time: "09:00",
    days: [1],
    every: 4,
    at: tomorrowAtNine(zone, now),
    cron: "0 9 * * 1-5",
    timezone: zone,
  };
  if (!from) return base;
  switch (from.kind) {
    case "daily":
    case "weekdays":
      return { ...base, kind: from.kind, time: from.time, timezone: from.timezone };
    case "weekly":
      return { ...base, kind: "weekly", days: from.days, time: from.time, timezone: from.timezone };
    case "hours":
      return { ...base, kind: "hours", every: from.every };
    case "once":
      return {
        ...base,
        kind: "once",
        at: localOf(from.at, from.timezone),
        timezone: from.timezone,
      };
    case "cron":
      return { ...base, kind: "cron", cron: from.cron, timezone: from.timezone };
  }
}

/** The schedule the picker says, as `routine.create` takes it. */
export function givenOf(p: Picking): Given {
  switch (p.kind) {
    case "daily":
    case "weekdays":
      return { kind: p.kind, time: p.time, timezone: p.timezone };
    case "weekly":
      return { kind: "weekly", days: p.days, time: p.time, timezone: p.timezone };
    case "hours":
      return { kind: "hours", every: p.every };
    case "once":
      return { kind: "once", at: p.at, timezone: p.timezone };
    case "cron":
      return { kind: "cron", cron: p.cron, timezone: p.timezone };
  }
}

/** A routine as a form holds it. */
export type Draft = {
  name: string;
  text: string;
  agent: string;
  post: "new" | "same";
  chatName?: string;
};

/** An example an empty tab offers: what it would send, when. */
export type Example = {
  name: string;
  text: string;
  when: Partial<Picking> & { kind: Kind };
  /** Says when, as the card shows it. */
  said: string;
};

export const EXAMPLES: Example[] = [
  {
    name: "Morning briefing",
    text: "What's new in our market since yesterday? Three short bullets, with sources.",
    when: { kind: "weekdays", time: "09:00" },
    said: "Weekdays at 9:00",
  },
  {
    name: "Plan the week",
    text: "Help me plan this week: the three things that matter most, and what can wait.",
    when: { kind: "weekly", days: [1], time: "08:30" },
    said: "Mondays at 8:30",
  },
  {
    name: "Check in",
    text: "Anything waiting on me here? Sum up what changed since you last looked.",
    when: { kind: "hours", every: 4 },
    said: "Every 4 hours",
  },
];

/** Days of the week, Sunday first, as their toggles say them. */
export const DAYS = [
  { day: 0, short: "S", name: "Sunday" },
  { day: 1, short: "M", name: "Monday" },
  { day: 2, short: "T", name: "Tuesday" },
  { day: 3, short: "W", name: "Wednesday" },
  { day: 4, short: "T", name: "Thursday" },
  { day: 5, short: "F", name: "Friday" },
  { day: 6, short: "S", name: "Saturday" },
];

/** How many hours "every few hours" offers. */
export const EVERY = [1, 2, 3, 4, 6, 8, 12, 24];

/** The kinds, as the picker names them. */
export const KIND_NAMES: Record<Kind, string> = {
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Some days",
  hours: "Every few hours",
  once: "Once",
  cron: "Cron",
};
