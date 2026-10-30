/// <reference lib="dom" />
/**
 * Keeps a popover beside what it belongs to while it's open (a menu under
 * its button, a tooltip over what it explains), by script: placed when it
 * opens and again on scroll and resize, on the other side when there's no
 * room. Not by CSS anchor positioning: Safari's can loop on its style (a
 * tooltip or menu whose anchor goes or hides as a page changes keeps it
 * re-resolving, and the page hangs). Render `ANCHORED` with the popover,
 * which carries `copilotz-anchored`.
 */
import { sheet } from "./sheet.tsx";

export type Placement = {
  side?: "top" | "bottom";
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
  const place = () => {
    const at = target.getBoundingClientRect();
    const size = popover.getBoundingClientRect();
    const below = at.bottom + gap;
    const above = at.top - gap - size.height;
    const top = side === "bottom"
      ? (below + size.height > innerHeight && above >= 0 ? above : below)
      : (above < 0 && below + size.height <= innerHeight ? below : above);
    const left = align === "start"
      ? at.left
      : align === "end"
      ? at.right - size.width
      : at.left + (at.width - size.width) / 2;
    popover.style.top = `${Math.max(8, top)}px`;
    popover.style.left = `${Math.max(8, Math.min(left, innerWidth - size.width - 8))}px`;
  };
  place();
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  return () => {
    removeEventListener("scroll", place, true);
    removeEventListener("resize", place);
  };
}
