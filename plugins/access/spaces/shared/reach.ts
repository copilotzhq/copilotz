/**
 * What an actor reaches: the spaces they're a member of, and the spaces those
 * draw on, each with what the roles along the path allow (`read`, `write`,
 * `manage`). An agent acting for someone reaches what both reach.
 */
import type { Actor, ReadContext } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";

export type Verb = "read" | "write" | "manage";
/** Each space reached, with what may be done there; documents shared on their own say their collection. */
export type Reach = Map<string, { can: Set<Verb>; on?: string }>;

/** Roles by name, each a list of verbs: the `roles` resource, these by default. */
export const ROLES: Record<string, Verb[]> = {
  viewer: ["read"],
  editor: ["read", "write"],
  manager: ["read", "write", "manage"],
};

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

/** What `actor` reaches; an agent acting for someone (`for`), what both reach. */
export async function reachOf(actor: Actor, ctx: ReadContext): Promise<Reach> {
  const own = await walk(memberKey(actor), ctx);
  const principal = actor.for as Actor | undefined;
  if (!principal) return own;
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
    .map(([space]) => space);
