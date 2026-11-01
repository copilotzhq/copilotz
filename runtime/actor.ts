/**
 * Who an actor's work is for. An actor is someone (a person, a key's person,
 * a contact), an agent working for someone (`for`), or trusted code acting
 * for whoever called it (`via`, set by `ctx.as`). Everyone who needs the person
 * behind an actor asks here.
 */
import type { Actor } from "./store.ts";

/** The person whose work this is: the one acting, or the one found along `for`, then `via`. */
export function personOf(actor: Actor | undefined): string | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return a.id;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}
