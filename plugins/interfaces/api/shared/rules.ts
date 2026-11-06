/**
 * Keys live in their spaces (the spaces plugin's `shared`, changed only by
 * those who manage a space): read where the space is read, as its members
 * list says them. Never by a key, nor by an agent working for one: a key's
 * work never sees or changes keys.
 */
import type { Actor, Filter, Guard } from "../../../../runtime/mod.ts";
import { isKey } from "./actor.ts";

/** Matches no document. */
const NOTHING: Filter = { _id: { $in: [] } };

/** Whether a key started this work: the actor, or whoever an agent works for. */
const onKey = (actor: Actor) => isKey(actor) || isKey(actor.for as Actor | undefined);

export const rules: Guard = (actor, { collection }) =>
  collection === "api_key" && onKey(actor) ? NOTHING : undefined;
