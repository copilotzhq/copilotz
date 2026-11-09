/**
 * Orgs in the shell: the person's standing in the org they're in (spaces'
 * `org.me`), a role and what it lets, the shape of the org page's sections
 * (the `orgSettings` resource), and the `orgs` slot, which the front end
 * that knows the app's orgs fills (`@copilotz/directory`'s `directoryWeb`):
 * the shell knows none itself.
 */
import type { IconName, PaletteGroup } from "../../../../hosts/web/mod.ts";
import type { UserMenuEntry } from "./menu.ts";
import { say } from "../views/words.ts";

/**
 * Someone's standing in the org they're in (spaces' `org.me`): their role, whether they're
 * platform staff, and, where the app serves many orgs, which org it is.
 */
export type Standing = {
  role: string | null;
  staff: boolean;
  org?: { id: string; name: string; kind: string };
};

/** The roles in an org, in the order they let more, each with what it lets (said when read). */
export const ORG_ROLES: readonly {
  readonly value: "owner" | "admin" | "member" | "guest";
  readonly label: string;
  readonly lets: string;
}[] = [
  {
    value: "owner",
    get label() {
      return say("roleOwner");
    },
    get lets() {
      return say("roleOwnerLets");
    },
  },
  {
    value: "admin",
    get label() {
      return say("roleAdmin");
    },
    get lets() {
      return say("roleAdminLets");
    },
  },
  {
    value: "member",
    get label() {
      return say("roleMember");
    },
    get lets() {
      return say("roleMemberLets");
    },
  },
  {
    value: "guest",
    get label() {
      return say("roleGuest");
    },
    get lets() {
      return say("roleGuestLets");
    },
  },
] as const;

/** A role, as people say it. */
export const orgRoleName = (role: string | null | undefined): string =>
  ORG_ROLES.find((r) => r.value === role)?.label ??
    (role ? role[0].toUpperCase() + role.slice(1) : "");

/** Whether someone runs the org (owner or admin), or is staff, who reach all of it. */
export const runs = (standing: Standing | undefined): boolean =>
  !!standing && (standing.staff || standing.role === "owner" || standing.role === "admin");

/**
 * An `orgSettings` resource: a section of the org's page, from the plugin it
 * belongs to. Its View gets item `{ _id }` (the org's id) and hints `{ org,
 * role, staff, mode: "page" }`. `roles`: the org roles it shows to (every
 * one, unless given); platform staff see every section.
 */
export type OrgSection = {
  title: string;
  view: string;
  icon?: IconName;
  order?: number;
  roles?: string[];
};

/** How the shell calls Actions. */
type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/**
 * The `orgs` resource: where the app serves many orgs, what the shell shows of
 * where the person is among them, filled by the front end that knows them
 * (`@copilotz/directory`'s `directoryWeb`). The shell draws it when it's there;
 * without it, there's no switcher, and nothing of orgs in the menu or the palette.
 *
 * - `switcher`: a View at the top of the sidebar, beside the app's mark (in
 *   place of its whole logo), with hints `{ in, path }`, once `use` answers.
 * - `overlay`: a View drawn once beside every page, outside the sidebar (a
 *   drawer, on a phone): what going between orgs shows over the page.
 * - `use`: what the shell's own parts list for the person's orgs, kept
 *   current: a React hook the frame calls on every draw, given how it calls
 *   Actions. Their email under their name, entries in their menu (after the
 *   `userMenu` ones), and groups in the command palette. Nothing while it
 *   doesn't know yet, or where the server serves one org: the top of the
 *   sidebar is then the app's whole logo, as without the slot.
 *
 * ```ts
 * resources: { orgs: { switcher: "orgs.switcher", overlay: "orgs.overlay", use: useShellOrgs } }
 * ```
 */
export type OrgsSlot = {
  switcher: string;
  overlay?: string;
  use?(call: Call): OrgsShown | undefined;
};

/** What the `orgs` slot's hook gives the shell's own parts. */
export type OrgsShown = {
  /** The person's email, under their name. */
  email?: string | null;
  /** Entries in their menu, after the front ends' own (the org's page; every org, for staff). */
  menu?: UserMenuEntry[];
  /** Groups in the command palette (switching, invitations, a new org). */
  palette?: PaletteGroup[];
};

/** The `orgs` resource as given, or nothing where it names no switcher. */
export const orgsSlotOf = (given: unknown): OrgsSlot | undefined => {
  const slot = given as Partial<OrgsSlot> | null | undefined;
  return typeof slot?.switcher === "string" && slot.switcher ? slot as OrgsSlot : undefined;
};

const changes = new Set<() => void>();

/** Says, in the page, that the org changed (its owners renamed it): whatever shows orgs asks again. */
export function orgsChanged(): void {
  for (const listener of changes) listener();
}

/** Hears that the org changed (`orgsChanged`), until the function it returns is called. */
export function onOrgsChanged(listener: () => void): () => void {
  changes.add(listener);
  return () => changes.delete(listener);
}
