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
import type { Shared } from "./rules.ts";

const sharedOf = (ctx: ReadContext) => (ctx.resources.shared ?? {}) as Shared;

const needsShare = (from: string[]) =>
  Object.assign(
    new Error(
      `That would show what came from ${from.join(", ")} to people who can't see it: ` +
        "a person who can has to share it.",
    ),
    { code: "needs_share", sources: from },
  );

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
    if (actor.kind === "agent" && (elsewhere || !shared!.labels)) throw needsShare(foreign);
    if (!shared!.labels) return doc;
    const sources = [...new Set([...(doc.sources as string[] ?? []), ...foreign])].sort();
    return { ...doc, sources };
  },
};
