/**
 * Who changed a document, as words say them: from a key (`person:ana`,
 * `agent:north`), a person by their name (their profile's, from Copilotz's
 * `namesIn`/`namesFor`; else an email's first part), an agent by what it's
 * shown as when that's known ("North"), else by what it's called.
 */
import { nameOf as shownName } from "copilotz/plugins/access/contract";

export type Who = { kind: string; id: string };

/** Who a key is. */
export function whoOf(key: string): Who {
  const at = key.indexOf(":");
  return at < 0 ? { kind: "person", id: key } : { kind: key.slice(0, at), id: key.slice(at + 1) };
}

/**
 * A person, as a sentence names them: their profile's name (`names`, by id);
 * else "Ana" for ana@example.com, "Ana Lima" for ana.lima@…; a sign-in's id
 * (`google:1139…`) says nothing, so "someone".
 */
export function personName(id: string, names: Record<string, string> = {}): string {
  if (names[id]) return names[id];
  if (/^[^:@\s]+:/.test(id)) return shownName(id, names);
  return (id.includes("@") ? id.split("@")[0] : id).split(/[._]+/).filter(Boolean)
    .map((w) => w[0].toLocaleUpperCase() + w.slice(1)).join(" ") || id;
}

/**
 * Someone, by key; `agentName` says what an agent is shown as, when it
 * knows, and `names` what people are.
 */
export function nameOf(
  key: string,
  agentName?: (id: string) => string | undefined,
  names?: Record<string, string>,
): string {
  const who = whoOf(key);
  if (who.kind === "agent") return agentName?.(who.id) || who.id;
  return personName(who.id, names);
}

/** The people among keys, for `namesFor`/`namesIn`: their ids. */
export const peopleOf = (keys: (string | undefined)[]): string[] =>
  keys.flatMap((k) => k && whoOf(k).kind === "person" ? [whoOf(k).id] : []);

/** What the app's agents are shown as (the `agents` resource): "North" for `north`. */
export const agentNamer = (ctx: { resources: Record<string, unknown> }) => (id: string) =>
  (ctx.resources.agents as Record<string, { name?: string } | null> | undefined)?.[id]?.name;
