/**
 * The contacts plugin's web lines (the `web` resource): browsers that
 * aren't anyone, coming in as visitors. Each line the app declares, by
 * name, is a front door for them: the space their chats live in, who
 * answers, how long a visitor stays the same one, and its limits. How the
 * app knows who's calling (`caller`) is the runtime's `CallerSettings`, as
 * MCP's lines take it. `lineOf` gives a line with every default filled in;
 * `problemOf` says what's wrong with one, at start.
 */
import { callerProblem, type CallerSettings, type Resources } from "../../../../runtime/mod.ts";

/** What a line takes before it says no: see `LIMITS`. */
export type WebLimits = {
  /** New visitors the line takes an hour, all together. */
  visitorsPerHour: number;
  /** New visitors from one caller's address an hour (see `caller`). */
  ipVisitorsPerHour: number;
};

/** A web line the app declares: a front door for anyone with a browser. */
export type WebLine = {
  /**
   * The space its visitors' chats live in: one the app declares too (the
   * spaces plugin's `spaces` resource) is made and kept with the line.
   */
  in: string;
  /** Who answers its visitors (an agent's name); else whoever answers new chats in the space. */
  agent?: string;
  /** What its visitors' chats are called, as the space's people see them (the line's name). */
  title?: string;
  /** How long a visitor stays the same one (their browser's cookie), in days: 30. */
  days?: number;
  limits?: Partial<WebLimits>;
  /** With the orgs host, the org it's for (its id): no other org has it. */
  org?: string;
};

export type WebSettings = {
  lines?: Record<string, WebLine>;
  /** How the app knows who's calling, for the limits by address; without it, none goes by address. */
  caller?: CallerSettings;
};

/**
 * What a line takes, unless it says: 600 new visitors an hour, and 20 from
 * one address (a household, an office behind one address). Only visitors
 * let in count; one coming back with their cookie is no new one.
 */
export const LIMITS: WebLimits = { visitorsPerHour: 600, ipVisitorsPerHour: 20 };

/** How long a visitor stays the same one, unless the line says: 30 days. */
export const DAYS = 30;

/** A line as the plugin uses it: its settings, its name, and every default filled in. */
export type Line = Omit<WebLine, "limits" | "days"> & {
  name: string;
  days: number;
  limits: WebLimits;
};

export const settingsOf = (ctx: { resources: Resources }): WebSettings =>
  (ctx.resources.web ?? {}) as WebSettings;

/**
 * The app's own lines, by name, here: with the orgs host (each org's runtime
 * knows its org, `resources.org`), only those that name this org; a line
 * naming none is the single-org app's.
 */
export const linesOf = (ctx: { resources: Resources }): Record<string, WebLine> => {
  const all = settingsOf(ctx).lines ?? {};
  const org = (ctx.resources.org as { id?: string } | undefined)?.id;
  return Object.fromEntries(
    Object.entries(all).filter(([, line]) => line && (org ? line.org === org : !line.org)),
  );
};

/** The line `name`, ready to use; undefined when the app declares none by that name here. */
export function lineOf(ctx: { resources: Resources }, name: string): Line | undefined {
  const lines = linesOf(ctx);
  const line = Object.hasOwn(lines, name) ? lines[name] : undefined;
  if (!line) return undefined;
  return { ...line, name, days: line.days ?? DAYS, limits: { ...LIMITS, ...line.limits } };
}

/** What's wrong with a line's settings, if anything (checked when the app starts). */
export function problemOf(name: string, line: WebLine, resources: Resources): string | undefined {
  if (!/^[\w-]{1,60}$/.test(name)) return "its name is letters, digits, - and _";
  if (typeof line?.in !== "string" || !line.in) return "needs its in (the space its chats live in)";
  if (line.agent !== undefined) {
    if (typeof line.agent !== "string" || !Object.hasOwn(resources.agents ?? {}, line.agent)) {
      return `its agent "${line.agent}" isn't one of the app's agents`;
    }
  }
  if (line.title !== undefined && (typeof line.title !== "string" || !line.title.trim())) {
    return "its title is some text";
  }
  if (
    line.days !== undefined && !(typeof line.days === "number" && line.days > 0 && line.days <= 400)
  ) {
    return "its days are a number over 0, 400 at most (as long as browsers keep a cookie)";
  }
  for (const [key, value] of Object.entries(line.limits ?? {})) {
    if (!(key in LIMITS)) return `limits.${key} isn't a limit`;
    if (!(Number.isInteger(value) && (value as number) > 0)) {
      return `limits.${key} is a whole number over 0`;
    }
  }
  return undefined;
}

/** What's wrong with the web lines' settings, if anything (checked when the app starts). */
export function settingsProblem(resources: Resources): string | undefined {
  const caller = callerProblem(settingsOf({ resources }).caller);
  if (caller) return `web.${caller}`;
  for (const [name, line] of Object.entries(linesOf({ resources }))) {
    const problem = problemOf(name, line, resources);
    if (problem) return `web.lines.${name} ${problem}`;
  }
  return undefined;
}
