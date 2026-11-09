/**
 * Who else is on a document, live: their faces in its header (and in the
 * space's list, beside the documents they're in), a pencil on those
 * editing it, and the page saying the person is there itself
 * (`document.presence`): open, or editing while something's unsaved, every
 * little while, and gone when they leave.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { Icon, Tooltip } from "copilotz/web";
import type { Presence } from "../../contract.ts";
import { BEAT_MS, STALE_MS } from "../../shared/presence.ts";
import { type Call, Face, type Shown } from "./people.tsx";

/** Someone here: who, and whether they're editing. */
export type Here = { who: Shown; editing: boolean };

/** Who's here now, each once (editing if any of their pages is), but those gone quiet and you. */
export function hereNow(
  presence: Presence[],
  now: number,
  me: string | undefined,
  shown: (key: string) => Shown,
): Here[] {
  const by = new Map<string, Here>();
  for (const p of presence) {
    if (now - Date.parse(p.at) > STALE_MS) continue;
    const who = shown(p.who);
    if (who.kind === "person" && who.id === me) continue;
    const known = by.get(p.who);
    by.set(p.who, { who, editing: (known?.editing ?? false) || p.state === "editing" });
  }
  return [...by.values()].sort((a, b) =>
    Number(b.editing) - Number(a.editing) || a.who.name.localeCompare(b.who.name)
  );
}

/** "Bob and Vera", "Bob, Vera and 2 others". */
export function named(here: Here[]): string {
  const names = here.map((h) => h.who.name);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} other${
    names.length > 3 ? "s" : ""
  }`;
}

/** Their faces, overlapping, the editing ones marked; more than `most`, a count. */
export function Present(
  { here, most = 4, size = 26 }: { here: Here[]; most?: number; size?: number },
): ReactNode {
  if (!here.length) return null;
  const shown = here.slice(0, most);
  const label = here.map((h) => `${h.who.name}${h.editing ? " (editing)" : ""}`).join(", ");
  return (
    <span className="doc-here" role="group" aria-label={`Also here: ${label}`}>
      {shown.map((h) => (
        <Tooltip key={h.who.key} text={`${h.who.name} ${h.editing ? "is editing" : "has it open"}`}>
          <span className="doc-here-face" data-editing={h.editing || undefined} tabIndex={0}>
            <Face who={h.who} size={size} />
            {h.editing
              ? (
                <span className="doc-here-pen" aria-hidden="true">
                  <Icon name="pencil" size={9} />
                </span>
              )
              : null}
          </span>
        </Tooltip>
      ))}
      {here.length > most ? <span className="doc-here-more">+{here.length - most}</span> : null}
    </span>
  );
}

/**
 * Says the person is on the document, from this page (`page`): now, when
 * `state` changes, every little while, and gone when the page goes.
 */
export function usePresence(
  call: Call,
  document: string,
  page: string,
  state: "open" | "editing",
  on: boolean,
): void {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (!on) return;
    const say = (s: string) =>
      void call("document.presence", { document, page, state: s }).catch(() => {});
    const beat = setInterval(() => say(latest.current), BEAT_MS);
    const gone = () => say("gone");
    // Back from the background: here again at once.
    const back = () => {
      if (globalThis.document.visibilityState === "visible") say(latest.current);
    };
    globalThis.addEventListener("pagehide", gone);
    globalThis.document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(beat);
      globalThis.removeEventListener("pagehide", gone);
      globalThis.document.removeEventListener("visibilitychange", back);
      gone();
    };
  }, [document, page, on]);
  useEffect(() => {
    if (on) void call("document.presence", { document, page, state }).catch(() => {});
  }, [document, page, state, on]);
}
