/**
 * The directory's settings, its `directory` resource:
 *
 * - `pool`: the schema new orgs share ("orgs" by default; a big org is
 *   placed apart by changing its placement);
 * - `staff`: the emails of platform staff to start with;
 * - `orgs`: the orgs' runtimes (`runtimes(open)`, the runtime's pool), the
 *   app's: each opened with the org's own store and plugins, and
 *   `member(dir, org)`. The directory's routes forward to them;
 * - `lobby`: what answers someone signed in nowhere (the sign-in page): a
 *   runtime with the page (`webPage`), or any fetch handler. Without one,
 *   they're told to sign in (401);
 * - `operations`: what staff may do to an org's rows (its stores know where
 *   they live): move them to another placement, export them, drop them.
 *   The directory closes the org first where it must.
 */
import type { ReadContext, Runtimes } from "copilotz";

/** An org as the directory opens it: its name, its kind, where its rows live. */
export type OrgInfo = {
  id: string;
  name: string;
  kind: "personal" | "team";
  placement: { schema: string };
  suspended?: true;
};

/** What staff may do to an org's rows: the app's, as its stores know where they live. */
export type Operations = {
  move?(org: OrgInfo, to: OrgInfo["placement"]): Promise<void>;
  export?(org: OrgInfo): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  drop?(org: OrgInfo): Promise<void>;
};

export type DirectorySettings = {
  pool?: string;
  staff?: string[];
  orgs?: Runtimes;
  lobby?: { fetch(request: Request): Response | Promise<Response> };
  operations?: Operations;
};

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
