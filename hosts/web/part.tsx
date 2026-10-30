/**
 * A part on the web: a React component over an observed part, redrawn on its
 * own when its output changes (as the terminal's `Part` is for Ink). While it
 * loads, it keeps what it showed before (a new page appears once it's ready,
 * without a blank flash), or the first time, a quiet loader after a moment.
 * A failed part says why, and offers to reload.
 */
import { isValidElement, type ReactNode, useRef, useSyncExternalStore } from "react";
import type { Observed } from "../../runtime/mod.ts";
import { Button } from "./toolkit/button.tsx";
import { Notice } from "./toolkit/notice.tsx";
import { Spinner } from "./toolkit/spinner.tsx";

/** How the host lays out a part loading or failed: its own CSS, as a front end's is. */
const STYLE = `
.copilotz-loading { display: grid; place-items: center; min-height: 48px; padding: 12px;
  color: color-mix(in oklab, var(--muted-foreground) 55%, var(--background)); opacity: 0;
  animation: copilotz-appear .3s .35s forwards; }
#app > .copilotz-loading { min-height: 100%; }
@keyframes copilotz-appear { to { opacity: 1; } }
.copilotz-failed { margin: 12px; }
#app > .copilotz-failed { max-width: 520px; margin: 18vh auto; }
`;
const SHEET = <style href="copilotz-part" precedence="copilotz">{STYLE}</style>;

export function Part({ part }: { part: Observed }): ReactNode {
  const output = useSyncExternalStore(part.subscribe, part.get);
  const shown = useRef<ReactNode>(undefined);
  if (output.status === "loading") return shown.current ?? <Loading />;
  shown.current = output.status === "failed" ? <Failed error={output.error} /> : node(output.value);
  return shown.current;
}

/** A part not ready yet: a quiet loader, after a moment. */
export function Loading(): ReactNode {
  return (
    <div className="copilotz-loading" role="status">
      {SHEET}
      <span className="copilotz-sr">Loading</span>
      <Spinner variant="dots" size={7} />
    </div>
  );
}

/** Refused by the rules (a read or a query the person isn't let): nothing a reload changes. */
const refused = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "forbidden";

function Failed({ error }: { error: unknown }): ReactNode {
  if (refused(error)) {
    return (
      <Notice tone="neutral" className="copilotz-failed" title="You can't see this here">
        {SHEET}
        It isn't shared with you, or it only shows inside another page.
      </Notice>
    );
  }
  return (
    <Notice
      tone="destructive"
      role="alert"
      className="copilotz-failed"
      title="Something went wrong here"
      action={<Button onClick={() => location.reload()}>Reload</Button>}
    >
      {SHEET}
      {message(error)}
    </Notice>
  );
}

/** What a View returned, as React draws it; plain data as itself. */
export const node = (value: unknown): ReactNode =>
  value === null || value === undefined || typeof value === "boolean"
    ? null
    : typeof value === "string" || typeof value === "number" || isValidElement(value) ||
        Array.isArray(value)
    ? value as ReactNode
    : <pre>{JSON.stringify(value, null, 2)}</pre>;

export const message = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
