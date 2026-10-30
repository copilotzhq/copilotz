/**
 * Time, as a caller of Actions. A timer calls an Action with an input when it
 * comes due: once (`at`), or again and again (`cron` in a timezone, or
 * `every` so long). Plugins declare recurring ones (`schedules`); code sets
 * its own at run time (`ctx.schedule`).
 *
 * Every timer is a document in `sys.timers`, written with whatever else its
 * commit writes. The owner keeps one clock armed for the earliest (see
 * timers.ts). This module is the arithmetic: when a timer is due, and next.
 */
import type { Actor } from "./store.ts";
import { Cron } from "croner";

export const TIMERS = "sys.timers";

/** When a run-time timer calls: once at a time, by a cron expression, or every so long. */
export type When =
  | { at: string | number | Date; cron?: never; every?: never; timezone?: never }
  | { cron: string; timezone?: string; at?: never; every?: never }
  | { every: number | string; at?: never; cron?: never; timezone?: never };

/**
 * A declared schedule: an Action to call, with its input, by a cron
 * expression (in a timezone; UTC by default) or every so long. Declared
 * schedules recur: a one-off belongs to the code that wants it (`ctx.schedule`).
 */
export type ScheduleDef =
  & ({ cron: string; timezone?: string; every?: never } | { every: number | string; cron?: never })
  & {
    call: string;
    input?: unknown;
    /** Further attempts when a run fails (2), after 10 s, 30 s, 90 s… */
    retries?: number;
  };

/** A later plugin's change to a declared schedule: fields to set, and `null` to remove one. */
export type SchedulePatch = {
  call?: string;
  input?: unknown;
  cron?: string | null;
  timezone?: string | null;
  every?: number | string | null;
  retries?: number | null;
};

/** What `ctx.schedule` takes besides the Action and its input. */
export type ScheduleOptions = When & {
  /**
   * The timer's id: scheduling the same id again replaces it. By default, one
   * from the call scheduling it and its place among its timers, so a retried
   * call replaces its own timers rather than adding more.
   */
  id?: string;
  retries?: number;
};

/** A timer, as `sys.timers` holds it. */
export type Timer = {
  _id: string;
  call: string;
  input?: unknown;
  cron?: string;
  timezone?: string;
  /** Milliseconds between runs. */
  every?: number;
  /** When it's next due (ISO); none once a one-off has fired. */
  at?: string;
  retries: number;
  /** Declared by a plugin: the owner keeps it as the plugins declare it. */
  declared?: true;
  /** A failed occurrence's next attempt: it calls again as that occurrence, its `_id`. */
  retry?: true;
  /** Occurrences called and maybe not yet finished: the owner looks again after a restart. */
  running?: string[];
  /** Who set it: its occurrences run as them (declared ones as the system). */
  actor?: Actor;
};

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** `every` in milliseconds: a number, or "30s", "15m", "2h", "1d". */
export function interval(every: number | string): number {
  const ms = typeof every === "number" ? every : (() => {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(every).trim());
    return m ? Number(m[1]) * UNITS[m[2]] : NaN;
  })();
  if (!(ms >= 1_000)) throw invalid(`every must be at least a second ("30s", "15m", 60000…)`);
  return ms;
}

const iso = (at: string | number | Date) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw invalid(`Not a time: ${String(at)}`);
  return date.toISOString();
};

/** The next time a cron expression matches, after `from`. */
function cronNext(expression: string, timezone: string | undefined, from: number): number {
  let cron: Cron;
  try {
    // UTC unless told otherwise: the same on every host, whatever its own zone.
    cron = new Cron(expression, { timezone: timezone ?? "UTC", paused: true });
  } catch (error) {
    throw invalid(`Not a cron expression "${expression}": ${(error as Error).message}`);
  }
  const next = cron.nextRun(new Date(from));
  if (!next) throw invalid(`Cron expression "${expression}" never matches again`);
  return next.getTime();
}

/**
 * A timer's document from what was asked, due first at its first time from
 * `now` (a one-off at its own time, even if that's already past).
 */
