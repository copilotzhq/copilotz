/**
 * Orgs in the shell, as words and lists: a role and what it lets, the org
 * page's sections (the `orgSettings` resource) in their order and for whom,
 * and the console's orgs as staff search and sort them.
 */
import type { IconName } from "../../../../hosts/web/mod.ts";

/** Someone's standing in the org they're in: their role, and whether they're platform staff. */
export type Standing = { role: string | null; staff: boolean };

/** The roles in an org, in the order they let more, each with what it lets. */
export const ORG_ROLES = [
  {
    value: "owner",
    label: "Owner",
    lets: "Runs the org: everything admins do, and makes or unmakes owners",
  },
  {
    value: "admin",
    label: "Admin",
    lets: "Invites people, changes roles, and reaches everything in the org",
  },
  {
    value: "member",
    label: "Member",
    lets: "Works in their spaces, makes new ones, and sees who's in the org",
  },
  {
    value: "guest",
    label: "Guest",
    lets: "Reaches only the spaces they're invited to",
  },
] as const;

/** A role, as people say it. */
export const orgRoleName = (role: string | null | undefined): string =>
  ORG_ROLES.find((r) => r.value === role)?.label ??
    (role ? role[0].toUpperCase() + role.slice(1) : "");

/** Whether someone runs the org (owner or admin), or is staff, who reach all of it. */
export const runs = (standing: Standing | undefined): boolean =>
  !!standing && (standing.staff || standing.role === "owner" || standing.role === "admin");

/** How someone stands, in a word: "Owner", or "Staff" for staff who aren't in it. */
export const standingName = (standing: Standing | undefined): string =>
  !standing ? "" : standing.role ? orgRoleName(standing.role) : standing.staff ? "Staff" : "";

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

/** The sections someone sees, in their order (lowest first), each with its key. */
export function sectionsOf(
  given: unknown,
  standing: Standing | undefined,
): (OrgSection & { key: string })[] {
  return Object.entries((given ?? {}) as Record<string, OrgSection | null>)
    .flatMap(([key, section]) => section?.view && section.title ? [{ ...section, key }] : [])
    .filter((section) =>
      standing?.staff || !section.roles ||
      (!!standing?.role && section.roles.includes(standing.role))
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}

/** The section the address asks for (`?tab=`), or the first. */
export const chosenSection = <S extends { key: string }>(sections: S[], asked?: string) =>
  sections.find((s) => s.key === asked) ?? sections[0];

/** An org as staff's console lists it. */
export type Listed = {
  id: string;
  name: string;
  kind: string;
  members: number;
  suspended?: boolean;
  placement?: { schema: string };
  summary?: { people?: number; spaces?: number; active?: string };
  at: string;
};

/** Which orgs the console shows. */
export type ConsoleFilter = "all" | "team" | "personal" | "suspended";

/** The orgs matching what's typed (name, id, schema, who made it) and the filter, busiest first. */
export function consoleList<O extends Listed & { by?: string }>(
  orgs: O[],
  search: string,
  filter: ConsoleFilter,
): O[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return orgs
    .filter((o) => filter === "all" || (filter === "suspended" ? !!o.suspended : o.kind === filter))
    .filter((o) => {
      const text = [o.name, o.id, o.placement?.schema ?? "", o.by ?? ""].join(" ").toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) =>
      (b.summary?.active ?? b.at).localeCompare(a.summary?.active ?? a.at) ||
      a.name.localeCompare(b.name)
    );
}

/** The console's totals: orgs, those of teams, people across them, and those suspended. */
export function consoleTotals(orgs: Listed[]) {
  return {
    orgs: orgs.length,
    teams: orgs.filter((o) => o.kind === "team").length,
    people: orgs.reduce((n, o) => n + (o.summary?.people ?? o.members), 0),
    suspended: orgs.filter((o) => o.suspended).length,
  };
}

/** A schema name the console takes for moving an org: lowercase letters, digits and `_`. */
export const SCHEMA = /^[a-z][a-z0-9_]{0,62}$/;
