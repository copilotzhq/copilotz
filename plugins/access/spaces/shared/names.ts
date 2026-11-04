/**
 * People by name, wherever an id would show (a page, an agent's prompt): the
 * `profile` collection (any person or agent in the org reads it), and how a
 * person shows from it, with their picture on a page. Plain functions, for
 * every plugin (through the contract).
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
 * The `names` resource: where names are, by source: people's (the spaces
 * plugin's profiles, `{ collection }`), and other kinds of actors whose ids
 * start with a prefix (contacts: `{ collection: "contact", prefix: "contact:" }`),
 * each read through its collection's `names` query (`{ ids }` → names by id,
 * as the asker may read them). An app without it shows ids as they are.
 */
export type NamesResource = Record<string, NamesSource>;
export type NamesSource = { collection: string; prefix?: string };

type Db = {
  collection(name: string): {
    query<R>(query: string, params?: unknown): { value?: R } | PromiseLike<R>;
  };
};

/** The people among ids, each once, in order (the same read for the same people). */
export const peopleIn = (ids: string[]): string[] =>
  [...new Set(ids.filter(Boolean).map(bare))].sort();

/**
 * Ids by the source that names them (the one whose prefix they start with,
 * else people's), each list once and in order: the same read for the same ids.
 */
function bySource(resources: Record<string, unknown>, ids: string[]) {
  const sources = Object.values((resources.names ?? {}) as NamesResource).filter(Boolean);
  const people = sources.find((s) => !s.prefix);
  const found = new Map<NamesSource, string[]>();
  for (const id of ids) {
    if (!id) continue;
    const source = sources.find((s) => s.prefix && id.startsWith(s.prefix)) ?? people;
    if (source) found.set(source, [...found.get(source) ?? [], id]);
  }
  return [...found].map(([source, wanted]) => ({
    collection: source.collection,
    ids: source.prefix ? [...new Set(wanted)].sort() : peopleIn(wanted),
  }));
}

/** Names by id, in a View (in a page too: its reads answer at once, or once they're in). */
export function namesIn(
  ctx: { resources: Record<string, unknown>; db: Db },
  ids: string[],
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const { collection, ids: wanted } of bySource(ctx.resources, ids)) {
    const found = ctx.db.collection(collection).query<Record<string, string>>("names", {
      ids: wanted,
    }) as { value?: Record<string, string> };
    Object.assign(names, found.value ?? {});
  }
  return names;
}

/** Pictures by id, in a View: a face beside a name, for the people who have one. */
export function picturesIn(
  ctx: { resources: Record<string, unknown>; db: Db },
  ids: string[],
): Record<string, string> {
  const people = Object.values((ctx.resources.names ?? {}) as NamesResource)
    .find((s) => s && !s.prefix);
  const wanted = peopleIn(ids);
  if (!people || !wanted.length) return {};
  const found = ctx.db.collection(people.collection).query<Record<string, string>>("pictures", {
    ids: wanted,
  }) as { value?: Record<string, string> };
  return found.value ?? {};
}

/** Names by id, in an Action, a Processor or a tool. */
export async function namesFor(
  ctx: { resources: Record<string, unknown>; db: Db },
  ids: string[],
): Promise<Record<string, string>> {
  const found = await Promise.all(
    bySource(ctx.resources, ids).map(({ collection, ids: wanted }) =>
      ctx.db.collection(collection).query<Record<string, string>>("names", {
        ids: wanted,
      }) as PromiseLike<Record<string, string>>
    ),
  );
  return Object.assign({}, ...found);
}
