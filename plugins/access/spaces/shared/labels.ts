/**
 * Labels: what a job read is carried to what it writes. A document read
 * labels the job with its space and its sources. A document the job then
 * writes into a space whose members can't all see some of those (a space
 * neither it nor one it draws on) takes them on as `sources`, in a
 * collection that keeps labels (`shared: { message: { labels: true } }`):
 * only those who reach its space and all its sources read it, until someone
 * who does shares it (`share`). An agent writing that anywhere else, or into
 * a collection that keeps no labels, is refused (`needs_share`): a person has
 * to choose to show it there. Documents that are members (agents people
 * make, contacts) carry nothing: they're meant for whoever they work with.
 *
 * A document that may be shared on its own (a chat: other collections'
 * documents are its parts) labels as itself, and so do its parts (a chat's
 * messages), so a write into one shared with someone outside its space (a
 * contact) knows what they can't see: anything else read, even from the
 * same space, labels it with that space, which they don't reach.
 */
import type { Labels, ReadContext } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { docKey, homeOf, reachOf } from "./reach.ts";
import { nameOf, namesOf, PROFILE } from "./names.ts";
import type { Shared } from "./rules.ts";

/** The `shared` resource; an entry is a collection's own key, never what objects inherit. */
const sharedOf = (ctx: ReadContext) => (ctx.resources.shared ?? {}) as Shared;
const entryOf = (shared: Shared, collection: string) =>
  Object.hasOwn(shared, collection) ? shared[collection] : undefined;

/** A document's own label: `#<collection>:<id>`, apart from spaces' ids. */
const OWN = "#";

/**
 * The document that `doc` of `collection` is shared with, as a label's key:
 * the one it's part of (a message's chat), or itself, when it's one others
 * are parts of (a chat). Others are shared only through their space.
 */
function wholeOf(collection: string, doc: Record<string, unknown>, shared: Shared) {
  const part = entryOf(shared, collection)?.part;
  if (part) return typeof doc[part] === "string" ? docKey(part, doc[part] as string) : undefined;
  const whole = Object.values(shared).some((entry) => entry?.part === collection);
  return whole && typeof doc._id === "string" ? docKey(collection, doc._id) : undefined;
}

/** Who's a member of a document on its own (`thread:t1`): contacts in a chat, say. */
const membersOn = async (key: string, ctx: ReadContext) =>
  new Set((await ctx.db.collection<Member>("member").find({ space: key })).map((m) => m.member));

const needsShare = (from: string[], named: string[]) =>
  Object.assign(
    new Error(
      `That would show what came from ${named.join(", ")} to people who can't see it: ` +
        "a person who can has to share it.",
    ),
    { code: "needs_share", sources: from },
  );

/** Spaces as people say them: by name; a Personal space as its owner's (by their name). */
async function described(ids: string[], ctx: ReadContext): Promise<string[]> {
  const spaces = await ctx.db.collection<
    { _id: string; name: string; kind: string; owner?: string }
  >(
    "space",
  ).find({ _id: { $in: ids } });
  const owners = spaces.flatMap((s) => s.kind === "personal" && s.owner ? [s.owner] : []);
  const names = owners.length
    ? namesOf(
      await ctx.db.collection<{ _id: string; name?: string }>(PROFILE).find({
        _id: { $in: owners },
      }),
    )
    : {};
  return ids.map((id) => {
    const space = spaces.find((s) => s._id === id);
    if (!space) return "another space";
    return space.kind === "personal" && space.owner
      ? `${nameOf(space.owner, names)}'s Personal space`
      : space.name;
  });
}

/** What a space's members all see, besides it: the spaces it draws on. */
const covered = async (space: string, ctx: ReadContext) =>
  new Set([space, ...(await reachOf({ kind: "space", id: space }, ctx)).keys()]);

export const labels: Labels = {
  read(collection, docs, ctx) {
    const all = sharedOf(ctx);
    const shared = entryOf(all, collection);
    // A document that's a member (an agent) is meant for everywhere it works: reading it labels nothing.
    if (!shared || shared.member) return [];
    const field = shared.field ?? "in";
    return docs.flatMap((doc) => {
      const whole = wholeOf(collection, doc, all);
      return [
        ...(whole
          ? [`${OWN}${whole}`]
          : typeof doc[field] === "string"
          ? [doc[field] as string]
          : []),
        ...(Array.isArray(doc.sources) ? doc.sources as string[] : []),
      ];
    });
  },
  async write(actor, collection, doc, read, ctx) {
    const all = sharedOf(ctx);
    const shared = entryOf(all, collection);
    const space = shared ? doc[shared.field ?? "in"] : undefined;
    if (typeof space !== "string") return doc;
    const seen = await covered(space, ctx);
    // Who else it's for: whoever the document it goes in is shared with on its own (a contact).
    const whole = wholeOf(collection, doc, all);
    const outside = whole ? await membersOn(whole, ctx) : new Set<string>();
    const found = new Set<string>();
    for (const label of read) {
      if (!label.startsWith(OWN)) {
        // A space: its members see it; someone in only this document doesn't.
        if (!seen.has(label) || outside.size) found.add(label);
        continue;
      }
      const key = label.slice(OWN.length);
      if (key === whole) continue;
      const home = await homeOf(key, ctx);
      if (!home) continue;
      const on = outside.size ? await membersOn(key, ctx) : outside;
      if (!seen.has(home) || [...outside].some((m) => !on.has(m))) found.add(home);
    }
    const foreign = [...found];
    if (!foreign.length) return doc;
    // Where it works (`in`): an agent writing elsewhere what not everyone there can see is refused.
    const elsewhere = typeof actor.in === "string" && actor.in !== space;
    if (actor.kind === "agent" && (elsewhere || !shared!.labels)) {
      throw needsShare(foreign, await described(foreign, ctx));
    }
    if (!shared!.labels) return doc;
    const sources = [...new Set([...(doc.sources as string[] ?? []), ...foreign])].sort();
    return { ...doc, sources };
  },
};
