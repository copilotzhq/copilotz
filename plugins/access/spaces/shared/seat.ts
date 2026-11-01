/**
 * Giving a member a role in a space, however they came to it (a manager
 * setting it, a request granted): the role is one this app has, an agent never
 * manages, and a space keeps a manager.
 */
import { type Context, invalid } from "../../../../runtime/mod.ts";
import { keepsAManager } from "./managers.ts";
import { rolesOf } from "./reach.ts";

/** Checks `role` for `member` (`person:ana`); keeping a manager only where it's a space's own. */
export function checkRole(ctx: Context, member: string, role: string) {
  const verbs = rolesOf(ctx)[role];
  if (!verbs) throw invalid(`No role "${role}".`);
  if (member.startsWith("agent:") && verbs.includes("manage")) {
    throw invalid("Agents work here as viewers or editors.");
  }
}

export async function seat(ctx: Context, space: string, member: string, role: string) {
  checkRole(ctx, member, role);
  await keepsAManager(ctx, space, member, role);
  await ctx.as().db.collection("member").replaceOne(
    { _id: `${space}|${member}` },
    { member, space, role },
    { upsert: true },
  );
}
