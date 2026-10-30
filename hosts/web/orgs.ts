/**
 * Orgs, for the browser: what the server says of the orgs the signed-in
 * person belongs to, when it serves many behind one address (`hosts/orgs`),
 * and going between them. A server that serves one org has none of this, and
 * `useOrgs()` says so (`none`): the shell then shows no switcher.
 *
 * - `useOrgs()`: who's signed in, the org they're in, their orgs (the last
 *   entered first), the invitations waiting for them, and whether they're
 *   platform staff; `refreshOrgs()` asks again (after renaming one).
 * - `enterOrg`, `createOrg`, `answerOrgInvite`: each goes into an org (the
 *   server swaps the session), and the page starts over at that org's home,
 *   after a short transition (`useSwitching()`, which the shell shows).
 * - Staff's console: `consoleOrgs()`, `updateOrg(id, { suspended?, name? })`,
 *   `moveOrg(id, schema)`, `exportOrgUrl(id)` (its rows, as SQL, to save)
 *   and `deleteOrg(id, name)` (its exact name confirms it). An app that
 *   doesn't do one says so (`unsupported`).
 *
 * It's the page's own HTTP, same origin, with the cookies the server set.
 */
import { useSyncExternalStore } from "react";

export type Org = { id: string; name: string; kind: "personal" | "team"; suspended?: true };

/** An invitation to an org, waiting for the person: from whom, as what. */
export type OrgInvite = {
  id: string;
  org: string;
  name: string;
  role: string;
  from?: string;
  at: string;
};

/** What `GET /orgs` answers. */
export type Orgs = {
  person: string;
  email: string | null;
  /** The org the session is in. */
  current: string | null;
  orgs: Org[];
  invites: OrgInvite[];
  /** Platform staff, who go into any org. */
  staff: boolean;
};

/** An org as staff's console lists it, with what it last reported of itself. */
export type ConsoleOrg = Org & {
  by: string;
  members: number;
  placement: { schema: string };
  summary?: { people?: number; spaces?: number; active?: string; at?: string };
  at: string;
};

/**
 * Where the orgs stand: still asking, a server with none (one org), or what
 * it said, with the org the person is in (`here`: one of theirs, or, for
 * staff, one they went into, as the console names it).
 */
export type OrgsState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; value: Orgs; here?: Org };

let state: OrgsState = { status: "loading" };
let asked: Promise<OrgsState> | undefined;
const listeners = new Set<() => void>();
const set = (next: OrgsState) => {
  state = next;
  for (const listener of listeners) listener();
};

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => state,
};

/** Asks the server, once (again with `refreshOrgs`); a server that serves one org answers none. */
export function loadOrgs(): Promise<OrgsState> {
  return asked ??= fetch("/orgs", { headers: { accept: "application/json" } }).then(
    async (response) => {
      const json = response.headers.get("content-type")?.includes("application/json");
      // One org: the server answers its page (or nothing) where many would answer JSON.
      if (!response.ok || !json) {
        set({ status: "none" });
        return state;
      }
      const value = await response.json() as Orgs;
      // Staff in an org of someone else's: its name is the console's.
      const here = currentOrg(value) ??
        (value.staff && value.current
          ? (await consoleOrgs().catch(() => [])).find((o) => o.id === value.current)
          : undefined);
      const next: OrgsState = {
        status: "ready",
        value,
        ...(here
          ? {
            here: {
              id: here.id,
              name: here.name,
              kind: here.kind,
              ...(here.suspended ? { suspended: true as const } : {}),
            },
          }
          : {}),
      };
      set(next);
      return next;
    },
    () => {
      asked = undefined;
      const next: OrgsState = { status: "none" };
      set(next);
      return next;
    },
  );
}

/** Asks the server again: after renaming an org, or answering an invitation. */
export function refreshOrgs(): Promise<OrgsState> {
  asked = undefined;
  return loadOrgs();
}

/** The orgs, as they stand, kept current. */
export function useOrgs(): OrgsState {
  const now = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (now.status === "loading" && typeof fetch === "function") void loadOrgs();
  return now;
}

/** The org the session is in: one of theirs, or (for staff) one they've gone into. */
export const currentOrg = (orgs: Orgs): Org | undefined =>
  orgs.orgs.find((o) => o.id === orgs.current);

/** Whether they're in an org as platform staff, not as one of its people. */
export const asStaff = (orgs: Orgs): boolean =>
  orgs.staff && !!orgs.current && !orgs.orgs.some((o) => o.id === orgs.current);

/** What an org is called where it shows: everyone's own is "Personal". */
export const orgName = (org: Pick<Org, "name" | "kind">): string =>
  org.kind === "personal" ? "Personal" : org.name;

/** What a refusal's status means: not let (403), not done by this app (501), or not so (else). */
const codeOf = (status: number) =>
  status === 403 ? "forbidden" : status === 501 ? "unsupported" : "invalid";

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(answer.error ?? response.statusText), {
      code: codeOf(response.status),
    });
  }
  return answer as T;
};

/**
 * Going into an org: which, while the page starts over there (as staff, or
 * `moved` there because they're no longer in the one they were in).
 */
