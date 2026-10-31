/**
 * What set a turn going, when a person set it up to go without them (a
 * routine's run). It rides on the actor, which only code can set: nobody can
 * claim it from outside, as they could a message's `via`. Other plugins scope
 * what they let by it (computers: a yes for this routine). `rev` is which
 * version of it: what's let for one doesn't cover it once it's changed.
 */
import type { Actor } from "../../../../runtime/mod.ts";

export type Origin = {
  /** What it is: `routine`. */
  kind: string;
  id: string;
  /** As people say it: "Morning news". */
  name: string;
  rev: number;
  /** Where to see it, on this app. */
  path?: string;
};

/** What set this actor's work going: theirs, or that of whom an agent works for. */
export function originOf(actor: Actor | undefined): Origin | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.origin) return a.origin as Origin;
    a = a.for as Actor | undefined;
  }
  return undefined;
}

/** How a grant names it: which one, whatever its version. */
export const originKey = (origin: Pick<Origin, "kind" | "id">) => `${origin.kind}:${origin.id}`;
