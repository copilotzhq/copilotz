/**
 * Giving a member a role in a space, however they came to it (a manager
 * setting it, a request granted): the role is one this app has, an agent, a
 * key or a contact never manages, a contact is let into documents only (its
 * chat), never a whole space, and a space keeps a manager.
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
  if (member.startsWith("key:") && verbs.includes("manage")) {
    throw invalid("A key works here as a viewer or an editor.");
  }
  if (member.startsWith("contact:") && verbs.includes("manage")) {
    throw invalid("A contact reads or writes in what's shared with them, never manages it.");
  }
}

export async function seat(
  ctx: Context,
  space: string,
  member: string,
  role: string,
  contacts?: "read",
) {
  checkRole(ctx, member, role);
  if (member.startsWith("contact:")) {
    throw invalid("A contact is let into a document (its chat), never into a whole space.");
  }
  if (contacts && !member.startsWith("space:")) {
    throw invalid("Only a space drawing on this one lets its contacts read it (contacts).");
  }
  await keepsAManager(ctx, space, member, role);
  await ctx.as().db.collection("member").replaceOne(
    { _id: `${space}|${member}` },
    { member, space, role, ...(contacts ? { contacts } : {}) },
    { upsert: true },
  );
}
