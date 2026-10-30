/**
 * The side panel beside a page (the `panel` resource): where it's offered,
 * how wide it is, and what this browser keeps of it for each person (open or
 * not, its width), so it's as they left it on the next page and next time.
 */

/**
 * The `panel` resource: the View the panel shows (item `{ _id }`, the space
 * the person works in; hints `{ in, mode: "panel" }`), the kinds of page
 * that offer it (`thread`: a chat), and what it's called (`Space`: "Show the
 * space panel").
 */
export type Panel = { view: string; on?: string[]; title?: string };

/** Its width, in pixels: the least, the most, and where it starts. */
export const WIDTH = { min: 320, max: 760, start: 420 };

/** Whether a page offers the panel: its kind is one the panel is `on`, and there's a space to show. */
export function offered(
  panel: Panel | null | undefined,
  kind: string,
  space: string | undefined,
): panel is Panel {
  return !!panel?.view && !!space && (panel.on ?? []).includes(kind);
}

/** A width kept (or typed) as one that fits: a whole number of pixels, from the least to the most. */
export function widthOf(kept: unknown): number {
  const asked = Number(kept);
  if (!Number.isFinite(asked) || asked <= 0) return WIDTH.start;
  return Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, asked)));
}

/** Where this browser keeps the panel's state, for each person. */
export const keysOf = (viewer: string) => ({
  open: `copilotz-panel:${viewer}`,
  width: `copilotz-panel-width:${viewer}`,
});

/** What the panel's button says: "Show the space panel", "Hide the space panel". */
export const toggleLabel = (open: boolean, title = "") =>
  `${open ? "Hide" : "Show"} the ${title ? `${title.toLowerCase()} ` : ""}panel`;
