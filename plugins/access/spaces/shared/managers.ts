/**
 * A shared space always keeps a manager: someone to let people in, rename
 * it, and hand it on. Removing, demoting or the leaving of its last one is
 * refused until someone else manages it.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { forbidden } from "../../../../runtime/mod.ts";
import { ROLES, type Verb } from "./reach.ts";

/** Throws if `key` (`person:ana`) is `space`'s last manager and `next` (their role after, if any) doesn't manage. */
export async function keepsAManager(ctx: Context, space: string, key: string, next?: string) {
  const roles = { ...ROLES, ...(ctx.resources.roles ?? {}) as Record<string, Verb[]> };
  const manages = (role?: string) => !!role && (roles[role] ?? []).includes("manage");
  if (manages(next)) return;
  const members = await ctx.as().db.collection<{ member: string; role: string; on?: string }>(
    "member",
  ).find({ space, on: { $exists: false } });
  const managers = members.filter((m) => manages(m.role) && !m.member.startsWith("agent:"));
  if (managers.length === 1 && managers[0].member === key) {
    const you = ctx.actor && key === `${ctx.actor.kind}:${ctx.actor.id}`;
    throw forbidden(
      `${you ? "You're" : "They're"} this space's only manager: make someone else a manager first.`,
    );
  }
}
