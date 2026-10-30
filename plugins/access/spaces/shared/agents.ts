/**
 * Agents as members (with the chat plugin): each one a member of its own,
 * `agent:<name>`, with a role (never manager): an editor answers there, a
 * viewer only reads it (for chats elsewhere). A new space starts with the
 * app's default agents (its `agents` resource's), the first answering its
 * new chats (the space's `agent`). Agents people make are documents (the
 * `shared` resource marks their collection `member: "agent"`): a manager
 * adds one they've met (where it belongs, or works in a space they reach),
 * or one the app declares.
 */
import type { Context, ReadContext, TransactionScope } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { ROLES, type Verb } from "./reach.ts";
import type { Shared } from "./rules.ts";

type Declared = Record<string, { default?: boolean }>;

/** The app's agents that join new spaces: its defaults, or the first it declares. */
export function startingAgents(ctx: Pick<Context, "resources">): string[] {
  const declared = (ctx.resources.agents ?? {}) as Declared;
  const chosen = Object.keys(declared).filter((name) => declared[name].default);
  return chosen.length ? chosen : Object.keys(declared).slice(0, 1);
}

/** A new space's agents, as members (editors), and its `agent` field: who answers its new chats. */
export async function seat(tx: TransactionScope, ctx: Pick<Context, "resources">, space: string) {
  const agents = startingAgents(ctx);
  for (const agent of agents) {
    await tx.db.collection("member").insertOne({
      _id: `${space}|agent:${agent}`,
      member: `agent:${agent}`,
      space,
      role: "editor",
    });
  }
  return agents[0] ? { agent: agents[0] } : {};
}

/** The collection whose documents are members of kind `kind` (`agent`), if one is. */
export function backing(ctx: Pick<ReadContext, "resources">, kind: string): string | undefined {
  const shared = (ctx.resources.shared ?? {}) as Shared;
  return Object.keys(shared).find((name) => shared[name].member === kind);
}

/** The ids of `kind` members of `spaces` (the agents working there). */
export async function membersOf(
  ctx: Pick<ReadContext, "db">,
  spaces: string[],
  kind: string,
): Promise<string[]> {
  if (!spaces.length) return [];
  const found = await ctx.db.collection<Member>("member").find({ space: { $in: spaces } });
  const prefix = `${kind}:`;
  return [
    ...new Set(
      found.filter((m) => !m.on && m.member.startsWith(prefix))
        .map((m) => m.member.slice(prefix.length)),
    ),
  ];
}

/**
 * Throws unless the caller may add agent `id`: one the app declares, or one
 * people made that they read (the rules: where it belongs, or works in a
 * space they reach). An app with neither (no chat) adds any.
 */
export async function mustKnow(ctx: Context, id: string) {
  const declared = (ctx.resources.agents ?? {}) as Declared;
  if (declared[id]) return;
  const collection = backing(ctx, "agent");
  if (!collection && !Object.keys(declared).length) return;
  if (collection && await ctx.db.collection(collection).findOne({ _id: id })) return;
  throw Object.assign(new Error(`No agent "${id}" that you know of.`), { code: "invalid" });
}

/**
 * After agent `id` left `spaces` (or answers there no more): where it
 * answered new chats, the next agent answering there does (the app's
 * defaults first), or none.
 */
export async function unseat(system: Context, id: string, spaces: string[]) {
  const answered = await system.db.collection<{ _id: string; agent?: string }>("space").find({
    _id: { $in: spaces },
    agent: id,
  });
  for (const space of answered) {
    const roster = await rosterIn(system, space._id);
    if (roster.includes(id)) continue;
    const [next] = roster;
    await system.db.collection("space").updateOne(
      { _id: space._id },
      next ? { $set: { agent: next } } : { $unset: { agent: "" } },
    );
  }
}

/**
 * The agents that answer in `space`: those whose role there lets them
 * write (editors); a viewer reads it for chats elsewhere. The app's
 * defaults first, then by name.
 */
export async function rosterIn(ctx: Pick<ReadContext, "db" | "resources">, space: string) {
  const roles = { ...ROLES, ...(ctx.resources.roles ?? {}) as Record<string, Verb[]> };
  const starting = startingAgents(ctx);
  const members = await ctx.db.collection<Member>("member").find({ space });
  return members
    .filter((m) => !m.on && m.member.startsWith("agent:") && roles[m.role]?.includes("write"))
    .map((m) => m.member.slice("agent:".length))
    .sort((a, b) =>
      Number(!starting.includes(a)) - Number(!starting.includes(b)) || a.localeCompare(b)
    );
}
