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
 * make) carry nothing: they're meant for everywhere they work.
 */
import type { Labels, ReadContext } from "../../../../runtime/mod.ts";
import { reachOf } from "./reach.ts";
import { nameOf, namesOf, PROFILE } from "./names.ts";
import type { Shared } from "./rules.ts";

const sharedOf = (ctx: ReadContext) => (ctx.resources.shared ?? {}) as Shared;

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
    const shared = sharedOf(ctx)[collection];
    // A document that's a member (an agent) is meant for everywhere it works: reading it labels nothing.
    if (!shared || shared.member) return [];
    const field = shared.field ?? "in";
    return docs.flatMap((doc) => [
      ...(typeof doc[field] === "string" ? [doc[field] as string] : []),
      ...(Array.isArray(doc.sources) ? doc.sources as string[] : []),
    ]);
  },
  async write(actor, collection, doc, read, ctx) {
    const shared = sharedOf(ctx)[collection];
    const space = shared ? doc[shared.field ?? "in"] : undefined;
    if (typeof space !== "string") return doc;
    const seen = await covered(space, ctx);
    const foreign = read.filter((label) => !seen.has(label));
    if (!foreign.length) return doc;
    const elsewhere = typeof actor.at === "string" && actor.at !== space;
    if (actor.kind === "agent" && (elsewhere || !shared!.labels)) {
      throw needsShare(foreign, await described(foreign, ctx));
    }
    if (!shared!.labels) return doc;
    const sources = [...new Set([...(doc.sources as string[] ?? []), ...foreign])].sort();
    return { ...doc, sources };
  },
};
