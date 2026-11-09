/**
 * What an actor reaches: the spaces they're a member of, and the spaces those
 * draw on, each with what the roles along the path allow (`read`, `write`,
 * `manage`), and the documents shared with them on their own (a contact's
 * chat), each with the space it lives in (`home`). An agent acting for
 * someone reaches what both reach: a space, or a document one of them reaches
 * on its own and the other through its space. A key of a person's
 * (`actor.key`) is a member of its space, `key:<id>`, and works for its
 * person the same way: it reaches what its membership and its person both
 * reach, and has no org role, so even an admin's key reaches only its space,
 * at its role. Everything that asks what someone may do asks here, so those
 * limits hold everywhere.
 *
 * **Where the work is.** Work for someone (an agent's, a key's) that is
 * somewhere (`actor.in`, a space) reaches only there, and what that space
 * draws on, at most with the role it draws on it with: the person's reach ∩
 * the agent's memberships ∩ where it works. So North working for Ana in
 * Launch reaches Launch and its sources, never Ana's other spaces, whose
 * words would otherwise end up before Launch's members. Ana's own Personal
 * space is the one exception: only she sees it, so her agents there reach
 * all she does. Work done as a person for them (`onBehalf`: a tool acting
 * as its agent's person, a routine as its maker) is narrowed the same way. A
 * person acting themselves isn't (they reach what they reach from any page),
 * nor is code acting as them for themselves, nor work that's nowhere in
 * particular.
 *
 * **Kept.** Reach is asked on every op an actor's work makes. It's kept in
 * the owner by everything it depends on (who, for whom, where: `reachKey`)
 * until a commit changes a membership or a space it read (the runtime's
 * `kept`), and an agent's keeps its person's and its own memberships apart,
 * so they're worked out once for every place it works. What's kept is
 * shared: callers never change a `Reach` they're given.
 */
import { type Actor, onBehalf, type ReadContext, whereOf } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { PERSONAL } from "./personal.ts";

export type Verb = "read" | "write" | "manage";
/**
 * Each space reached, with what may be done there; documents shared on their
 * own say their collection (`on`) and the space they live in (`home`).
 */
export type Reach = Map<string, Reached>;
type Reached = { can: Set<Verb>; on?: string; home?: string };

/**
 * Where a document shared on its own is kept among reach and memberships: its
 * own name, `note:n1`, so a document never passes for a space with the same id.
 */
export const docKey = (on: string, id: string) => `${on}:${id}`;

/** Roles by name, each a list of verbs: the `roles` resource, these by default. */
export const ROLES: Record<string, Verb[]> = {
  viewer: ["read"],
  editor: ["read", "write"],
  manager: ["read", "write", "manage"],
};

/**
 * The org itself, where people's org roles are kept, as memberships of it:
 * `{ space: "*", member: "person:ana", role: "admin" }`. Owners and admins
 * reach everything in the org, Personal spaces too (they manage what people
 * leave behind); members read who's in it; guests reach only the spaces
 * they were let into. Platform staff (an actor marked `staff`) reach it all.
 */
export const ORG = "*";
export const ORG_ROLES = ["owner", "admin", "member", "guest"] as const;
export type OrgRole = typeof ORG_ROLES[number];
const RUN = new Set<string>(["owner", "admin"]);
/** Whether an org role runs the org. */
export const runsOrg = (role?: string | null): boolean => !!role && RUN.has(role);
const ALL: Verb[] = ["read", "write", "manage"];

/** The key of a person's an actor calls with (`actor.key`), if it's one. */
export const keyOf = (actor: { kind: string; key?: unknown }): string | undefined =>
  actor.kind === "person" && typeof actor.key === "string" ? actor.key : undefined;

/** How an actor appears as a member: `person:ana`; a key of hers, `key:<id>`. */
export const memberKey = (actor: { kind: string; id: string; key?: unknown }): string => {
  const key = keyOf(actor);
  return key === undefined ? `${actor.kind}:${actor.id}` : `key:${key}`;
};

export const rolesOf = (ctx: Pick<ReadContext, "resources">): Record<string, Verb[]> =>
  // No prototype: a role is one the app names, so "toString" or "__proto__" is no role at all.
  Object.assign(
    Object.create(null) as Record<string, Verb[]>,
    ROLES,
    (ctx.resources.roles ?? {}) as Record<string, Verb[]>,
  );

/**
 * Spaces reached from `key`, through the spaces it's in, each with the verbs
 * along the path: one query per level (the owner keeps them cached), with
 * where each document reached on its own lives; kept apart, as an agent's
 * are the same wherever it works and whomever for.
 */
const membershipsOf = (key: string, ctx: ReadContext): Promise<Reach> =>
  ctx.kept(`spaces.members:${key}`, async (ctx) => await housed(await walk(key, ctx), ctx));

