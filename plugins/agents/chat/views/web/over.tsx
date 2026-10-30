/**
 * What other front ends show over where you type (chat's `conversation`
 * resource): their Views, each with hints `{ thread, in, working }`.
 * `working` is true while an agent's turn runs in the conversation (or its
 * subthreads), held 600 ms after the last step ends, so what waits for the
 * turn to be over (an agent asking for your OK) shows once, when it is,
 * rather than flickering between its steps. Nothing shows until a View has
 * something to say.
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
    /** Whether an agent's turn step is live here now. */
    live: boolean;
  },
): ReactNode {
  const [hold] = useState(() => held(undefined, live));
  useEffect(() => hold.set(live), [live]);
  useEffect(() => () => hold.stop(), []);
  const working = useSyncExternalStore(hold.subscribe, hold.get);
  return entries.map((entry) => (
    <LazyView
      key={entry.view}
      kind={entry.view}
      item={{}}
      hints={{ thread, ...(space ? { in: space } : {}), working }}
      fallback={null}
    />
  ));
}
