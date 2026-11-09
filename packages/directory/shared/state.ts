/**
 * What a directory keeps in memory, beside its store, shared by its routes
 * and the orgs it opened (`member(dir, org)`): one per directory runtime,
 * by its resources (the same object for its routes and for the app's `dir`).
 *
 * - **The handoff's key**: entering an org, the directory signs who goes in
 *   (`/enter`, see member.ts) with a key of its own, made at start; the org
 *   checks it. A handoff lives a minute, and never leaves the process.
 * - **Orgs as the directory has them** (`org.info`), kept 10 seconds, and
 *   **hosts orgs claimed** (`orgHost.resolve`), a minute: every request asks.
 *   What changes them here (a rename, a suspension, a claim) forgets them
 *   at once.
 * - **When each org last told how it is** (`org.report`): at most once a
 *   minute while it's used.
 */
import { type LinksSettings, type Resources, signLink, verifyLink } from "copilotz";
import type { OrgInfo } from "./settings.ts";

/** Whose a claimed host is, and where the front sends it. */
export type Claim = { org: string; target?: string };

/** A query, as a route's runtime and the app's `dir` both ask it. */
type Asks = { query<R = unknown>(name: string, params?: unknown): Promise<R> };

type Kept<T> = Map<string, { value: Promise<T>; until: number }>;

type State = {
  handoff: LinksSettings;
  info: Kept<OrgInfo | null>;
  claims: Kept<Claim | null>;
  reported: Map<string, number>;
};

const INFO_MS = 10_000;
const CLAIMS_MS = 60_000;
/** How long a handoff is good for. */
export const HANDOFF_MS = 60_000;
/** What a handoff signs: the org's own route, under its address. */
export const HANDOFF = "/enter";

const states = new WeakMap<object, State>();

/** The directory's state, by its resources. */
export function stateOf(resources: Resources): State {
  let state = states.get(resources);
  if (!state) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    state = {
      handoff: {
        origin: "https://directory.invalid",
        secret: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
      },
      info: new Map(),
      claims: new Map(),
      reported: new Map(),
    };
    states.set(resources, state);
  }
  return state;
}

/** A value kept a while, asked again once it's past (or failed). */
function kept<T>(map: Kept<T>, key: string, ms: number, ask: () => Promise<T>): Promise<T> {
  const found = map.get(key);
  if (found && found.until > Date.now()) return found.value;
  const value = ask();
  map.set(key, { value, until: Date.now() + ms });
  value.catch(() => map.delete(key));
  return value;
}

/** An org as the directory has it, kept a little while. */
export const infoOf = (dir: Asks, resources: Resources, org: string): Promise<OrgInfo | null> =>
  kept(
    stateOf(resources).info,
    org,
    INFO_MS,
    () => dir.query<OrgInfo | null>("org.info", { org }),
  );

/** A host as claims keep it: lowercase, no trailing dot. */
export const plainHost = (host: string): string =>
  String(host ?? "").trim().toLowerCase().replace(/\.$/, "");

/** Whose a host is, kept a minute. */
export const claimOf = (dir: Asks, resources: Resources, host: string): Promise<Claim | null> =>
  kept(
    stateOf(resources).claims,
    plainHost(host),
    CLAIMS_MS,
    () => dir.query<Claim | null>("orgHost.resolve", { host: plainHost(host) }),
  );

/** Forgets what's kept of an org, or of a host, here: it just changed. */
export function forget(resources: Resources, what: { org?: string; host?: string }): void {
  const state = stateOf(resources);
  if (what.org !== undefined) state.info.delete(what.org);
  if (what.host !== undefined) state.claims.delete(plainHost(what.host));
}

/** Who goes into an org: what the directory signs, and the org's `/enter` reads. */
export type Handoff = {
  org: string;
  person: string;
  email?: string;
  name?: string;
  picture?: string;
  /** The role they join with, the first time. */
  role?: string;
  /** As platform staff. */
  staff?: boolean;
  /** Where the browser goes then (a path on the app): a redirect; none, `{ org }`. */
  to?: string;
};

/** A handoff, signed: the query of the org's `/enter`. */
export async function signHandoff(resources: Resources, handoff: Handoff): Promise<string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(handoff)) {
    if (value === undefined || value === false || value === "") continue;
    params[name] = value === true ? "1" : String(value);
  }
  const link = await signLink(stateOf(resources).handoff, HANDOFF, params, HANDOFF_MS);
  return new URL(link).search;
}

/** A handoff the directory signed, from an `/enter` request's query; undefined for any other. */
export async function readHandoff(
  resources: Resources,
  query: URLSearchParams,
): Promise<Handoff | undefined> {
  const params = await verifyLink(stateOf(resources).handoff, HANDOFF, Object.fromEntries(query));
  if (!params?.org || !params.person) return undefined;
  return {
    org: params.org,
    person: params.person,
    ...(params.email ? { email: params.email } : {}),
    ...(params.name ? { name: params.name } : {}),
    ...(params.picture ? { picture: params.picture } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(params.staff === "1" ? { staff: true } : {}),
    ...(params.to ? { to: params.to } : {}),
  };
}

/** Whether an org's report is due (at most once a minute), counting this one. */
export function reportDue(resources: Resources, org: string): boolean {
  const reported = stateOf(resources).reported;
  const now = Date.now();
  if (now - (reported.get(org) ?? 0) < 60_000) return false;
  reported.set(org, now);
  return true;
}
