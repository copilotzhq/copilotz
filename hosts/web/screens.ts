/**
 * The pages the host shows, one after another (each the web shell, observed
 * for an address). A new one is drawn as soon as it's asked for, saying it's
 * on its way (`going`), while the one before stays on screen (a part keeps
 * what it showed until it's ready: part.tsx); once the new one is ready, the
 * one before closes and the page stops saying so. A page asked for while
 * another is on its way takes over: only the last one's readiness ends the
 * wait. The first page has nothing before it, so it isn't `going`: its parts
 * show a quiet loader instead.
 */

/** A page the host can show: ready once it has read what it needs, closed when it goes. */
export type Screen = { ready: Promise<unknown>; close(): void };

/** Shows each page asked for with `draw`, `going` until it's ready (see above). */
export function screens<S extends Screen>(
  draw: (screen: S, going: boolean) => void,
): (next: S) => void {
  let shown: S | undefined;
  return (next) => {
    const old = shown;
    shown = next;
    draw(next, old !== undefined);
    // Ready, or failed (its parts say why): either way, it's here.
    const arrived = () => {
      old?.close();
      if (shown === next) draw(next, false);
    };
    next.ready.then(arrived, arrived);
  };
}
