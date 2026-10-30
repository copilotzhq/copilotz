/** Whose work this is: the person acting, or whom an agent (`for`) or trusted code (`via`) acts for. */
import type { Actor } from "../../../../runtime/mod.ts";

export function personOf(actor: Actor | undefined): string | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return a.id;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}
