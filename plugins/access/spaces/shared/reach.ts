/**
 * What an actor reaches: the spaces they're a member of, and the spaces those
 * draw on, each with what the roles along the path allow (`read`, `write`,
 * `manage`). An agent acting for someone reaches what both reach, and an actor
 * limited to one space (`within`: a key's work) reaches only that. Everything
 * that asks what someone may do asks here, so those limits hold everywhere.
 */
import type { Actor, ReadContext } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";

export type Verb = "read" | "write" | "manage";
/** Each space reached, with what may be done there; documents shared on their own say their collection. */
export type Reach = Map<string, { can: Set<Verb>; on?: string }>;

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
const ALL: Verb[] = ["read", "write", "manage"];

/** How an actor appears as a member: `person:ana`. */
export const memberKey = (actor: { kind: string; id: string }) => `${actor.kind}:${actor.id}`;

const rolesOf = (ctx: ReadContext): Record<string, Verb[]> => ({
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
  return typeof within === "string"
    ? new Map([...reach].filter(([space]) => space === within))
    : reach;
}

async function unlimited(actor: Actor, ctx: ReadContext): Promise<Reach> {
  const principal = actor.for as Actor | undefined;
  if (!principal) {
    if (actor.kind === "person" && actor.staff === true) return await everything(ctx);
    const role = await orgRoleOf(actor, ctx);
    if (role && RUN.has(role)) return await everything(ctx);
    const own = await walk(memberKey(actor), ctx);
    // Members see who's in the org; guests only the spaces they're in.
    if (role === "member") own.set(ORG, { can: new Set<Verb>(["read"]) });
    return own;
  }
  const own = await walk(memberKey(actor), ctx);
  const theirs = await reachOf(principal, ctx);
  const both: Reach = new Map();
  for (const [space, mine] of own) {
    const other = theirs.get(space);
    if (!other) continue;
    const can = new Set([...mine.can].filter((verb) => other.can.has(verb)));
    if (can.size) both.set(space, { ...mine, can });
  }
  return both;
}

/** The spaces (or documents) reached where `verb` is allowed. */
export const where = (reach: Reach, verb: Verb, on?: string) =>
  [...reach].filter(([, r]) => r.can.has(verb) && (on === undefined ? !r.on : r.on === on))
    .map(([space]) => on === undefined ? space : space.slice(on.length + 1));
