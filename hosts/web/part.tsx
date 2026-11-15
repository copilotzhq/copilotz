/**
 * A part on the web: a React component over an observed part, redrawn on its
 * own when its output changes (as the terminal's `Part` is for Ink). While it
 * loads, it keeps what it showed before (a new page appears once it's ready,
 * without a blank flash, the host showing it on its way: `Going`), or the
 * first time, a quiet loader after a moment.
 * A failed part says why, and offers to reload.
 */
import { isValidElement, type ReactNode, useRef, useSyncExternalStore } from "react";
import type { Observed } from "../../runtime/mod.ts";
import { Button } from "./toolkit/button.tsx";
import { Notice } from "./toolkit/notice.tsx";
import { Spinner } from "./toolkit/spinner.tsx";
import { say } from "./host-words.ts";

/** How the host lays out a part loading or failed: its own CSS, as a front end's is. */
const STYLE = `
.copilotz-loading { display: grid; place-items: center; min-height: 48px; padding: 12px;
  color: color-mix(in oklab, var(--muted-foreground) 55%, var(--background)); opacity: 0;
  animation: copilotz-appear .3s .35s forwards; }
#app > .copilotz-loading { min-height: 100%; }
@keyframes copilotz-appear { to { opacity: 1; } }
.copilotz-going { position: fixed; z-index: 70; top: env(safe-area-inset-top); left: 0; right: 0; height: 2px;
  overflow: hidden; pointer-events: none; opacity: 0; animation: copilotz-appear .2s .15s forwards; }
.copilotz-going::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 40%;
  background: var(--primary); animation: copilotz-going 1.1s ease-in-out infinite; }
@keyframes copilotz-going { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) {
  .copilotz-going::before { width: 100%; opacity: .5; animation: none; }
}
.copilotz-failed { margin: 12px; }
#app > .copilotz-failed { max-width: 520px; margin: 18vh auto; }
`;
const SHEET = <style href="copilotz-part" precedence="copilotz">{STYLE}</style>;

export function Part({ part }: { part: Observed }): ReactNode {
  const output = useSyncExternalStore(part.subscribe, part.get, part.get);
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
      <span className="copilotz-sr">{say("loading")}</span>
      <Spinner variant="dots" size={7} />
    </div>
  );
}

/**
 * A new page on its way, the one before still shown (see screens.ts): a thin
 * bar across the top, after a moment, so a quick page never flashes it.
 */
export function Going(): ReactNode {
  return (
    <div className="copilotz-going" role="progressbar" aria-label={say("loading")}>
      {SHEET}
    </div>
  );
}

/** Refused by the rules (a read or a query the person isn't let): nothing a reload changes. */
const refused = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "forbidden";

function Failed({ error }: { error: unknown }): ReactNode {
  if (refused(error)) {
    return (
      <Notice tone="neutral" className="copilotz-failed" title={say("forbiddenTitle")}>
        {SHEET}
        {say("forbidden")}
      </Notice>
    );
  }
  return (
    <Notice
      tone="destructive"
      role="alert"
      className="copilotz-failed"
      title={say("failedTitle")}
      action={<Button onClick={() => location.reload()}>{say("reload")}</Button>}
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
