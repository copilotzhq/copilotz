/**
 * Tags by name, for pages: a space's name, a conversation's title, a
 * computer's, an app's. The ledger knows none of them: whoever owns what a
 * tag points to says where it's named, in the `usageNames` resource kind,
 * and the names are read there as whoever asks, so only what they reach is
 * named. A tag nobody names stays an id.
 *
 * ```ts
 * resources: {
 *   usageNames: { space: { tag: "tags.space", collection: "space", field: "name", owner: "owner" } },
 * }
 * ```
 */
import type { ReadContext, Resources } from "../../../../runtime/mod.ts";

/**
 * A `usageNames` resource: the tag it names (`tags.space`), the collection
 * holding what it points to, the field naming each (`name`, a thread's
 * `title`), and the field they're found by (their `_id`, unless `key` says:
 * a desk is found by its `computer`). `owner`: the field saying whose it is
 * (a Personal space's person).
 */
export type UsageName = {
  tag: string;
  collection: string;
  field: string;
  key?: string;
  owner?: string;
};

/** A tag's value by name; `owner`, whose it is (a Personal space's person). */
export type Named = { name: string; owner?: string };

/** Where each tag is named, by tag: the first `usageNames` entry for it. */
export function namingsOf(ctx: { resources: Resources }): Map<string, UsageName> {
  const out = new Map<string, UsageName>();
  const declared = (ctx.resources.usageNames ?? {}) as Record<string, UsageName | null>;
  for (const naming of Object.values(declared)) {
    if (naming && !out.has(naming.tag)) out.set(naming.tag, naming);
  }
  return out;
}

/** What's wrong with a `usageNames` entry, if anything. */
export function nameProblem(key: string, naming: unknown): string | undefined {
  const n = naming as Partial<UsageName> | null;
  if (n === null) return undefined;
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!n || !text(n.tag) || !text(n.collection) || !text(n.field)) {
    return `usageNames "${key}" needs a tag, a collection and a field`;
  }
  if ((n.key !== undefined && !text(n.key)) || (n.owner !== undefined && !text(n.owner))) {
    return `usageNames "${key}": key and owner are field names`;
  }
  return undefined;
}

/**
 * Names for the values of each tag (`{ "tags.space": ["s1"] }`), as the
 * caller reads them. A tag somebody names is there, with what the caller
 * reaches of it (maybe nothing); one nobody names isn't.
 */
export async function named(
  ctx: Pick<ReadContext, "db" | "resources">,
  wanted: Record<string, Iterable<unknown>>,
): Promise<Record<string, Record<string, Named>>> {
  const namings = namingsOf(ctx);
  const out: Record<string, Record<string, Named>> = {};
  await Promise.all(
    Object.entries(wanted).map(async ([tag, values]) => {
      const naming = namings.get(tag);
      const ids = [
        ...new Set([...values].filter((v): v is string => typeof v === "string" && !!v)),
      ];
      if (!naming || !ids.length) return;
      const key = naming.key ?? "_id";
      // Named, even with nothing the caller reaches: what's missing is out of reach, not unnamed.
      const names: Record<string, Named> = {};
      out[tag] = names;
      try {
        const docs = await ctx.db.collection<Record<string, unknown>>(naming.collection).find(
          { [key]: { $in: ids } },
          { limit: ids.length * 4 },
        );
        for (const doc of docs) {
          const id = doc[key];
          const name = doc[naming.field];
          if (typeof id !== "string" || typeof name !== "string" || !name || names[id]) continue;
          const owner = naming.owner ? doc[naming.owner] : undefined;
          names[id] = { name, ...(typeof owner === "string" && owner ? { owner } : {}) };
        }
      } catch {
        // One the caller can't read: those stay ids.
      }
    }),
  );
  return out;
}
