/**
 * A tab's sections (the tabs `under` it, see contract.ts), around the one
 * shown: the tab's own View first (named `own`: "General"), then each
 * section, those of a `group` under its heading ("Channels").
 *
 * - `side` (the space's settings, on its page): a menu beside, as settings
 *   pages have. Where there's no room for both (a phone), the menu is a list
 *   to tap into, and a section, once chosen, says how to get back to it.
 * - `top` (the computer's, and every tab's in the side panel): tabs above.
 *
 * On the page each is a link (`href`, and `onPick` for the keyboard's
 * arrows); in the panel, a choice (`onPick`).
 */
import type { ReactNode } from "react";
import { Badge, Icon, NavItem, Tabs } from "../../../../../hosts/web/mod.ts";
import type { ShownTab } from "./tabs.ts";

export function TabSections(
  { tab, section, picked, menu, href, back, onPick, counts = {}, children }: {
    tab: ShownTab;
    /** The section shown; none: the tab's own View. */
    section?: ShownTab;
    /** Whether the address chose what's shown (a phone shows the list until it does). */
    picked: boolean;
    menu: "side" | "top";
    href?: (key: string) => string;
    /** Where the menu is, to get back to it (where a phone lists it). */
    back?: string;
    onPick?: (key: string) => void;
    /** What waits on someone, by section (who asked to join). */
    counts?: Record<string, number>;
    /** What's shown: the section's View, or the tab's own. */
    children: ReactNode;
  },
): ReactNode {
  const items = [{ ...tab, title: tab.own ?? tab.title, group: undefined }, ...tab.sections];
  const current = section ?? items[0];
  if (menu === "top") {
    return (
      <div className="space-sections space-sections-top">
        <Tabs
          label={`${tab.title}: its parts`}
          className="space-sections-tabs"
          value={current.key}
          onChange={(key) => onPick?.(key)}
          tabs={items.map((item) => ({
            value: item.key,
            label: item.title,
            ...(item.icon ? { icon: item.icon } : {}),
            ...(counts[item.key] ? { count: counts[item.key] } : {}),
            ...(href ? { href: href(item.key) } : {}),
          }))}
        />
        <div className="space-sections-body">{children}</div>
      </div>
    );
  }
  return (
    <div className="space-sections">
      <div className="space-sections-side" data-picked={picked}>
        <nav className="space-sections-menu" aria-label={tab.title}>
          {items.map((item, i) => (
            <div key={item.key} className="space-sections-item">
              {item.group && item.group !== items[i - 1]?.group
                ? <p className="space-sections-group">{item.group}</p>
                : null}
              <NavItem
                {...(href ? { href: href(item.key) } : { onClick: () => onPick?.(item.key) })}
                {...(item.icon ? { icon: item.icon } : {})}
                {...(item.key === current.key ? { current: "page" as const } : {})}
                end={counts[item.key]
                  ? <Badge tone="primary">{counts[item.key]}</Badge>
                  : <Icon name="chevron" size={16} className="space-sections-chevron" />}
              >
                {item.title}
              </NavItem>
            </div>
          ))}
        </nav>
        <div className="space-sections-body">
          <div className="space-sections-back">
            {back
              ? (
                <a href={back} className="space-sections-back-link">
                  <Icon name="chevron-left" size={16} />
                  {tab.title}
                </a>
              )
              : null}
            <h2 className="space-sections-title">{current.title}</h2>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