async function walk(key: string, ctx: ReadContext): Promise<Reach> {
  const roles = rolesOf(ctx);
  const members = ctx.db.collection<Member>("member");
  const reach: Reach = new Map();
  let frontier = new Map<string, Set<Verb>>([[key, new Set<Verb>(["read", "write", "manage"])]]);
  for (let depth = 0; frontier.size && depth < 8; depth++) {
    const keys = [...frontier.keys()];
    const found = await members.find(
      keys.length === 1 ? { member: keys[0] } : { member: { $in: keys } },
    );
    const next = new Map<string, Set<Verb>>();
    for (const m of found) {
      if (m.space === ORG) continue;
      const allowed = frontier.get(m.member)!;
      const can = new Set((roles[m.role] ?? []).filter((verb) => allowed.has(verb)));
      const known = reach.get(m.space);
      const merged = new Set([...known?.can ?? [], ...can]);
      if (known && merged.size === known.can.size) continue;
      reach.set(m.space, { can: merged, ...(m.on ? { on: m.on } : {}) });
      // A space that's in another draws on it: what it may do there, at most what you may here.
      if (!m.on) next.set(`space:${m.space}`, merged);
    }
    frontier = next;
  }
  return reach;
}

/** Someone's role in the org, if they have one: never a key's. */
export async function orgRoleOf(actor: Actor, ctx: ReadContext): Promise<OrgRole | undefined> {
  if (actor.kind !== "person" || keyOf(actor) !== undefined) return undefined;
  const held = await ctx.db.collection<Member>("member").findOne({
    _id: `${ORG}|${memberKey(actor)}`,
  });
  return held?.role as OrgRole | undefined;
}

/** Everything in the org, every verb: what its owners, admins and staff reach. */
async function everything(ctx: ReadContext): Promise<Reach> {
  const spaces = await ctx.db.collection("space").find({});
  const reach: Reach = new Map(spaces.map((s) => [String(s._id), { can: new Set(ALL) }]));
  reach.set(ORG, { can: new Set(ALL) });
  return reach;
}

/**
 * What `actor` reaches; an agent acting for someone (`for`), what both
 * reach; a key, what it and its person both reach; either, somewhere
 * (`in`), only there and what it draws on. Kept (see the module's header):
 * never change what it answers.
 */
export function reachOf(actor: Actor, ctx: ReadContext): Promise<Reach> {
  return ctx.kept(`spaces.reach:${reachKey(actor)}`, (ctx) => reaching(actor, ctx));
}

/**
 * What an actor's reach depends on besides what it reads: who, a key, staff,
 * for whom (as theirs), and where, for work for someone (a person's own
 * isn't narrowed, so it's the same on every page).
 */
export function reachKey(actor: Actor): string {
  return JSON.stringify([
    actor.kind,
    actor.id,
    keyOf(actor) ?? null,
    actor.staff === true,
    actor.for && typeof actor.for === "object" ? reachKey(actor.for as Actor) : null,
    narrows(actor) ? whereOf(actor) ?? null : null,
  ]);
}

/**
 * Whether where an actor's work is narrows what it reaches: work for someone
 * (an agent's, a key's), or done as a person for them (`onBehalf`: a routine,
 * a tool acting as its agent's person); never a person's own, nor code
 * acting as them for themselves.
 */
const narrows = (actor: Actor): boolean =>
  !!worksFor(actor) || (actor.kind === "person" && onBehalf(actor));

async function reaching(actor: Actor, ctx: ReadContext): Promise<Reach> {
  const reach = await unlimited(actor, ctx);
  // A space put away is read and managed, not written in, until it's brought back: nor what's in it.
  const archived = new Set(
    (await ctx.db.collection("space").find({ archived: { $exists: true } })).map((s) =>
      String(s._id)
    ),
  );
  for (const [key, held] of reach) {
    if (held.can.has("write") && archived.has(held.home ?? key)) {
      reach.set(key, { ...held, can: new Set([...held.can].filter((v) => v !== "write")) });
    }
  }
  const where = whereOf(actor);
  return narrows(actor) && where !== undefined
    ? await narrowed(reach, where, worksFor(actor) ?? actor, ctx)
    : reach;
}

/**
 * `reach`, for work done in `space` for `principal`: only that space, and
 * what it draws on, with at most the verbs it draws on it with (its role
 * there), documents shared on their own where they live. In the
 * principal's own Personal space, all of it: nobody else sees what's said
 * there.
 */
