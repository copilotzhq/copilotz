/**
 * Who an actor's work is for. An actor is `{ kind, id, … }`; the kind is open
 * (plugins add their own), and these are the six the code makes or checks:
 *
 * - `person`: someone with an account, signed in or acting through their
 *   key. Made by identity (`credential.actor`), and for a key by the api
 *   plugin (`api_key.actor`: with its `key` and `scope`).
 * - `agent`: an agent working for someone (`for`). Made by agents.
 * - `contact`: someone outside the org, without an account, known through a
 *   WhatsApp number, a phone line, ChatGPT or a site's chat. Work can be for
 *   them, but they are never a person: nothing that checks a person sees
 *   one. Made by contacts (`contact.start`).
 * - `system`: trusted code acting for whoever called it (`via`). Made by the
 *   runtime (`ctx.as()`). It passes every rule.
 * - `maintenance`: the maintenance key, support's SQL. Made by the
 *   maintenance interface's routes, only; it is not `system`, so only the
 *   maintenance Actions let it in.
 * - `anonymous`: an HTTP request nobody is signed in to (`id: ""`). Made by
 *   `runtime.fetch` when no plugin's `who` answers; an Action's `allow`
 *   decides what it may do.
 *   It is an actor, not the absence of one: a missing actor is the system.
 *
 * Two names that look like kinds are not actors. `routine` is an origin: a
 * routine runs as the person who set it up (`origin: { kind: "routine", … }`).
 * `space` is a kind of member (a space that is a member of another), and a
 * starting point for `reachOf`; it never acts.
 *
 * Everyone who needs the person behind an actor asks here.
 */
import type { Actor } from "./store.ts";

/**
 * Who an actor is, for counting what they hold and ending them (browsers,
 * tickets): a key of a person's (`actor.key`) is apart from them, so revoking
 * it ends its own alone, and signing out ends none of its.
 */
export const holderOf = (actor: Actor): string =>
  `${actor.kind}:${actor.id}${typeof actor.key === "string" ? `|key:${actor.key}` : ""}`;

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
