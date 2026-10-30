/**
 * Spaces and their members, as the web says them: a space's name (yours is
 * "Personal"), spaces in the sidebar's order, those archived apart, those
 * something can move to, who a member is (`person:ana`, `agent:maya`, a
 * space drawing on this one), members in the order a list shows them and
 * by kind, what each role lets (an agent's, its own words), and an
 * invitation in words.
 */
import type { Member, Reached, Space } from "../../contract.ts";

/** Someone, as a space's name says them: an email's name part, or their id. */
const short = (person: string) => person.includes("@") ? person.split("@")[0] : person;

/**
 * What a space is called where it shows: yours is "Personal"; someone
 * else's (which an org's owners and admins reach), theirs: "bob's Personal".
 */
export const spaceName = (space: Pick<Space, "name" | "kind" | "owner">, viewer?: string) =>
  space.kind !== "personal"
    ? space.name
    : viewer && space.owner && space.owner !== viewer
    ? `${short(space.owner)}'s Personal`
    : "Personal";

/** Whether a space is someone else's Personal one. */
export const theirsAlone = (space: Pick<Space, "kind" | "owner">, viewer?: string) =>
  space.kind === "personal" && !!viewer && !!space.owner && space.owner !== viewer;

/** Personal first, then the others by name. */
export const bySpace = <S extends Pick<Space, "name" | "kind">>(spaces: S[]): S[] =>
  [...spaces].sort((a, b) =>
    Number(b.kind === "personal") - Number(a.kind === "personal") ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

/** Spaces in use, and those archived (`space.archive`), each in the sidebar's order. */
export function apart<S extends Pick<Space, "name" | "kind" | "archived">>(
  spaces: S[],
): { active: S[]; archived: S[] } {
  const sorted = bySpace(spaces);
  return {
    active: sorted.filter((s) => !s.archived),
    archived: sorted.filter((s) => s.archived),
  };
}

/** The spaces something in `from` may move to: those the person may write in, in use, but `from`. */
export const destinations = (spaces: Reached[], from?: string): Reached[] =>
  apart(spaces).active.filter((s) => s._id !== from && s.can.includes("write"));

export type Who = { kind: "person" | "agent" | "space" | string; id: string };

/** Who a member is, from its key: `person:ana`, `agent:maya`, `space:launch`. */
export function whoOf(key: string): Who {
  const at = key.indexOf(":");
  return at < 0 ? { kind: "person", id: key } : { kind: key.slice(0, at), id: key.slice(at + 1) };
}

/** The roles a space's members have, in the order they let more, with what each lets. */
export const ROLES = [
  { value: "viewer", label: "Viewer", lets: "Reads what's here" },
  { value: "editor", label: "Editor", lets: "Reads, chats and adds things here" },
  { value: "manager", label: "Manager", lets: "Also invites people, and renames the space" },
] as const;

/**
 * The roles an agent works in (never manager), editor first, each with what
 * it lets: an editor answers chats there and adds to what's there; a viewer
 * only reads it, for chats where it's an editor.
 */
export const AGENT_ROLES = [
  {
    value: "editor",
    label: "Editor",
    lets: "Answers chats here, and adds notes, memories and files",
  },
  {
    value: "viewer",
    label: "Viewer",
    lets: "Reads what's here for chats elsewhere; doesn't answer here",
  },
] as const;

/** A role with its article, as a sentence says it: "an editor", "a viewer". */
export const aRole = (role: string) => {
  const name = roleName(role).toLowerCase();
  return `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
};

/** What looks like an email address (the server says for sure). */
export const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** The addresses typed to invite: one, or several between commas, semicolons or spaces. */
export const addressesOf = (typed: string) => typed.split(/[\s,;]+/).filter(Boolean);

/** Several, as a sentence lists them: "a", "a and b", "a, b and c". */
export const listed = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * What inviting did, in words that never say whether an address has an
 * account here: nobody knows that until they accept.
 */
export const invitedNote = (emails: string[]) =>
  `Invited ${listed(emails)}. ${
    emails.length === 1 ? "They'll join once they accept." : "Each joins once they accept."
  }`;

/** A role, as people say it. */
export const roleName = (role: string) =>
  ROLES.find((r) => r.value === role)?.label ?? role[0]?.toUpperCase() + role.slice(1);

/** Members as a list shows them: you, then people by name, then agents, then spaces. */
export function byMember(members: Member[], me?: string): Member[] {
  const rank = (m: Member) => {
    const who = whoOf(m.member);
    if (who.kind === "person") return who.id === me ? 0 : 1;
    return who.kind === "agent" ? 2 : 3;
  };
  return [...members].sort((a, b) =>
    rank(a) - rank(b) || whoOf(a.member).id.localeCompare(whoOf(b.member).id)
  );
}

/** Members by kind, as the Members tab lists them: people, agents, and spaces drawing on this one. */
export function byKind(
  members: Member[],
): { people: Member[]; agents: Member[]; spaces: Member[] } {
  const of = (kind: string) => members.filter((m) => whoOf(m.member).kind === kind);
  return {
    people: of("person"),
    agents: of("agent"),
    spaces: members.filter((m) => !["person", "agent"].includes(whoOf(m.member).kind)),
  };
}

/** The people among them. */
export const peopleIn = (members: Member[]) =>
  members.filter((m) => whoOf(m.member).kind === "person");

/** Whether `key` is the only one who manages the space: then they can't leave it unmanaged. */
export const lastManager = (members: Member[], key: string) => {
  const managers = members.filter((m) => m.role === "manager" && !m.on);
  return managers.length === 1 && managers[0].member === key;
};
