/**
 * The rules keys keep to, beside the access plugin's: a key's work reaches
 * only its space. Documents of shared collections (the spaces plugin's
 * `shared` resource) are read and written there alone, and the space's own
 * records (the space, its members, requests, invitations) are its; agents
 * people made are read wherever they work, as everyone reads them, and
 * written only there. What else its person reaches (other spaces, their
 * own things) the access plugin's rules decide, as for them.
 *
 * Keys themselves are their person's: read and revoked by them, and never
 * by a key.
 */
import type { Filter, Guard } from "../../../../runtime/mod.ts";
import { narrowedTo, personOf } from "./actor.ts";

/** The `shared` resource, as these rules read it (the spaces plugin's). */
type Shared = Record<string, { field?: string; member?: string } | null>;

/** Matches no document. */
const NOTHING: Filter = { _id: { $in: [] } };

/** The spaces plugin's own collections, each with the field saying which space. */
const SPACES: Record<string, string> = {
  space: "_id",
  member: "space",
  request: "space",
  invitation: "space",
};

export const rules: Guard = (actor, { collection, access }, ctx) => {
  const at = narrowedTo(actor);
  if (collection === "api_key") {
    const person = personOf(actor);
    return at === undefined && person ? { person } : NOTHING;
  }
  if (at === undefined) return undefined;
  if (collection in SPACES) return { [SPACES[collection]]: at };
  const shared = ((ctx.resources.shared ?? {}) as Shared)[collection];
  if (!shared) return undefined;
  // Agents people made are read wherever they work: the access plugin's rule says where.
  if (shared.member && access === "read") return undefined;
  return { [shared.field ?? "in"]: at };
};
