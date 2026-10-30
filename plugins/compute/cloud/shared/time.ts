/** Time, as the cloud plugin reads it: now (or what a test or a timer says it is), hours, waits. */
import type { Context } from "../../../../runtime/mod.ts";

/** Now: what the caller says (a test's `now`), else when the timer was due, else the clock's. */
export const nowOf = (ctx: Pick<Context, "scheduled">, given?: string): string =>
  given ?? ctx.scheduled?.at ?? new Date().toISOString();

export const minutes = (n: number) => n * 60_000;

/** Milliseconds from `a` to `b` (ISO times). */
export const between = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();

/** `at`, `ms` later. */
export const after = (at: string, ms: number) =>
  new Date(new Date(at).getTime() + ms).toISOString();

/** The hour (0–23) it is at `at` in a time zone. */
export function hourIn(at: string, tz = "UTC"): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date(at));
  return Number(hour) % 24;
}

/**
 * Asks `check` every `every` ms until it answers something (not undefined),
 * for at most `ms`: what it answered, or undefined. Stops with `signal`.
 */
export async function poll<T>(
  check: () => Promise<T | undefined>,
  ms: number,
  options: { every?: number; signal?: AbortSignal } = {},
): Promise<T | undefined> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() >= until || options.signal?.aborted) return undefined;
    await new Promise((resolve) => setTimeout(resolve, options.every ?? 250));
  }
}
