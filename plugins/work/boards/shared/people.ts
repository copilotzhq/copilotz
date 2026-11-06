/**
 * Who's in a space, as boards' tools name them: its people (by the name
 * their profile shows, by the email they signed in with) and its agents (by the name they're
 * shown as, "North", or the one they're called by, `north`), each with the
 * key a card's assignee holds (`person:<id>`, `agent:<name>`). A name typed
 * is matched against them: `me` is the agent asking.
 */
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";
import type { ToolContext } from "../../../agents/chat/contract.ts";
import { fold } from "./columns.ts";

/** Someone in a space: the key a card holds, how they're named, and what else matches them. */
export type Someone = { key: string; kind: "person" | "agent"; name: string; also: string[] };

type Member = { member: string };
type Person = { _id: string; name?: string; email?: string };
type Team = { agents: Record<string, { name?: string }> };

/**
 * The space's people and agents. Their emails are read as the system (only
 * theirs); their names are their profiles'.
 */
export async function peopleIn(ctx: ToolContext, space: string): Promise<Someone[]> {
  const members = await ctx.db.collection<Member>("member").find({ space });
  const ids = (kind: string) =>
    members.filter((m) => m.member.startsWith(`${kind}:`)).map((m) =>
      m.member.slice(kind.length + 1)
    );
  const agents = ids("agent");
  const persons = ids("person");
  const [team, people, names] = await Promise.all([
    agents.length
      ? ctx.db.collection("thread").query<Team>("agents", { in: space, names: agents })
      : { agents: {} } as Team,
    persons.length
      ? ctx.as().db.collection<Person>("person").find({ _id: { $in: persons } })
      : [] as Person[],
    namesFor(ctx, persons),
  ]);
  return [
    ...persons.map((id): Someone => {
      const p = people.find((x) => x._id === id);
      return {
        key: `person:${id}`,
        kind: "person",
        name: names[id] || p?.name || p?.email || nameOf(id),
        also: [
          id,
          ...(p?.email ? [p.email, p.email.split("@")[0]] : []),
          ...(p?.name ? [p.name] : []),
          ...(names[id] ? [names[id]] : []),
        ],
      };
    }),
    ...agents.map((id): Someone => ({
      key: `agent:${id}`,
      kind: "agent",
      name: team.agents[id]?.name || id,
      also: [id, `@${id}`, ...(team.agents[id]?.name ? [team.agents[id].name!] : [])],
    })),
  ];
}

/** Whom `typed` names among `people`: `me` is `agent`; none, or several, say so. */
export function whoIs(
  typed: string,
  people: Someone[],
  agent: string,
): { found: Someone } | { none: true } | { several: Someone[] } {
  const said = fold(typed.replace(/^@/, ""));
  if (said === "me" || said === "myself") {
    const self = people.find((p) => p.key === `agent:${agent}`);
    return self ? { found: self } : { none: true };
  }
  const exact = people.filter((p) =>
    fold(p.key) === said || [p.name, ...p.also].some((n) => fold(n.replace(/^@/, "")) === said)
  );
  if (exact.length === 1) return { found: exact[0] };
  if (exact.length > 1) return { several: exact };
  const first = people.filter((p) =>
    [p.name, ...p.also].some((n) => fold(n).split(/[\s.@]+/).includes(said))
  );
  if (first.length === 1) return { found: first[0] };
  return first.length ? { several: first } : { none: true };
}

/** How someone shows in an answer: an agent by name, a person by name and email. */
export function shown(someone: Someone): string {
  if (someone.kind === "agent") return someone.name;
  // An email, not an id that holds one (`email:ana@…`).
  const email = someone.also.find((a) => a.includes("@") && !a.includes(":"));
  return email && email !== someone.name ? `${someone.name} (${email})` : someone.name;
}

/** Everyone in the space, as an answer lists them when a name matches nobody. */
export const everyone = (people: Someone[]) =>
  people.length ? people.map(shown).join(", ") : "nobody yet";

/**
 * How a card's assignee shows: by name when they're in the space; else
 * (someone since gone) by `names`, their profiles' names.
 */
export function assigneeSaid(
  key: string | undefined,
  people: Someone[],
  names: Record<string, string> = {},
): string {
  if (!key) return "unassigned";
  const someone = people.find((p) => p.key === key);
  return someone ? shown(someone) : nameOf(key, names);
}