export type Switching = {
  /** The org's id, when known (its face's colour). */
  id?: string;
  name: string;
  kind: "personal" | "team";
  staff?: boolean;
  moved?: boolean;
};

let switching: Switching | undefined;
const switchers = new Set<() => void>();
const switchingTo = (next: Switching | undefined) => {
  switching = next;
  for (const listener of switchers) listener();
};

/** The org the page is going into, while it does (the shell shows a short transition). */
export function useSwitching(): Switching | undefined {
  return useSyncExternalStore(
    (listener: () => void) => {
      switchers.add(listener);
      return () => switchers.delete(listener);
    },
    () => switching,
    () => undefined,
  );
}

/** Where the page says, once it has started over, which org it came into. */
const ARRIVED = "copilotz-org-arrived";

/** Shows the transition, does `move`, then starts over at the org's home; failing, it stays. */
async function into<T>(to: Switching, move: () => Promise<T>): Promise<T> {
  switchingTo(to);
  const started = Date.now();
  try {
    const done = await move();
    // Long enough to read where you're going; never long enough to wait on.
    await new Promise((r) => setTimeout(r, Math.max(0, 420 - (Date.now() - started))));
    try {
      sessionStorage.setItem(ARRIVED, JSON.stringify(to));
    } catch { /* private mode: no welcome */ }
    location.assign("/");
    return done;
  } catch (error) {
    switchingTo(undefined);
    throw error;
  }
}

/** Goes into an org (one of theirs; any, for staff), and starts over at its home. */
export function enterOrg(org: Pick<Org, "id" | "name" | "kind">, staff = false): Promise<void> {
  return into(
    { id: org.id, name: org.name, kind: org.kind, ...(staff ? { staff: true } : {}) },
    () => post("/orgs/enter", { org: org.id }),
  ).then(() => {});
}

/** Makes a team org, its maker its owner, and goes into it. */
export function createOrg(name: string): Promise<void> {
  return into({ name, kind: "team" }, () => post("/orgs", { name })).then(() => {});
}

/** Accepts an invitation (and goes into its org) or declines it. */
export async function answerOrgInvite(invite: OrgInvite, accept: boolean): Promise<void> {
  if (!accept) {
    await post("/orgs/invites/answer", { invite: invite.id, accept: false });
    await refreshOrgs();
    return;
  }
  await into(
    { id: invite.org, name: invite.name, kind: "team" },
    () => post("/orgs/invites/answer", { invite: invite.id, accept: true }),
  );
}

/**
 * Where many orgs are served, someone still signed in whose session in this
 * org ended (they were taken out of it, or it was suspended) goes into
 * another of theirs instead of signing in again: the one they were in
 * before, or their own. True when the page is starting over there; never
 * twice in a row, so a page that can't get in shows sign-in.
 */
export async function reenter(): Promise<boolean> {
  const KEY = "copilotz-org-reentered";
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 15_000) return false;
    const found = await loadOrgs();
    if (found.status !== "ready") return false;
    const next = found.value.orgs.find((o) => o.id !== found.value.current && !o.suspended);
    if (!next) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
    await post("/orgs/enter", { org: next.id });
    sessionStorage.setItem(
      ARRIVED,
      JSON.stringify({ id: next.id, name: next.name, kind: next.kind, moved: true }),
    );
    location.assign("/");
    return true;
  } catch {
    return false;
  }
}

/** The org the page just came into, once (its welcome), then forgotten. */
export function arrived(): Switching | undefined {
  try {
    const kept = sessionStorage.getItem(ARRIVED);
    sessionStorage.removeItem(ARRIVED);
    return kept ? JSON.parse(kept) as Switching : undefined;
  } catch {
    return undefined;
  }
}

/** Every org, for staff's console. */
export async function consoleOrgs(): Promise<ConsoleOrg[]> {
  const response = await fetch("/console/orgs", { headers: { accept: "application/json" } });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(answer.error ?? response.statusText), {
      code: codeOf(response.status),
    });
  }
  return (answer as { orgs: ConsoleOrg[] }).orgs;
}

/** Suspends an org or lifts it, or renames it: staff's. */
export async function updateOrg(
  org: string,
  change: { suspended?: boolean; name?: string },
): Promise<void> {
  await post(`/console/orgs/${encodeURIComponent(org)}`, change);
}

/** Moves an org's rows to another schema (for a big org: one of its own). */
export async function moveOrg(org: string, schema: string): Promise<{ schema: string }> {
  const { placement } = await post<{ placement: { schema: string } }>(
    `/console/orgs/${encodeURIComponent(org)}/move`,
    { schema },
  );
  return placement;
}

/** Where an org's rows download, as SQL. */
export const exportOrgUrl = (org: string): string =>
  `/console/orgs/${encodeURIComponent(org)}/export`;

/** Deletes an org for good: `name`, its exact name, confirms it. */
export async function deleteOrg(org: string, name: string): Promise<void> {
  await post(`/console/orgs/${encodeURIComponent(org)}/delete`, { confirm: name });
}
