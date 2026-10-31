/**
 * A space's tabs, as the front ends add them (`spaceTabs`, see contract.ts):
 * in their order, each with its sections (the tabs `under` it), which one
 * the address asks for (a section's key opens its tab there), and each one's
 * address; and the kinds of member its invite surface adds (`spaceInvite`).
 */
import type { SpaceInvite, SpaceTab } from "../../contract.ts";

export type ShownTab = SpaceTab & { key: string; sections: ShownTab[] };

const ordered = (a: ShownTab, b: ShownTab) =>
  (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key);

/**
 * The tabs given, lowest `order` first (by key when they tie), leaving out
 * those taken away (`null`), each with its sections in their order. A
 * section whose tab isn't there is a tab of its own.
 */
export function tabsOf(given: unknown): ShownTab[] {
  const all: ShownTab[] = Object.entries((given ?? {}) as Record<string, SpaceTab | null>)
    .flatMap(([key, tab]) => tab?.view && tab.title ? [{ ...tab, key, sections: [] }] : []);
  const keys = new Set(all.map((t) => t.key));
  const top = all.filter((t) => !t.under || t.under === t.key || !keys.has(t.under)).sort(ordered);
  for (const tab of top) {
    tab.sections = all.filter((t) => t.under === tab.key && t !== tab).sort(ordered);
  }
  return top;
}

/** The tab asked for (`?tab=`): the one with that key, or the one with that section; or the first. */
export const chosen = (tabs: ShownTab[], asked?: unknown): ShownTab | undefined =>
  tabs.find((t) => t.key === asked || t.sections.some((s) => s.key === asked)) ?? tabs[0];

/** The section asked for in a tab: one of its own, by key (none: the tab's own View). */
export const sectionOf = (tab: ShownTab | undefined, asked?: unknown): ShownTab | undefined =>
  tab?.sections.find((s) => s.key === asked);

/**
 * A space's page, at a tab (a section's key opens its tab there). With
 * `chose`, the address says the tab's own View was chosen, not just its tab
 * opened: a phone shows a tab's menu of sections until one is.
 */
export const spacePath = (space: string, tab?: string, chose?: boolean) =>
  `/space/${encodeURIComponent(space)}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}${
    tab && chose ? "&open=1" : ""
  }`;

/** A kind of member to add: people (spaces' own), or a front end's View. */
export type Kind = { key: string; title: string; view?: string };

/**
 * The kinds of member a space takes, as its invite surface shows them:
 * People first, then the `spaceInvite` resources in their order; a
 * Personal space, only those that join one.
 */
export function kindsOf(given: unknown, personal: boolean): Kind[] {
  const added = Object.entries((given ?? {}) as Record<string, SpaceInvite | null>)
    .flatMap(([key, kind]) =>
      kind?.view && kind.title && (!personal || kind.personal)
        ? [{ key, title: kind.title, view: kind.view, order: kind.order ?? 0 }]
        : []
    )
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map(({ key, title, view }) => ({ key, title, view }));
  return personal ? added : [{ key: "people", title: "People" }, ...added];
}
