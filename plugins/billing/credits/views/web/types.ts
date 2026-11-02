/** What Billing's pieces pass each other: how they call the app, and busy-then-why on acting. */
import { useState } from "react";
import { message } from "../../../../../hosts/web/mod.ts";

export type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
export type Org = { id: string; name: string; kind: string };

/** Where what's there before paying is kept, to tell what's new on coming back. */
export const LEFT = "billing-left-for-payment";

/** Something being done: busy while it goes, why if it failed, kept until they try again. */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return {
    busy,
    error,
    clear: () => setError(undefined),
    /** Runs it; true when it went. `stay`: still busy after, as the page is leaving. */
    run: async (work: () => Promise<unknown>, stay = false): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      try {
        await work();
        if (!stay) setBusy(false);
        return true;
      } catch (e) {
        setError(message(e));
        setBusy(false);
        return false;
      }
    },
    release: () => setBusy(false),
  };
}
