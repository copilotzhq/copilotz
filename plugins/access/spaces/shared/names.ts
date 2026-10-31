/**
 * People by name, wherever an id would show (a page, an agent's prompt): the
 * `profile` collection (any person or agent in the org reads it), and how a
 * person shows from it. Plain functions, for every plugin (through the
 * contract).
 */

/** The collection people's profiles are in, by their id. */
export const PROFILE = "profile";

/** A person's id, from a member key (`person:<id>`) too. */
export const bare = (id: string): string =>
  id.startsWith("person:") ? id.slice("person:".length) : id;

/**
 * How someone shows: their name from their profile; else their id when it
 * reads as one (`ana`), but never a sign-in method's id (`google:1139…`),
 * which says nothing: "someone".
 */
export function nameOf(id: string, names: Record<string, string> = {}): string {
  // An agent as a member (`agent:north`) shows by its name.
  if (id.startsWith("agent:")) return id.slice("agent:".length);
  const person = bare(id);
  return names[person] ?? (/^[^:@\s]+:/.test(person) ? "someone" : person);
}

/**
 * Profiles as names by id. Two people of one name among them stay apart:
 * each says the end of their id too ("Ana (2762)"), so a name read in a
 * prompt still says who.
 */
export function namesOf(profiles: { _id: string; name?: string }[]): Record<string, string> {
  const named = profiles.filter((p) => p.name);
  const count = new Map<string, number>();
  for (const p of named) count.set(p.name!, (count.get(p.name!) ?? 0) + 1);
  return Object.fromEntries(
    named.map((p) => [p._id, count.get(p.name!)! > 1 ? `${p.name} (${p._id.slice(-4)})` : p.name!]),
  );
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with people's ids in place of their names (something written before
 * names were known: an agent's note "google:1139…'s computer…"), each id
 * given its name. Only whole ids: never part of a word.
 */
export function withNames(text: string, names: Record<string, string>): string {
  let out = text;
  for (const [id, name] of Object.entries(names)) {
    if (!id || name === id || !out.includes(id)) continue;
    out = out.replace(new RegExp(`(?<![\\w:@.-])${escaped(id)}(?![\\w:@-])`, "g"), name);
  }
  return out;
}

/** The ids of people a text may name (sign-in methods' ids: `google:1139…`, `email:ana@…`). */
export const idsIn = (text: string): string[] => [
  ...new Set(text.match(/\b[a-z][a-z0-9-]*:[A-Za-z0-9._@+-]+/g) ?? []),
];

/**
 * The `names` resource: where people's names are (`{ collection }`: the
 * spaces plugin's profiles), read through that collection's `names` query
 * (`{ ids }` → names by id). An app without it shows ids as they are.
 */
export type NamesResource = { collection: string };

type Db = {
  collection(name: string): {
    query<R>(query: string, params?: unknown): { value?: R } | PromiseLike<R>;
  };
};

const where = (resources: Record<string, unknown>) =>
  (resources.names as NamesResource | undefined)?.collection;
/** The people among ids, each once, in order (the same read for the same people). */
export const peopleIn = (ids: string[]): string[] =>
  [...new Set(ids.filter(Boolean).map(bare))].sort();

/** Names by id, in a View (in a page too: its reads answer at once, or once they're in). */
export function namesIn(
  ctx: { resources: Record<string, unknown>; db: Db },
  ids: string[],
): Record<string, string> {
  const collection = where(ctx.resources);
  const wanted = peopleIn(ids);
  if (!collection || !wanted.length) return {};
  const found = ctx.db.collection(collection).query<Record<string, string>>("names", {
    ids: wanted,
  }) as { value?: Record<string, string> };
  return found.value ?? {};
}

/** Names by id, in an Action, a Processor or a tool. */
export async function namesFor(
  ctx: { resources: Record<string, unknown>; db: Db },
  ids: string[],
): Promise<Record<string, string>> {
  const collection = where(ctx.resources);
  const wanted = peopleIn(ids);
  if (!collection || !wanted.length) return {};
  return await (ctx.db.collection(collection).query<Record<string, string>>("names", {
    ids: wanted,
  }) as PromiseLike<Record<string, string>>);
}
