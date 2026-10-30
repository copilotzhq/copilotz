/** Usage totals by model, with what they cost, and the sum. */
import { accent, dim } from "../../../../../hosts/terminal/mod.ts";
import type { Totals } from "../../shared/totals.ts";

const UNITS = ["input", "cached", "cacheWrite", "output", "reasoning", "seconds"];
const usd = (n: number) => n && n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(4)}`;

export const totalsView = (t: { totals: Totals[]; scope?: string }): string => {
  if (!t.totals.length) return dim("Nothing used yet.");
  const lines = t.totals.map((row) => {
    const key = row.key as { subject?: string; meter?: string };
    const used = UNITS.filter((unit) => row.quantities[unit])
      .map((unit) => `${unit} ${row.quantities[unit]!.toLocaleString()}`).join(" · ");
    return `${accent(key.subject ?? "")} ${dim(key.meter ?? "")} · ${row.uses} uses · ${used} · ${
      row.unpriced ? dim("unpriced") : usd(row.cost)
    }`;
  });
  const sum = t.totals.reduce((n, row) => n + row.cost, 0);
  return [...lines, dim(`total ${usd(sum)}${t.scope ? ` (${t.scope})` : ""}`)].join("\n");
};
