/**
 * Keeps a popover beside what it belongs to while it's open (a menu under
 * its button, a tooltip over what it explains, or beside it: `end` after it,
 * beside a rail's item, `start` before it), by script: placed when it opens and again on scroll and
 * resize, on the other side when there's no room. Over or under, with room on neither side, it
 * goes on the roomier one, as tall as that room, and scrolls inside: never past the window, never
 * over what it belongs to. Not by CSS anchor positioning: Safari's can loop on its style (a
 * tooltip or menu whose anchor goes or hides as a page changes keeps it
 * re-resolving, and the page hangs). Render `ANCHORED` with the popover,
 * which carries `copilotz-anchored`.
 */
import { sheet } from "./sheet.tsx";

export type Placement = {
  /** Over or under it, or after it (to its right) or before it (to its left). */
  side?: "top" | "bottom" | "start" | "end";
  /** Along that side: from its start, its middle or its end (beside it: its top, middle, bottom). */
  align?: "start" | "center" | "end";
  /** Pixels between the two. */
  gap?: number;
};

export const ANCHORED = sheet(
  "anchored",
  `.copilotz-anchored { position: fixed; inset: auto; margin: 0; }`,
);

/** Places `popover` beside `target` until the returned function is called. */
export function anchor(
  popover: HTMLElement,
  target: HTMLElement,
  { side = "bottom", align = "start", gap = 6 }: Placement = {},
): () => void {
  popover.dataset.side = side;
  popover.dataset.align = align;
  /** Whether its height is the room it was given, not its own. */
  let capped = false;
  const place = () => {
    const at = target.getBoundingClientRect();
    // Measured at its own height: a cap set before is lifted, keeping where its content was scrolled.
    const scrolled = popover.scrollTop;
    const lifted = capped;
    if (lifted) popover.style.maxHeight = "";
    const size = popover.getBoundingClientRect();
    if (side === "end" || side === "start") {
      const after = at.right + gap;
      const before = at.left - gap - size.width;
      const left = side === "end"
        ? (after + size.width > innerWidth && before >= 0 ? before : after)
        : (before < 0 && after + size.width <= innerWidth ? after : before);
      const top = align === "start"
        ? at.top
        : align === "end"
        ? at.bottom - size.height
        : at.top + (at.height - size.height) / 2;
      popover.style.top = `${Math.max(8, Math.min(top, innerHeight - size.height - 8))}px`;
      popover.style.left = `${Math.max(8, left)}px`;
      return;
    }
    const below = at.bottom + gap;
    const fitsBelow = below + size.height <= innerHeight;
    const fitsAbove = at.top - gap - size.height >= 0;
    const room = { below: innerHeight - below - 8, above: at.top - gap - 8 };
    // Its own side when it fits there, else the other; with room on neither, the roomier one.
    const up = fitsBelow || fitsAbove
      ? (side === "bottom" ? !fitsBelow : fitsAbove)
      : room.above > room.below;
    capped = !fitsBelow && !fitsAbove;
    const height = capped ? Math.max(0, up ? room.above : room.below) : size.height;
    if (capped) popover.style.maxHeight = `${height}px`;
    if (lifted) popover.scrollTop = scrolled;
    const top = up ? at.top - gap - height : below;
    const left = align === "start"
      ? at.left
      : align === "end"
      ? at.right - size.width
      : at.left + (at.width - size.width) / 2;
    popover.style.top = `${Math.max(8, top)}px`;
    popover.style.left = `${Math.max(8, Math.min(left, innerWidth - size.width - 8))}px`;
  };
  // Its own content scrolling doesn't move it.
  const onScroll = (event: Event) => {
    if (!(event.target instanceof Node && popover.contains(event.target))) place();
  };
  place();
  addEventListener("scroll", onScroll, true);
  addEventListener("resize", place);
  return () => {
    removeEventListener("scroll", onScroll, true);
    removeEventListener("resize", place);
    if (capped) popover.style.maxHeight = "";
  };
}
