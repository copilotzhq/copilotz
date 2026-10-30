/**
 * What the palette lists, from what front ends gave it: groups with the same
 * heading made one (an item given twice, once), each item kept if it fits
 * what's typed, best first, as many as its group shows. With nothing typed,
 * groups go by their `order`, and in each headed one, what can't be undone
 * (`tone: "destructive"`) goes last, whichever front end gave it (a step's
 * own list, a question's choices, stays as given); while searching,
 * the group with the best match goes first (a better kind of match, not a
 * shorter label), so what was meant is at the top.
 */
import type { PaletteGroup, PaletteItem } from "./state.ts";
import { rank } from "./rank.ts";

export type Listed = {
  groups: { title: string; items: PaletteItem[] }[];
  /** Every item, in the order shown: what the arrows move through. */
  items: PaletteItem[];
};

/** Front ends' answers as groups: a group, groups, or nothing (a View with nothing to offer). */
export function groupsOf(given: unknown): PaletteGroup[] {
  const all = Array.isArray(given) ? given : given ? [given] : [];
  return all.filter((g): g is PaletteGroup =>
    !!g && typeof g === "object" && Array.isArray((g as PaletteGroup).items)
  );
}

export function listOf(given: PaletteGroup[], search: string, filter = true): Listed {
  type Merged = PaletteGroup & { first: number; best: number };
  const merged = new Map<string, Merged>();
  const seen = new Set<string>();
  given.forEach((group, first) => {
    const into = merged.get(group.title) ??
      merged.set(group.title, { title: group.title, items: [], first, best: 0 }).get(
        group.title,
      )!;
    if (group.order !== undefined) into.order = Math.min(into.order ?? group.order, group.order);
    if (group.limit !== undefined) into.limit = Math.min(into.limit ?? group.limit, group.limit);
    for (const item of group.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      into.items.push(item);
    }
  });
  const searching = filter && !!search.trim();
  const groups = [...merged.values()].map((group) => {
    let items = group.items;
    if (searching) {
      const scored = items.map((item, at) => ({
        item,
        at,
        score: rank(search, item.label, [...item.keywords ?? [], item.description ?? ""]),
      })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.at - b.at);
      // By kind of match (at the start, at a word, inside…), so length alone doesn't reorder.
      group.best = Math.floor((scored[0]?.score ?? 0) / 10);
      items = scored.map((s) => s.item);
    } else if (group.title) {
      items = [
        ...items.filter((item) => item.tone !== "destructive"),
        ...items.filter((item) => item.tone === "destructive"),
      ];
    }
    return { ...group, items: items.slice(0, group.limit ?? Infinity) };
  }).filter((group) => group.items.length);
  const order = (g: Merged) => g.order ?? 50;
  groups.sort((a, b) =>
    (searching ? b.best - a.best : 0) || order(a) - order(b) || a.first - b.first
  );
  return {
    groups: groups.map(({ title, items }) => ({ title, items })),
    items: groups.flatMap((g) => g.items),
  };
}
