/**
 * A View shown only while a component is: observed when it mounts, as the
 * page's person (`web()`'s connection), drawn as a part, and closed when it
 * goes. For what a View shows on demand, so nothing is read before it's
 * wanted: a side panel opened, a list unfolded, a tab chosen. Given another
 * kind, item or hints, it observes again, and keeps showing what it showed
 * until the new one is ready (what both read stays watched, as when the
 * address changes).
 *
 * ```tsx
 * {open ? <LazyView kind="space.panel" item={{ _id: space }} hints={{ in: space }} /> : null}
 * ```
 */
import { type ReactNode, useEffect, useReducer, useRef } from "react";
import type { Observation } from "../../runtime/mod.ts";
import { Loading, Part } from "./part.tsx";
import { session } from "./session.ts";

export function LazyView(
  { kind, item = {}, hints = {}, fallback = <Loading /> }: {
    kind: string;
    item?: unknown;
    hints?: Record<string, unknown>;
    /** What shows until it's first ready: a quiet loader, or nothing (`null`) where a loader would jump. */
    fallback?: ReactNode;
  },
): ReactNode {
  const shown = useRef<Observation>(undefined);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const key = JSON.stringify([kind, item, hints]);
  useEffect(() => {
    const { client, viewer } = session;
    if (!client) return;
    const next = client.observe("web", kind, item, {
      ...(viewer ? { viewer } : {}),
      hints,
      part: (part, key) => <Part key={key} part={part} />,
    });
    let waiting = true;
    void next.ready.then(() => {
      if (!waiting) return;
      waiting = false;
      const old = shown.current;
      shown.current = next;
      redraw();
      old?.close();
    });
    // Superseded or gone before it was ready: it closes; once shown, it closes when replaced.
    return () => {
      if (waiting) next.close();
      waiting = false;
    };
  }, [key]);
  useEffect(() => () => shown.current?.close(), []);
  return shown.current ? <Part part={shown.current} /> : fallback;
}
