/**
 * The contacts plugin's web lines (the `web` resource): browsers that
 * aren't anyone, coming in as visitors. Each line the app declares, by
 * name, is a front door for them: the space their chats live in, who
 * answers, how long a visitor stays the same one, what they may send and
 * its limits. How the app knows who's calling (`caller`) is the runtime's
 * `CallerSettings`, as MCP's lines take it. `lineOf` gives a line with every
 * default filled in; `problemOf` says what's wrong with one, at start.
 */
import {
  callerProblem,
  type CallerSettings,
  linksOf,
  type Resources,
} from "../../../../runtime/mod.ts";
import type { Keyring } from "./secret.ts";

/** What a line takes before it says no: see `LIMITS`. */
export type WebLimits = {
  /** New visitors from one caller's address an hour: browsers let in, each its cookie. */
  ipVisitorsPerHour: number;
  /** New visitors who speak an hour, on the line: contacts made, at their first message. */
  visitorsPerHour: number;
  /** Messages one visitor sends a minute, and a day. */
  perMinute: number;
  perDay: number;
  /** Messages a minute and a day from one address: every visitor that came in from it. */
  ipPerMinute: number;
  ipPerDay: number;
  /** Messages a minute on the line, all its visitors together. */
  linePerMinute: number;
};

/** Files a visitor may send with a message, when the line takes any: how many, and how large. */
export type WebFiles = {
  /** Files with one message (1 unless said). */
  count?: number;
  /** Bytes each may be (5 MB unless said). */
  bytes?: number;
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
  /**
   * Files its visitors may send (none unless said): `{}` for one of 5 MB a
   * message, or how many and how large.
   */
  files?: WebFiles;
  /**
   * Whether what visitors' audio files say is transcribed for the agent (a
   * model's call, paid): not unless said. Without it, audio goes as it is.
   */
  transcribe?: boolean;
  /** With the orgs host, the org it's for (its id): no other org has it. */
  org?: string;
};

export type WebSettings = {
  lines?: Record<string, WebLine>;
  /**
   * How the app knows who's calling, for the limits by address, when a
   * front before it says (as MCP's lines take it). Without it, a visitor is
   * counted by the address its socket came from, as the web host's listener
   * saw it; with neither, nobody is let in.
   */
  caller?: CallerSettings;
};

/**
 * What a line takes, unless it says. From one address: 20 new visitors an
 * hour (a household, an office behind one address), and 30 messages a
 * minute, 1,000 a day. From one visitor: 10 messages a minute, 200 a day. On
 * the line: 600 new visitors who speak an hour, and 300 messages a minute.
 * Only visitors let in count as new: one coming back with their cookie is
 * no new one; and only those who speak are contacts, counted on the line.
 */
export const LIMITS: WebLimits = {
  ipVisitorsPerHour: 20,
  visitorsPerHour: 600,
  perMinute: 10,
  perDay: 200,
  ipPerMinute: 30,
  ipPerDay: 1_000,
  linePerMinute: 300,
};

/** What a line taking files takes, unless it says: one a message, of 5 MB. */
export const FILES: Required<WebFiles> = { count: 1, bytes: 5_000_000 };

/** The most files a line may take with one message, and the largest each may be. */
const MOST_FILES: Required<WebFiles> = { count: 10, bytes: 10_000_000 };

/** How long a visitor stays the same one, unless the line says: 30 days. */
export const DAYS = 30;

/** A line as the plugin uses it: its settings, its name, and every default filled in. */
export type Line = Omit<WebLine, "limits" | "days" | "files"> & {
  name: string;
  days: number;
  limits: WebLimits;
  /** Files it takes with one message; none: `undefined`. */
  files?: Required<WebFiles>;
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
  const org = orgOf(ctx);
  return Object.fromEntries(
    Object.entries(all).filter(([, line]) => line && (org ? line.org === org : !line.org)),
  );
};

/** The org this runtime is, with the orgs host. */
const orgOf = (ctx: { resources: Resources }) =>
  (ctx.resources.org as { id?: string } | undefined)?.id;

/** The line `name`, ready to use; undefined when the app declares none by that name here. */
export function lineOf(ctx: { resources: Resources }, name: string): Line | undefined {
  const lines = linesOf(ctx);
  const line = Object.hasOwn(lines, name) ? lines[name] : undefined;
  if (!line) return undefined;
  const { files, ...rest } = line;
  return {
    ...rest,
    name,
    days: line.days ?? DAYS,
    limits: { ...LIMITS, ...line.limits },
    ...(files ? { files: { ...FILES, ...files } } : {}),
  };
}

/**
 * What visitors' secrets are signed with here: the app's secret, and the
 * org. Undefined without the app's secret (an app with no web lines): no
 * secret is anyone then.
 */
export function keyringOf(ctx: { resources: Resources }): Keyring | undefined {
  const links = linksOf(ctx.resources);
  if (!links) return undefined;
  const org = orgOf(ctx);
  return { key: links.secret, ...(org ? { org } : {}) };
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
  if (line.files !== undefined) {
    if (!line.files || typeof line.files !== "object") return "its files are { count?, bytes? }";
    for (const [key, value] of Object.entries(line.files)) {
      if (!(key in FILES)) return `files.${key} isn't one: count, bytes`;
      const most = MOST_FILES[key as keyof WebFiles];
      if (!(Number.isInteger(value) && (value as number) > 0 && (value as number) <= most)) {
        return `files.${key} is a whole number over 0, ${most} at most`;
      }
    }
  }
  if (line.transcribe !== undefined && typeof line.transcribe !== "boolean") {
    return "its transcribe is true or false";
  }
  return undefined;
}

/** What's wrong with the web lines' settings, if anything (checked when the app starts). */
export function settingsProblem(resources: Resources): string | undefined {
  const caller = callerProblem(settingsOf({ resources }).caller);
  if (caller) return `web.${caller}`;
  const lines = Object.entries(linesOf({ resources }));
  for (const [name, line] of lines) {
    const problem = problemOf(name, line, resources);
    if (problem) return `web.lines.${name} ${problem}`;
  }
  // Visitors' secrets are signed with the app's secret: nothing is kept when a page comes in.
  if (lines.length && !linksOf(resources)) {
    return "web.lines need the app's secret, which visitors' cookies are signed with: " +
      "the links resource ({ origin, secret })";
  }
  return undefined;
}
