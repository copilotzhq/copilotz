/**
 * Where cards sit in a column: each has an `order`, lowest first. A card
 * placed between two others takes the midpoint of theirs, so a move writes
 * one card; at the top or bottom, a step past the end. When a gap runs out
 * (midpoints stop fitting between two doubles), the column is numbered again
 * from the top, a step apart. Pure, so the browser places a card the way
 * the server will while a move is on its way.
 */
import type { Card, Place } from "../contract.ts";

/** The distance between cards numbered afresh, and past the ends. */
export const STEP = 1024;

/** The narrowest gap a midpoint still goes in. */
const NARROWEST = 1e-6;

type Placed = Pick<Card, "_id" | "order"> & { at?: string };

/** A column's cards in the order they show: by order, then as they were made. */
export const byOrder = <C extends Placed>(cards: C[]): C[] =>
  [...cards].sort((a, b) =>
    a.order - b.order || (a.at ?? "").localeCompare(b.at ?? "") || a._id.localeCompare(b._id)
  );

/** The order between two neighbours' (`above` and `below`, either missing at an end), if one fits. */
export function between(above?: number, below?: number): number | undefined {
  if (above === undefined && below === undefined) return STEP;
  if (above === undefined) return below! - STEP;
  if (below === undefined) return above + STEP;
  const mid = above + (below - above) / 2;
  return below - above > NARROWEST && mid > above && mid < below ? mid : undefined;
}

/** Where `place` puts a card among the others of its column (in their order, without it). */
export function indexOf(others: Pick<Card, "_id">[], place?: Place): number {
  if (!place || ("at" in place && place.at === "bottom")) return others.length;
  if ("at" in place) return 0;
  const id = "before" in place ? place.before : place.after;
  const found = others.findIndex((c) => c._id === id);
  if (found < 0) return others.length;
  return "before" in place ? found : found + 1;
}

/**
 * A card's order at `index` among `others` (in their order, without it), and
 * the others' new orders when there was no room and the column was numbered
 * again (`renumbered`: only those that change).
 */
export function orderAt(
  others: Placed[],
  index: number,
): { order: number; renumbered: Record<string, number> } {
  const at = Math.max(0, Math.min(index, others.length));
  const order = between(others[at - 1]?.order, others[at]?.order);
  if (order !== undefined && Number.isFinite(order)) return { order, renumbered: {} };
  const renumbered: Record<string, number> = {};
  others.forEach((card, i) => {
    const fresh = (i < at ? i + 1 : i + 2) * STEP;
    if (card.order !== fresh) renumbered[card._id] = fresh;
  });
  return { order: (at + 1) * STEP, renumbered };
}
