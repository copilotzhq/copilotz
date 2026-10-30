/**
 * Usage totals by model, with what they were charged (their spend: the
 * price, never the cost), and the sum; then how much of the input came from
 * a cache and what caching saved, when anything was cached.
 */
// The styles alone (not the host, whose Ink pieces are .tsx), so Node runs its tests too.
import { accent, dim } from "../../../../../hosts/terminal/contract.ts";
import type { PriceTotals } from "../../shared/totals.ts";

const UNITS = ["input", "cached", "cacheWrite", "output", "reasoning", "seconds"];

/** USD to four places; two digits of a crumb; a minus below zero. */
export const usd = (n: number): string =>
  n < 0 ? `-${usd(-n)}` : n && n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(4)}`;

/** How much input came from a cache, and what caching saved: none when nothing was cached. */
export function cacheLine(totals: PriceTotals[]): string | undefined {
  let input = 0;
  let cached = 0;
  let written = 0;
  let saved = 0;
  for (const row of totals) {
    input += row.quantities.input ?? 0;
    cached += row.quantities.cached ?? 0;
    written += row.quantities.cacheWrite ?? 0;
    saved += row.saved?.price ?? 0;
  }
  if (!input || !(cached + written)) return undefined;
  const share = cached / input;
  const hit = share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
  return `cache ${hit} of input · ${
    saved < 0 ? `${usd(-saved)} more than without it` : `saved ${usd(saved)}`
  }`;
}

export const totalsView = (t: { totals: PriceTotals[]; scope?: string }): string => {
  if (!t.totals.length) return dim("Nothing used yet.");
  const lines = t.totals.map((row) => {
    const key = row.key as { subject?: string; meter?: string };
    const used = UNITS.filter((unit) => row.quantities[unit])
      .map((unit) => `${unit} ${row.quantities[unit]!.toLocaleString()}`).join(" · ");
    // What nothing priced is charged nothing: said, so a total doesn't look whole.
    const spend = row.unpriced >= row.uses && !row.price
      ? dim("unpriced")
      : `${usd(row.price)}${row.unpriced ? dim(` (${row.unpriced} unpriced)`) : ""}`;
    return `${accent(key.subject ?? "")} ${
      dim(key.meter ?? "")
    } · ${row.uses} uses · ${used} · ${spend}`;
  });
  const sum = t.totals.reduce((n, row) => n + row.price, 0);
  const cache = cacheLine(t.totals);
  return [
    ...lines,
    dim(`total ${usd(sum)}${cache ? ` · ${cache}` : ""}${t.scope ? ` (${t.scope})` : ""}`),
  ].join("\n");
};
