/**
 * What an actor reaches: the spaces they're a member of, and the spaces those
 * draw on, each with what the roles along the path allow (`read`, `write`,
 * `manage`), and the documents shared with them on their own (a contact's
 * chat), each with the space it lives in (`home`). An agent acting for
 * someone reaches what both reach: a space, or a document one of them reaches
 * on its own and the other through its space. An actor limited to one space
 * (`within`: a key's work) reaches only that. Everything that asks what
 * someone may do asks here, so those limits hold everywhere.
 */
import type { Actor, ReadContext } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";

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

/** How an actor appears as a member: `person:ana`. */
export const memberKey = (actor: { kind: string; id: string }) => `${actor.kind}:${actor.id}`;

export const rolesOf = (ctx: Pick<ReadContext, "resources">): Record<string, Verb[]> => ({
  ...ROLES,
  ...(ctx.resources.roles ?? {}) as Record<string, Verb[]>,
});

/**
 * Spaces reached from `key`, through the spaces it's in, each with the verbs
 * along the path: one query per level (the owner keeps them cached).
 */
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

/** Someone's role in the org, if they have one. */
export async function orgRoleOf(actor: Actor, ctx: ReadContext): Promise<OrgRole | undefined> {
  if (actor.kind !== "person") return undefined;
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

/** What `actor` reaches; an agent acting for someone (`for`), what both reach. */
export async function reachOf(actor: Actor, ctx: ReadContext): Promise<Reach> {
  const reach = await unlimited(actor, ctx);
  const { within } = actor;
  const limited = typeof within === "string"
    ? new Map([...reach].filter(([space]) => space === within))
    : reach;
  // A space put away is read and managed, not written in, until it's brought back: nor what's in it.
  const archived = new Set(
    (await ctx.db.collection("space").find({ archived: { $exists: true } })).map((s) =>
      String(s._id)
    ),
  );
  for (const [key, held] of limited) {
    if (held.can.has("write") && archived.has(held.home ?? key)) {
      limited.set(key, { ...held, can: new Set([...held.can].filter((v) => v !== "write")) });
    }
  }
  return limited;
}

async function unlimited(actor: Actor, ctx: ReadContext): Promise<Reach> {
  const principal = actor.for as Actor | undefined;
  if (!principal) {
    if (actor.kind === "person" && actor.staff === true) return await everything(ctx);
    const role = await orgRoleOf(actor, ctx);
    if (runsOrg(role)) return await everything(ctx);
    const own = await housed(await walk(memberKey(actor), ctx), ctx);
    // Members see who's in the org; guests only the spaces they're in.
    if (role === "member") own.set(ORG, { can: new Set<Verb>(["read"]) });
    return own;
  }
  const own = await housed(await walk(memberKey(actor), ctx), ctx);
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
    if (held.on && shared[held.on]) {
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

/** The spaces (or documents) reached where `verb` is allowed. */
export const where = (reach: Reach, verb: Verb, on?: string) =>
  [...reach].filter(([, r]) => r.can.has(verb) && (on === undefined ? !r.on : r.on === on))
    .map(([space]) => on === undefined ? space : space.slice(on.length + 1));
