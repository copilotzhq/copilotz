/**
 * The web sites (the `web` resource, a flat map by name): browsers that
 * aren't anyone, coming in as visitors. Each site the app declares is a
 * front door for them: the space their chats live in, who answers, how
 * long a visitor stays the same one, what they may send and its limits.
 * How the app knows who's calling is the runtime's `caller` resource
 * (`CallerSettings`), as MCP's servers take it. `siteOf` gives a site with
 * every default filled in; `problemOf` says what's wrong with one, at start.
 */
import {
  callerOf,
  callerProblem,
  linksOf,
  type Resources,
  secretsOf,
} from "../../../../runtime/mod.ts";
import type { Keyring } from "./secret.ts";

/**
 * What a site takes before it says no: see `LIMITS`. Those by address hold
 * for each network a visitor came from (`networksOf`): its address (IPv4) or
 * /64 (IPv6) as they say, and wider ones, as many callers' worth as each
 * counts (`SCALE`: an IPv4 /24 eight; an IPv6 /56 four, a /48 eight).
 */
export type WebLimits = {
  /**
   * New visitors from one address an hour: browsers let in, each its cookie;
   * and as many who speak for the first time, an hour (so visitors let in
   * over days can't all start at once).
   */
  ipVisitorsPerHour: number;
  /** New visitors who speak an hour, on the site: contacts made, at their first message. */
  visitorsPerHour: number;
  /** Messages one visitor sends a minute, and a day. */
  perMinute: number;
  perDay: number;
  /** Messages a minute and a day from one address: every visitor that came in from it. */
  ipPerMinute: number;
  ipPerDay: number;
  /** Messages a minute on the site, all its visitors together. */
  linePerMinute: number;
  /**
   * Of those, what visitors who hadn't spoken before this minute may send:
   * the rest of `linePerMinute` is kept for those who had, so a burst of
   * newcomers never stops a conversation going on.
   */
  newcomersPerMinute: number;
};

/** Files a visitor may send with a message, when the site takes any: how many, and how large. */
export type WebFiles = {
  /** Files with one message (1 unless said). */
  count?: number;
  /** Bytes each may be (5 MB unless said). */
  bytes?: number;
};

/** A site the app declares: a front door for anyone with a browser. */
export type DeclaredSite = {
  /**
   * The space its visitors' chats live in: one the app declares too (the
   * spaces plugin's `spaces` resource) is made and kept with the site.
   */
  in: string;
  /** Who answers its visitors (an agent's name); else whoever answers new chats in the space. */
  agent?: string;
  /** What its visitors' chats are called, as the space's people see them (the site's name). */
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
  /**
   * What its visitors' model use may be charged a day (UTC), in the usage
   * ledger's prices (the app's currency): what the turns working for them
   * cost, as the usage plugin rates it. Past it, its visitors' messages
   * wait for the next day. None: no budget. Needs the usage plugin.
   */
  budget?: number;
  /**
   * An Action of the app's that a newcomer must pass to be let in (a
   * CAPTCHA's check: Turnstile's, hCaptcha's): asked as the system with
   * `{ line, answer }`, where `answer` is what the page sent coming in
   * (`web({ arrive: { line, challenge } })`'s `challenge`), it answers true
   * to let them in. One back with its cookie isn't asked again.
   */
  challenge?: string;
};

/**
 * The `web` resource: the declared sites, by name. For the limits by
 * address, the app's `caller` resource says how it knows who's calling
 * when a front before it says; without it, a visitor is counted by the
 * address its socket came from, as the web host's listener saw it; with
 * neither, nobody is let in.
 */
export type WebSettings = Record<string, DeclaredSite>;

/**
 * What a site takes, unless it says. From one address: 20 new visitors an
 * hour (a household, an office behind one address), and 30 messages a
 * minute, 1,000 a day; its wider networks as many times that as they count
 * (an IPv6 /48: 160 new visitors an hour, 240 messages a minute). From one
 * visitor: 10 messages a minute, 200 a day. On the site: 600 new visitors
 * who speak an hour, and 300 messages a minute, of which newcomers (those
 * who hadn't spoken before the minute) send 200 at most. Only visitors let
 * in count as new: one coming back with their cookie is no new one; and only
 * those who speak are contacts, counted on the site.
 */
