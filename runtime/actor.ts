/**
 * Who an actor's work is for. An actor is someone (a person, a key's person,
 * a contact), an agent working for someone (`for`), or trusted code acting
 * for whoever called it (`via`, set by `ctx.as`). Everyone who needs the person
 * behind an actor asks here.
 *
 * A contact is someone outside the org who talks to an app's agents (a
 * WhatsApp customer): `{ kind: "contact", id }`. Work can be for them, but
 * they are never a person: nothing that checks a person sees one.
 */
import type { Actor } from "./store.ts";

/** Whom work is for: the person or the contact found along `for`, then `via`, as they act. */
export function principalOf(actor: Actor | undefined): Actor | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person" || a.kind === "contact") return a;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}

/** The person whose work this is: the one acting, or the one found along `for`, then `via`. */
export function personOf(actor: Actor | undefined): string | undefined {
  const principal = principalOf(actor);
  return principal?.kind === "person" ? principal.id : undefined;
}

/**
 * What an actor holding someone's credential (a developer key, later an
 * OAuth token) may use from outside, by exact name: Actions it calls,
 * queries it runs (`message.conversation`), Views it has rendered, and
 * collections it reads and writes directly. No wildcards: a later Action
 * is never in it by accident.
 */
export type Scope = {
  call?: string[];
  query?: string[];
  view?: string[];
  read?: string[];
  write?: string[];
};

/**
 * Whether `actor` may use `name` (of `what`: a call, a query…) from outside:
 * an actor without a `scope` (a person, a contact) may use anything its
 * `allow`s and the rules let it; one with a scope, only what it lists. The
 * runtime asks only where a call from outside comes in, never inside jobs: an
 * Action it may call does its work (writing what it writes) as usual.
 */
export function inScope(actor: Actor | undefined, what: keyof Scope, name: string): boolean {
  if (actor?.scope === undefined) return true;
  const listed = (actor.scope as Scope | null)?.[what];
  return Array.isArray(listed) && listed.includes(name);
}
