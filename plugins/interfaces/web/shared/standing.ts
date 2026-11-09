/**
 * The person's standing in the org they're in (spaces' `org.me`: their role,
 * whether they're platform staff, and which org, where there are many),
 * asked once per page and shared by whatever shows it: the spaces in the
 * sidebar, the switcher, the org's page, a composer's note. Asked again
 * (`restand`) once it may have changed: they changed their own role.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Standing } from "./orgs.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

let standing: Standing | undefined;
let asked: Promise<Standing | undefined> | undefined;
const listeners = new Set<() => void>();

const ask = (call: Call) =>
  asked ??= call<Standing>("org.me", {}).then(
    (found) => {
      standing = found;
      for (const listener of listeners) listener();
      return found;
    },
    // An app without org roles (one org): no standing to show.
    () => undefined,
  );

/** The person's standing, once known; asked for when first wanted (only where `enabled`). */
export function useStanding(call: Call, enabled = true): Standing | undefined {
  const now = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => standing,
    () => undefined,
  );
  useEffect(() => {
    if (enabled) void ask(call);
  }, [enabled]);
  return now;
}

/** Asks again: after the person's own role changed. */
export function restand(call: Call): Promise<Standing | undefined> {
  asked = undefined;
  return ask(call);
}