export const LIMITS: WebLimits = {
  ipVisitorsPerHour: 20,
  visitorsPerHour: 600,
  perMinute: 10,
  perDay: 200,
  ipPerMinute: 30,
  ipPerDay: 1_000,
  linePerMinute: 300,
  newcomersPerMinute: 200,
};

/** What a site taking files takes, unless it says: one a message, of 5 MB. */
export const FILES: Required<WebFiles> = { count: 1, bytes: 5_000_000 };

/** The most files a site may take with one message, and the largest each may be. */
const MOST_FILES: Required<WebFiles> = { count: 10, bytes: 10_000_000 };

/** How long a visitor stays the same one, unless the site says: 30 days. */
export const DAYS = 30;

/** The longest a site may keep a visitor the same one, as long as browsers keep a cookie. */
export const MOST_DAYS = 400;

/** A site as the plugin uses it: its settings, its name, and every default filled in. */
export type Site = Omit<DeclaredSite, "limits" | "days" | "files"> & {
  name: string;
  days: number;
  limits: WebLimits;
  /** Files it takes with one message; none: `undefined`. */
  files?: Required<WebFiles>;
};

/** The sites the app declares, by name. */
export const sitesOf = (ctx: { resources: Resources }): WebSettings =>
  Object.fromEntries(
    Object.entries((ctx.resources.web ?? {}) as WebSettings).filter(([, site]) => site),
  );

/** The org this runtime is, with the orgs host. */
const orgOf = (ctx: { resources: Resources }) =>
  (ctx.resources.org as { id?: string } | undefined)?.id;

/** The site `name`, ready to use; undefined when the app declares none by that name. */
export function siteOf(ctx: { resources: Resources }, name: string): Site | undefined {
  const sites = sitesOf(ctx);
  const line = Object.hasOwn(sites, name) ? sites[name] : undefined;
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
 * What visitors' secrets are signed with here: the app's secret (and the
 * one before it, `links.previous`, while it's given), and the org. Undefined
 * without the app's secret (an app with no web sites): no secret is anyone
 * then.
 */
export function keyringOf(ctx: { resources: Resources }): Keyring | undefined {
  const links = linksOf(ctx.resources);
  if (!links) return undefined;
  const org = orgOf(ctx);
  return { secrets: secretsOf(links), ...(org ? { org } : {}) };
}

/** What's wrong with a site's settings, if anything (checked when the app starts). */
export function problemOf(
  name: string,
  line: DeclaredSite,
  resources: Resources,
): string | undefined {
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
    line.days !== undefined &&
    !(typeof line.days === "number" && line.days > 0 && line.days <= MOST_DAYS)
  ) {
    return `its days are a number over 0, ${MOST_DAYS} at most (as long as browsers keep a cookie)`;
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
  if (
    line.budget !== undefined &&
    !(typeof line.budget === "number" && Number.isFinite(line.budget) && line.budget > 0)
  ) {
    return "its budget is a number over 0 (what its visitors' model use may cost a day)";
  }
  if (line.challenge !== undefined && (typeof line.challenge !== "string" || !line.challenge)) {
    return "its challenge is an Action's name";
  }
  return undefined;
}

/**
 * What's wrong with the web sites' settings, if anything (checked when the
 * app starts), given the app's Actions: a site's challenge is one, and a
 * budget needs the usage plugin's prices (`usage.quote`).
 */
export function settingsProblem(
  resources: Resources,
  actions: Readonly<Record<string, unknown>> = {},
): string | undefined {
  const caller = callerProblem(callerOf({ resources }));
  if (caller) return caller;
  const sites = Object.entries(sitesOf({ resources }));
  for (const [name, line] of sites) {
    const problem = problemOf(name, line, resources) ??
      (line.challenge && !Object.hasOwn(actions, line.challenge)
        ? `its challenge "${line.challenge}" isn't one of the app's Actions`
        : line.budget && !Object.hasOwn(actions, "usage.quote")
        ? "its budget needs the usage plugin, which prices what visitors' turns use"
        : undefined);
    if (problem) return `web.${name} ${problem}`;
  }
  // Visitors' secrets are signed with the app's secret: nothing is kept when a page comes in.
  if (sites.length && !linksOf(resources)) {
    return "web sites need the app's secret, which visitors' cookies are signed with: " +
      "the links resource ({ origin, secret })";
  }
  return undefined;
}
