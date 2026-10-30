import type { Summary } from "../collections/summary.ts";

/** One line of the outline, as optchat writes it: `id+n|text`, newlines as spaces. */
export function summaryView(s: Summary): string {
  const n = 2 ** s.level;
  return `${s.index * n}+${n}|${s.text.replace(/\s*\n\s*/g, " ")}`;
}
