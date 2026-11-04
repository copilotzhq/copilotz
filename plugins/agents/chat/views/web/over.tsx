/**
 * What other front ends show over where you type (chat's `conversation`
 * resource): their Views, each with hints `{ thread, in, working, busy }`.
 * `busy` is the agents whose turns run in the conversation (or its
 * subthreads), each held 600 ms after its last step ends, and `working`
 * whether there are any; so what waits for an agent's turn to be over (its
 * asking for your OK) shows once, when it is, rather than flickering between
 * its steps, and isn't kept waiting by another agent still working. Nothing
 * shows until a View has something to say.
 */
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { LazyView } from "../../../../../hosts/web/mod.ts";
import type { ConversationView } from "../../shared/types.ts";
import { held } from "./held.ts";

export function Over(
  { entries, thread, space, live }: {
    entries: ConversationView[];
    thread: string;
    space?: string;
    /** The agents with a turn step live here now. */
    live: string[];
  },
): ReactNode {
  const [hold] = useState(() => held(undefined, live));
  useEffect(() => hold.set(live), [live.join("\n")]);
  useEffect(() => () => hold.stop(), []);
  const busy = useSyncExternalStore(hold.subscribe, hold.get);
  return entries.map((entry) => (
    <LazyView
      key={entry.view}
      kind={entry.view}
      item={{}}
      hints={{ thread, ...(space ? { in: space } : {}), working: busy.length > 0, busy }}
      fallback={null}
    />
  ));
}
