/**
 * The rules, as filters (the runtime's `guard`). A shared collection's
 * documents live `in` a space (the `shared` resource names them and their
 * field): an actor reads those in spaces they may read, and writes those in
 * spaces they may write (or manage, for some), plus documents shared with
 * them on their own; documents that are members (agents) are read where
 * they work too. A query that names a space it reaches needs nothing more:
 * it goes to the store as it is. Spaces and memberships are readable where reached and
 * changed only by those who manage them; invitations are their managers',
 * and read by whom they're to (by the email they signed in with).
 */
import type { Filter, Guard } from "../../../../runtime/mod.ts";
import { membersOf } from "./agents.ts";
import { memberKey, reachOf, type Verb, where } from "./reach.ts";

/**
 * The `shared` resource: collections whose documents live in spaces, the
 * field saying where (`in`), whether they keep labels (see labels.ts), what
 * changing one needs where it lives (`write`: "write" by default, "manage"
 * for those only its managers change), and whether its documents are
 * members of spaces themselves (`member`: the kind, `agent` for agents
 * people make), readable too where they're members.
 */
export type Shared = Record<
  string,
  { field?: string; labels?: boolean; write?: Verb; member?: string }
>;

export const rules: Guard = async (actor, { collection, access, filter }, ctx) => {
  const shared = (ctx.resources.shared ?? {}) as Shared;
  const own = ["space", "member", "request", "invitation"];
  if (!(collection in shared) && !own.includes(collection)) return undefined;
  const reach = await reachOf(actor, ctx);
  if (collection === "invitation") {
    const managed = { space: { $in: where(reach, "manage") } };
    if (access === "write" || actor.kind !== "person") return managed;
    const { email } = await ctx.call<{ email: string | null }>("person.email", {
      person: actor.id,
    });
    return email ? { $or: [managed, { email }] } : managed;
  }
  // Requests: seen by the managers of their space, and by whom they're for.
  if (collection === "request") {
    return { $or: [{ space: { $in: where(reach, "manage") } }, { member: memberKey(actor) }] };
  }
  if (collection === "space" || collection === "member") {
    const spaces = where(reach, access === "read" ? "read" : "manage");
    return collection === "space" ? { _id: { $in: spaces } } : { space: { $in: spaces } };
  }
  const { field = "in", labels, write = "write", member } = shared[collection];
  const verb = access === "read" ? "read" : write;
  const spaces = where(reach, verb);
  // A labelled document needs its sources reached too, to read or change it.
  const sourced: Filter | undefined = labels
    ? { sources: { $not: { $elemMatch: { $nin: where(reach, "read") } } } }
    : undefined;
  const named = filter?.[field];
  if (typeof named === "string" && spaces.includes(named)) return sourced ?? true;
  const docs = where(reach, verb, collection);
  // Documents that are members (agents) are read where they work too.
  if (member && access === "read") docs.push(...await membersOf(ctx, spaces, member));
  const inSpaces: Filter = { [field]: { $in: spaces } };
  const reached = docs.length ? { $or: [inSpaces, { _id: { $in: docs } }] } : inSpaces;
  return sourced ? { $and: [reached, sourced] } : reached;
};
