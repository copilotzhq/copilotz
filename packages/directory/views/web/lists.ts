/**
 * Orgs as the directory's front end lists them: someone's standing in a word,
 * the org page's sections (the shell's `orgSettings` resource) in their order
 * and for whom, and the console's orgs as staff search and sort them. Pure.
 */
import { orgRoleName, type OrgSection, type Standing } from "copilotz/plugins/interfaces/contract";
import { say } from "./words.ts";

/** How someone stands, in a word: their role ("Owner"), or "Staff" for staff who aren't in it. */
export const standingName = (standing: Standing | undefined): string =>
  !standing ? "" : standing.role ? orgRoleName(standing.role) : standing.staff ? say("staff") : "";

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
