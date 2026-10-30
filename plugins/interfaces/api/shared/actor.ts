/**
 * Who calls with a key: its person, narrowed to the key's space (`at`), as
 * an agent's turn works where its conversation is. `key` says which key (the
 * start of its hash, as the identity plugin's keys say it), so the log tells
 * a key's work from its person's own.
 */
import type { Actor } from "../../../../runtime/mod.ts";

export type KeyActor = { kind: "person"; id: string; key: string; at: string };

/** Whether an actor calls with one of these keys. */
export const isKey = (actor: Actor | undefined): actor is KeyActor =>
  actor?.kind === "person" && typeof actor.key === "string" && typeof actor.at === "string";

/**
 * The space a key narrows this work to, if a key started it: the actor's
 * own, or that of the person an agent works for (`for`). The first person
 * along the way decides: trusted code acting as someone else is them.
 */
export function narrowedTo(actor: Actor | undefined): string | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return isKey(a) ? a.at : undefined;
    a = a.for as Actor | undefined;
  }
  return undefined;
}

/** Whose work this is: the person acting, or whom an agent (`for`) or trusted code (`via`) acts for. */
export function personOf(actor: Actor | undefined): string | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return a.id;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}
