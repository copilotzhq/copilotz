/**
 * Keys live in their spaces (the spaces plugin's `shared`, changed only by
 * those who manage a space): read where the space is read, as its members
 * list says them. Never by a key, nor by an agent working for one: a key's
 * work never sees or changes keys. And never changed directly from outside
 * (`direct`): a key's person and scope are what it acts as, so they change
 * only through its Actions (`api_key.create`, `api_key.revoke`).
 */
import { type Actor, failure, type Filter, type Guard } from "../../../../runtime/mod.ts";
import { isKey } from "./actor.ts";

/** Matches no document. */
const NOTHING: Filter = { _id: { $in: [] } };

/** Whether a key started this work: the actor, or whoever an agent works for. */
const onKey = (actor: Actor) => isKey(actor) || isKey(actor.for as Actor | undefined);

export const rules: Guard = (actor, { collection, access, direct }) => {
  if (collection !== "api_key") return undefined;
  if (direct && access === "write") {
    throw failure("forbidden", "Keys change through their Actions: make one, or revoke it.", {
      public: true,
    });
  }
  return onKey(actor) ? NOTHING : undefined;
};