export function timer(
  id: string,
  call: string,
  input: unknown,
  when: { at?: unknown; cron?: unknown; timezone?: unknown; every?: unknown; retries?: unknown },
  now: number,
): Timer {
  const given = [when.at, when.cron, when.every].filter((v) => v !== undefined).length;
  if (given !== 1) throw invalid("A schedule takes one of `at`, `cron` or `every`");
  if (when.timezone !== undefined && when.cron === undefined) {
    throw invalid("`timezone` goes with `cron`");
  }
  const retries = when.retries ?? 2;
  if (!Number.isInteger(retries) || (retries as number) < 0) {
    throw invalid("`retries` is a whole number of further attempts");
  }
  const base = {
    _id: id,
    call,
    ...(input === undefined ? {} : { input }),
    retries: retries as number,
  };
  if (when.cron !== undefined) {
    const timezone = when.timezone === undefined ? undefined : String(when.timezone);
    return {
      ...base,
      cron: String(when.cron),
      ...(timezone ? { timezone } : {}),
      at: new Date(cronNext(String(when.cron), timezone, now)).toISOString(),
    };
  }
  if (when.every !== undefined) {
    const every = interval(when.every as number | string);
    return { ...base, every, at: new Date(now + every).toISOString() };
  }
  return { ...base, at: iso(when.at as string | number | Date) };
}

/** Whether a timer recurs; a one-off fires once and goes. */
export const recurs = (t: Timer) => t.cron !== undefined || t.every !== undefined;

/**
 * When a recurring timer is due next, after it fired for `due`. Occurrences
 * missed while nothing ran are not made up: it's next due after `now`.
 */
export function following(t: Timer, due: number, now: number): string | undefined {
  if (t.cron !== undefined) {
    return new Date(cronNext(t.cron, t.timezone, Math.max(due, now))).toISOString();
  }
  if (t.every !== undefined) {
    // On its own beat: the first step of `every` from `due` that's after now.
    const steps = Math.max(1, Math.floor((now - due) / t.every) + 1);
    return new Date(due + steps * t.every).toISOString();
  }
  return undefined;
}

/** Whether a declared timer still is what its declaration says (else it's reset to it). */
export const sameSchedule = (a: Timer, b: Timer) =>
  a.call === b.call && JSON.stringify(a.input) === JSON.stringify(b.input) &&
  a.cron === b.cron && a.timezone === b.timezone && a.every === b.every &&
  a.retries === b.retries;

/**
 * The call id of a timer's occurrence: the timer and the time it was due
 * for. A retry calls as the occurrence it retries.
 */
export const occurrence = (t: Timer) => t.retry ? t._id : `${t._id}@${t.at}`;

/** What a call made by time knows of it: its timer, and the time this occurrence was due. */
export type Scheduled = { timer: string; at: string };

/** The timer and due time an occurrence's id names (times hold no `@`). */
export const scheduledOf = (id: string): Scheduled => {
  const split = id.lastIndexOf("@");
  return { timer: id.slice(0, split), at: id.slice(split + 1) };
};

/** How long a failed occurrence waits before its next attempt: 10 s, 30 s, 90 s… up to an hour. */
export const backoff = (attempts: number) => Math.min(10_000 * 3 ** (attempts - 1), 3_600_000);

/**
 * When the owner wakes: a host's own timer, a Durable Object's alarm (which
 * calls `runtime.wake()`), or a test's hand. `wake` may be asked again
 * before an earlier one fires; the owner cancels what it no longer needs.
 */
export type Clock = {
  now(): number;
  /** Calls `fire` at `at` (ms since the epoch), or soon after; the returned function cancels it. */
  wake(at: number, fire: () => void): () => void;
};

/** The clock every process has: `setTimeout`, never keeping the process alive for it. */
export const systemClock: Clock = {
  now: () => Date.now(),
  wake(at, fire) {
    // Long waits wake early and are armed again: timers past ~24 days overflow, and clocks drift.
    const timer = setTimeout(fire, Math.min(Math.max(0, at - Date.now()), 3_600_000));
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    } else if (typeof timer === "number" && g.Deno?.unrefTimer) g.Deno.unrefTimer(timer);
    return () => clearTimeout(timer);
  },
};

/** A clock that moves only when told to: for tests, and for replaying time. */
export function manualClock(start: string | number | Date = 0): Clock & {
  /** Moves time on by `ms`, firing what comes due on the way, in time order. */
  advance(ms: number): void;
  /** Moves time to `at` (never back). */
  set(at: string | number | Date): void;
} {
  let now = new Date(start).getTime();
  const waits = new Set<{ at: number; fire(): void }>();
  const set = (at: number) => {
    now = Math.max(now, at);
    for (;;) {
      const due = [...waits].filter((w) => w.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      waits.delete(due);
      due.fire();
    }
  };
  return {
    now: () => now,
    wake(at, fire) {
      if (at <= now) {
        fire();
        return () => {};
      }
      const wait = { at, fire };
      waits.add(wait);
      return () => waits.delete(wait);
    },
    advance: (ms) => set(now + ms),
    set: (at) => set(new Date(at).getTime()),
  };
}
