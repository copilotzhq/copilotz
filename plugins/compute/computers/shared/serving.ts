/**
 * Which of a person's computers their calls on a plan's CLI try first:
 * one rule for the server (`engineComputer`) and the web (Your AI's cards,
 * which say which computer serves a plan now and which is its backup). It
 * imports only types, so the web reads it too.
 */
import type { Computer } from "../collections/computer.ts";
import type { EngineName, EngineSeen } from "./engines.ts";

/** What `servingOrder` reads of a computer. */
export type Serving = Pick<Computer, "_id" | "online" | "seen" | "status" | "engines">;

/**
 * The computers signed in to `engine`, as each last said, in the order calls
 * try them: online first, then those the app keeps (a cloud computer, which
 * wakes), then the rest (a laptop that's off); in each, `wanted` (where the
 * session is) first, then the most recently seen. Whether one is shared with
 * others' agents is the caller's to say: the server asks, the web reads its
 * desks.
 */
export function servingOrder<C extends Serving>(
  computers: readonly C[],
  engine: EngineName,
  wanted?: string,
): C[] {
  const tier = (c: C) => c.online ? 0 : c.status ? 1 : 2;
  return computers
    .filter((c) => (c.engines as Record<string, EngineSeen> | undefined)?.[engine]?.signedIn)
    .sort((a, b) =>
      tier(a) - tier(b) || Number(b._id === wanted) - Number(a._id === wanted) ||
      (b.seen ?? "").localeCompare(a.seen ?? "")
    );
}
