/**
 * The directory's settings, its `directory` resource: the schema new orgs
 * share (`pool`, "orgs" by default; a big org is placed apart by changing
 * its placement), and the emails of platform staff to start with.
 */
import type { ReadContext } from "../../../../runtime/mod.ts";

export type DirectorySettings = { pool?: string; staff?: string[] };

export const settingsOf = (ctx: { resources: ReadContext["resources"] }): DirectorySettings =>
  (ctx.resources.directory ?? {}) as DirectorySettings;

/** Where a new org's rows go: the shared schema, as its own tenant. */
export const placementOf = (ctx: { resources: ReadContext["resources"] }, _org: string) => ({
  schema: settingsOf(ctx).pool ?? "orgs",
});

/** Whether someone is platform staff: by their sign-in, or the email they verified. */
export async function isStaff(ctx: ReadContext, person: string, email?: string) {
  const listed = (settingsOf(ctx).staff ?? []).map((e) => e.toLowerCase());
  const known = email ? email.toLowerCase() : undefined;
  if (known && listed.includes(known)) return true;
  if (listed.includes(person.toLowerCase())) return true;
  const kept = ctx.db.collection("staff");
  return !!(await kept.findOne({ _id: person }) || (known && await kept.findOne({ _id: known })));
}
