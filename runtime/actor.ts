/**
 * Who an actor's work is for. An actor is `{ kind, id, … }`; the kind is open
 * (plugins add their own), and these are the six the code makes or checks:
 *
 * - `person`: someone with an account, signed in or acting through their
 *   key. Made by identity (`credential.actor`).
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
 *   the web host (`ANONYMOUS`); an Action's `allow` decides what it may do.
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
