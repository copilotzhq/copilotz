/**
 * The rules, as filters (the runtime's `guard`). A shared collection's
 * documents live `in` a space (the `shared` resource names them and their
 * field): an actor reads those in spaces they may read, and writes those in
 * spaces they may write (or manage, for some), plus documents shared with
 * them on their own and those documents' parts (a chat's messages come with
 * it), a contact only what its collection lets one read (a chat's messages,
 * not its agents' private steps); documents that are members (agents) are
 * read where they work too. A
 * query that names a space, or a document it reaches, needs nothing more:
 * it goes to the store as it is. Spaces and memberships are readable where reached and
 * changed only by those who manage them (and one's own memberships read by
 * its own key: where a contact's chats are); invitations are their
 * managers', and read by whom they're to (by the email they signed in with).
 */
import { type Actor, failure, type Filter, type Guard } from "../../../../runtime/mod.ts";
import { membersOf } from "./agents.ts";
import { homeOf, memberKey, type Reach, reachOf, type Verb, where } from "./reach.ts";

/**
 * The `shared` resource: collections whose documents live in spaces, the
 * field saying where (`in`), whether they keep labels (see labels.ts), what
 * changing one needs where it lives (`write`: "write" by default, "manage"
 * for those only its managers change), whether its documents are members
 * of spaces themselves (`member`: the kind, `agent` for agents people make),
 * readable too where they're members, and whether each is part of a document
 * of another shared collection (`part`: that collection, which its field of
 * the same name names: a message's `thread`), reached with it when that
 * document is shared on its own, and what of it a contact reads (`contact`:
 * a filter its documents must match too, for a contact acting itself, never
 * the agent working for it: a chat's messages without its agents' private
 * steps).
 */
export type Shared = Record<
  string,
  {
    field?: string;
    labels?: boolean;
    write?: Verb;
    member?: string;
    part?: string;
    contact?: Filter;
  }
>;

/** The documents of `on` reached on their own with `verb`: each id, and the space it lives in. */
const held = (reach: Reach, verb: Verb, on: string): [string, string][] =>
  [...reach].flatMap(([key, r]) =>
    r.on === on && r.home && r.can.has(verb)
      ? [[key.slice(on.length + 1), r.home] as [string, string]]
      : []
  );

/** The ids a filter's condition names by equality (a string, `$eq`, `$in` of strings); else none. */
const idsIn = (condition: unknown): string[] | undefined => {
  if (typeof condition === "string") return [condition];
  if (!condition || typeof condition !== "object") return undefined;
  const { $eq, $in, ...rest } = condition as { $eq?: unknown; $in?: unknown };
  if (Object.keys(rest).length) return undefined;
  if (typeof $eq === "string" && $in === undefined) return [$eq];
  if (Array.isArray($in) && $eq === undefined && $in.every((id) => typeof id === "string")) {
    return $in as string[];
  }
  return undefined;
};

export const rules: Guard = async (actor, { collection, access, filter, direct }, ctx) => {
  const shared = (ctx.resources.shared ?? {}) as Shared;
  const own = ["space", "member", "request", "invitation"];
  if (!Object.hasOwn(shared, collection) && !own.includes(collection)) return undefined;
  const reach = await reachOf(actor, ctx);
  if (collection === "invitation") {
    const managed = { space: { $in: where(reach, "manage") } };
    if (access === "write" || actor.kind !== "person" || actor.within) return managed;
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
    // Who's where isn't content: an agent reads it as far as the person it works for reaches.
    const by = access === "read" && actor.for ? await reachOf(actor.for as Actor, ctx) : reach;
    const spaces = where(by, access === "read" ? "read" : "manage");
    if (collection === "space") return { _id: { $in: spaces } };
    // Where one is a member, asked by its own key: a contact finds its chats so.
    if (access === "read" && filter?.member === memberKey(actor)) {
      return { member: memberKey(actor) };
    }
    // Who a document of a space is shared with on its own (a contact, in a chat), asked by its key.
    const named = filter?.space;
    if (access === "read" && typeof named === "string" && !spaces.includes(named)) {
      const home = await homeOf(named, ctx);
      if (by.has(named) || (home && spaces.includes(home))) return { space: named };
    }
    return { space: { $in: spaces } };
  }
  const { field = "in", labels, write = "write", member, part, contact } = shared[collection];
  const verb = access === "read" ? "read" : write;
  const spaces = where(reach, verb);
  // A labelled document needs its sources reached too, to read or change it; a contact acting
  // itself, what its collection lets a contact reach of it (not an agent's private steps).
  const also: Filter[] = [
    ...(labels ? [{ sources: { $not: { $elemMatch: { $nin: where(reach, "read") } } } }] : []),
    ...(contact && actor.kind === "contact" ? [contact] : []),
  ];
  const sourced: Filter | undefined = also.length > 1 ? { $and: also } : also[0];
  const named = filter?.[field];
  if (typeof named === "string" && spaces.includes(named)) return sourced ?? true;
  const and = (f: Filter) => sourced ? { $and: [f, sourced] } : f;
  // Documents shared on their own, and their parts (a chat shared with a contact, its messages):
  // each only where it lives, so nothing written as one of them lands in another space.
  const docs = held(reach, verb, collection);
  const wholes = part ? held(reach, verb, part) : [];
  // A contact's own read from its browser names what of its own it reads: documents it holds, or
  // its chats' parts. Anything wider would run again on every change to the collection.
  if (direct && actor.kind === "contact") {
    const mine = (ids: string[] | undefined, of: [string, string][]) =>
      !!ids?.length && ids.every((id) => of.some(([held]) => held === id));
    if (!mine(idsIn(filter?._id), docs) && !(part && mine(idsIn(filter?.[part]), wholes))) {
      throw failure(
        "forbidden",
        `A contact reads "${collection}" naming what of its own it reads: ` +
          (part ? `a ${part} of its own (${part})` : "a document of its own (_id)"),
        { public: true },
      );
    }
  }
  const whole = part ? filter?.[part] : undefined;
  const asked = wholes.find(([id]) => id === whole);
  if (asked) return and({ [field]: asked[1] });
  // Documents that are members (agents) are read where they work too.
  const members = member && access === "read" ? await membersOf(ctx, spaces, member) : [];
  // Only what's reached, so a store can use its indexes (a contact reaches no space at all).
  const anyOf: Filter[] = [
    ...(spaces.length ? [{ [field]: { $in: spaces } }] : []),
    ...docs.map(([id, home]) => ({ _id: id, [field]: home })),
    ...(members.length ? [{ _id: { $in: members } }] : []),
    ...wholes.map(([id, home]) => ({ [part!]: id, [field]: home })),
  ];
  return and(anyOf.length > 1 ? { $or: anyOf } : anyOf[0] ?? { [field]: { $in: [] } });
};