async function narrowed(
  reach: Reach,
  space: string,
  principal: Actor,
  ctx: ReadContext,
): Promise<Reach> {
  const found = await ctx.db.collection<{ kind?: string; owner?: string }>("space").findOne({
    _id: space,
  });
  if (found?.kind === PERSONAL && principal.kind === "person" && found.owner === principal.id) {
    return reach;
  }
  const drawn = await reachOf({ kind: "space", id: space }, ctx);
  const all = new Set<Verb>(ALL);
  const within: Reach = new Map();
  for (const [key, held] of reach) {
    const at = held.on ? held.home : key;
    const can = at === space
      ? all
      : at !== undefined && !drawn.get(at)?.on
      ? drawn.get(at)?.can
      : undefined;
    const verbs = can ? [...held.can].filter((verb) => can.has(verb)) : [];
    if (verbs.length) within.set(key, { ...held, can: new Set(verbs) });
  }
  return within;
}

/** Whom an actor works for: an agent, whoever it acts for (`for`); a key, the person whose it is. */
const worksFor = (actor: Actor): Actor | undefined =>
  (actor.for as Actor | undefined) ??
    (keyOf(actor) !== undefined ? { kind: "person", id: actor.id } : undefined);

async function unlimited(actor: Actor, ctx: ReadContext): Promise<Reach> {
  const principal = worksFor(actor);
  if (!principal) {
    if (actor.kind === "person" && actor.staff === true) return await everything(ctx);
    const role = await orgRoleOf(actor, ctx);
    if (runsOrg(role)) return await everything(ctx);
    const own = new Map(await membershipsOf(memberKey(actor), ctx));
    // Members see who's in the org; guests only the spaces they're in.
    if (role === "member") own.set(ORG, { can: new Set<Verb>(["read"]) });
    return own;
  }
  const own = await membershipsOf(memberKey(actor), ctx);
  const theirs = await reachOf(principal, ctx);
  const both: Reach = new Map();
  /** `held` (one side's), with only the verbs the other side's `other` allows too. */
  const keep = (key: string, held: Reached, other: Reached | undefined) => {
    const can = new Set([...held.can].filter((verb) => other?.can.has(verb)));
    if (can.size) both.set(key, { ...held, can });
  };
  for (const [key, mine] of own) {
    // The same space or document; else a document it reaches on its own, in a space they reach.
    keep(key, mine, theirs.get(key) ?? (mine.home ? theirs.get(mine.home) : undefined));
  }
  for (const [key, other] of theirs) {
    // A document they reach on its own, in a space it reaches.
    if (!own.has(key) && other.home) keep(key, other, own.get(other.home));
  }
  return both;
}

/**
 * The space each document reached on its own lives in (`home`): its shared
 * collection's field says, read once per collection. Someone who reaches no
 * document on its own reads nothing here.
 */
async function housed(reach: Reach, ctx: ReadContext): Promise<Reach> {
  const shared = (ctx.resources.shared ?? {}) as Record<string, { field?: string }>;
  const ids = new Map<string, string[]>();
  for (const [key, held] of reach) {
    if (held.on && Object.hasOwn(shared, held.on)) {
      ids.set(held.on, [...ids.get(held.on) ?? [], key.slice(held.on.length + 1)]);
    }
  }
  for (const [on, wanted] of ids) {
    const field = shared[on].field ?? "in";
    const docs = await ctx.db.collection(on).find(
      wanted.length === 1 ? { _id: wanted[0] } : { _id: { $in: wanted } },
    );
    for (const doc of docs) {
      const key = docKey(on, String(doc._id));
      const home = doc[field];
      if (typeof home === "string") reach.set(key, { ...reach.get(key)!, home });
    }
  }
  return reach;
}

/**
 * The space a document shared on its own lives in, by its key (`thread:t1`):
 * its shared collection's field says. Undefined for anything else.
 */
export async function homeOf(key: string, ctx: ReadContext): Promise<string | undefined> {
  const at = key.indexOf(":");
  const [on, id] = [key.slice(0, at), key.slice(at + 1)];
  const shared = (ctx.resources.shared ?? {}) as Record<string, { field?: string }>;
  if (at < 1 || !Object.hasOwn(shared, on)) return undefined;
  const doc = await ctx.db.collection(on).findOne({ _id: id });
  const home = doc?.[shared[on].field ?? "in"];
  return typeof home === "string" ? home : undefined;
}

/** Lists made of a reach, by verb and kind: a reach is kept, so they're made once each. */
const listed = new WeakMap<Reach, Map<string, readonly string[]>>();

/** The spaces (or documents) reached where `verb` is allowed. Shared: never change it. */
export const where = (reach: Reach, verb: Verb, on?: string): string[] => {
  let lists = listed.get(reach);
  if (!lists) listed.set(reach, lists = new Map());
  const key = `${verb}\u0000${on ?? ""}`;
  let found = lists.get(key);
  if (!found) {
    found = Object.freeze(
      [...reach].filter(([, r]) => r.can.has(verb) && (on === undefined ? !r.on : r.on === on))
        .map(([space]) => on === undefined ? space : space.slice(on.length + 1)),
    );
    lists.set(key, found);
  }
  return found as string[];
};
