/**
 * Keys themselves are their person's: read and revoked by them, and never by
 * a key, nor by an agent working for one. What a key's work reaches is its
 * space alone, which reach says (`within`: the access plugin's `reachOf`).
 */
import type { Actor, Filter, Guard } from "../../../../runtime/mod.ts";
import { personOf } from "../../../../runtime/mod.ts";
import { isKey } from "./actor.ts";

/** Matches no document. */
const NOTHING: Filter = { _id: { $in: [] } };

/** Whether a key started this work: the actor, or the person an agent works for. */
const onKey = (actor: Actor) => isKey(actor) || isKey(actor.for as Actor | undefined);

export const rules: Guard = (actor, { collection }) => {
  if (collection !== "api_key") return undefined;
  const person = personOf(actor);
  return person && !onKey(actor) ? { person } : NOTHING;
};
