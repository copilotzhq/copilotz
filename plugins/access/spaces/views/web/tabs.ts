/**
 * A space's tabs, as the front ends add them (`spaceTabs`, see contract.ts):
 * in their order, which one the address asks for, and each one's address;
 * and the kinds of member its invite surface adds (`spaceInvite`).
 */
import type { SpaceInvite, SpaceTab } from "../../contract.ts";

export type ShownTab = SpaceTab & { key: string };

/** The tabs given, lowest `order` first (by key when they tie), leaving out those taken away (`null`). */
export function tabsOf(given: unknown): ShownTab[] {
  return Object.entries((given ?? {}) as Record<string, SpaceTab | null>)
    .flatMap(([key, tab]) => tab?.view && tab.title ? [{ ...tab, key }] : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}

/** The tab asked for (`?tab=`), or the first. */
export const chosen = (tabs: ShownTab[], asked?: unknown): ShownTab | undefined =>
  tabs.find((t) => t.key === asked) ?? tabs[0];

/** A space's page, at a tab. */
export const spacePath = (space: string, tab?: string) =>
  `/space/${encodeURIComponent(space)}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;

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
