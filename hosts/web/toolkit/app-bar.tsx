/**
 * The bars at the top of an app that doesn't use the Copilotz shell.
 *
 * `AppBar` is its navigation: the brand (words or a `Logo`, a link home
 * with `href`), the app's places (`items`: each a link with its `label` and
 * maybe an `icon`, the toolkit's or the app's own), the `active` one shown
 * raised and said to be the page (`aria-current`), and anything at its
 * `end` (a person's menu). Icons sit beside their labels, or over them
 * (`layout="stacked"`, a module bar's). On a phone the places scroll
 * sideways, the active one kept in view.
 *
 * `TopBar` is a thin strip over it: what's at its `start` (a clock), its
 * `center` (the company) and its `end` (who's signed in, signing out).
 *
 * ```tsx
 * <TopBar start={<LiveClock />} center="Acme Stores" end={<a href="/password">Ana</a>} />
 * <AppBar brand="Acme" href="/" active="/sales" items={[
 *   { href: "/sales", label: "Sales", icon: <Icon src="/assets/modules/sales.png" /> },
 *   { href: "/items", label: "Items", icon: "archive" },
 * ]} end={<Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>} />
 * ```
 */
import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

/** One of the app's places: where it goes, what it's called, maybe an icon. */
export type AppBarItem = {
  href: string;
  label: string;
  icon?: IconLike;
  /** What `active` names it by (its `href` unless given). */
  key?: string;
  /** Its words on hover. */
  title?: string;
};

const SHEET = sheet(
  "app-bar",
  `
.copilotz-appbar { background: var(--appbar-background, var(--background)); color: var(--appbar-foreground, var(--foreground));
  border-bottom: var(--appbar-border-width, 1px) solid var(--appbar-border-color, var(--border));
  box-shadow: var(--appbar-shadow, none); }
.copilotz-appbar-inner { display: flex; align-items: center; gap: var(--appbar-gap, 16px); box-sizing: border-box;
  max-width: var(--appbar-max-width, none); min-height: var(--appbar-height, 56px); margin: 0 auto;
  padding: 0 max(var(--appbar-padding-x, 16px), env(safe-area-inset-right))
    0 max(var(--appbar-padding-x, 16px), env(safe-area-inset-left)); }
.copilotz-appbar-spacer { flex: 1; }
.copilotz-appbar-brand { display: inline-flex; flex: none; align-items: center; gap: 8px;
  color: var(--appbar-brand-color, currentColor); font-family: var(--appbar-brand-font, var(--font-display));
  font-size: var(--appbar-brand-font-size, 17px); font-weight: var(--appbar-brand-font-weight, 650);
  letter-spacing: -.01em; text-decoration: none; white-space: nowrap; }
a.copilotz-appbar-brand:hover { color: var(--appbar-brand-hover-color, var(--appbar-brand-color, currentColor)); }
.copilotz-appbar-nav { flex: 1; min-width: 0; display: flex; justify-content: var(--appbar-items-justify, flex-start); }
.copilotz-appbar-items { display: flex; align-items: center; gap: var(--appbar-items-gap, 4px); min-width: 0;
  margin: 0; padding: 4px 0; overflow-x: auto; list-style: none; scrollbar-width: none; }
.copilotz-appbar-items::-webkit-scrollbar { display: none; }
.copilotz-appbar-items > li { flex: none; }
.copilotz-appbar-item { display: flex; align-items: center; gap: var(--appbar-item-gap, 8px); box-sizing: border-box;
  min-height: var(--appbar-item-height, 36px); padding: var(--appbar-item-padding, 0 12px);
  border: 1px solid transparent; border-radius: var(--appbar-item-radius, var(--radius-md));
  color: var(--appbar-item-color, var(--muted-foreground)); font-size: var(--appbar-item-font-size, 14px);
  font-weight: var(--appbar-item-font-weight, 560); text-decoration: none; white-space: nowrap;
  transition: background-color .12s, color .12s; }
.copilotz-appbar-item:hover { background: var(--appbar-item-hover-background, var(--accent));
  color: var(--appbar-item-hover-color, var(--accent-foreground)); }
.copilotz-appbar-item[aria-current=page] { border-color: var(--appbar-item-active-border-color, var(--border));
  background: var(--appbar-item-active-background, var(--card)); color: var(--appbar-item-active-color, var(--card-foreground));
  box-shadow: var(--appbar-item-active-shadow, var(--shadow-sm)); font-weight: var(--appbar-item-active-font-weight, 620); }
.copilotz-appbar-item > .copilotz-icon, .copilotz-appbar-item > svg, .copilotz-appbar-item > img {
  width: var(--appbar-icon-size, 18px); height: var(--appbar-icon-size, 18px); color: var(--appbar-icon-color, var(--primary-text)); }
.copilotz-appbar[data-layout=stacked] .copilotz-appbar-item { flex-direction: column; justify-content: center;
  gap: var(--appbar-stacked-gap, 2px); padding: var(--appbar-stacked-padding, 6px 10px);
  font-size: var(--appbar-stacked-font-size, 12px); }
.copilotz-appbar-end { flex: none; display: flex; align-items: center; gap: 8px; }
@media (pointer: coarse) { .copilotz-appbar-item { min-height: 44px; } }
.copilotz-topbar { background: var(--topbar-background, var(--muted)); color: var(--topbar-foreground, var(--muted-foreground));
  font-size: var(--topbar-font-size, 12.5px); line-height: 1.4;
  border-bottom: var(--topbar-border-width, 1px) solid var(--topbar-border-color, var(--border)); }
.copilotz-topbar-inner { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  gap: var(--topbar-gap, 12px); box-sizing: border-box; max-width: var(--topbar-max-width, none);
  min-height: var(--topbar-height, 28px); margin: 0 auto;
  padding: var(--topbar-padding-y, 2px) max(var(--topbar-padding-x, 16px), env(safe-area-inset-right))
    var(--topbar-padding-y, 2px) max(var(--topbar-padding-x, 16px), env(safe-area-inset-left)); }
.copilotz-topbar-start { justify-self: start; white-space: nowrap; }
.copilotz-topbar-center { justify-self: center; font-weight: var(--topbar-center-font-weight, 620); white-space: nowrap;
  color: var(--topbar-center-color, var(--foreground)); }
.copilotz-topbar-end { justify-self: end; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.copilotz-topbar a, .copilotz-topbar .copilotz-button-link { color: var(--topbar-link-color, var(--primary-text)); }
/* A narrow screen: the middle on its own line. */
@media (max-width: 560px) {
  .copilotz-topbar-inner { grid-template-columns: 1fr auto; }
  .copilotz-topbar-center { grid-column: 1 / -1; grid-row: 1; }
}
`,
);

export function AppBar(
  { brand, href, items = [], active, layout = "inline", end, label, className }: {
    /** The app's name or logo, at the start. */
    brand?: ReactNode;
    /** Where the brand goes: home. */
    href?: string;
    items?: AppBarItem[];
    /** The page's item, by its `key` (or `href`). */
    active?: string;
    /** Icons beside their labels, or over them. */
    layout?: "inline" | "stacked";
    end?: ReactNode;
    /** What the navigation is, said to screen readers. */
    label?: string;
    className?: string;
  },
): ReactNode {
  const list = useRef<HTMLUListElement>(null);
  // The active place in view, where the places scroll sideways.
  useEffect(() => {
    list.current?.querySelector("[aria-current=page]")?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [active]);
  return (
    <div className={cx("copilotz-appbar", className)} data-layout={layout}>
      {SHEET}
      <div className="copilotz-appbar-inner">
        {brand !== undefined && brand !== null
          ? href !== undefined
            ? <a className="copilotz-appbar-brand" href={href}>{brand}</a>
            : <span className="copilotz-appbar-brand">{brand}</span>
          : null}
        {items.length
          ? (
            <nav className="copilotz-appbar-nav" aria-label={label ?? say("navigation")}>
              <ul ref={list} className="copilotz-appbar-items">
                {items.map((item) => {
                  const key = item.key ?? item.href;
                  return (
                    <li key={key}>
                      <a
                        className="copilotz-appbar-item"
                        href={item.href}
                        title={item.title}
                        aria-current={key === active ? "page" : undefined}
                      >
                        {iconOf(item.icon, 18)}
                        <span>{item.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )
          : <span className="copilotz-appbar-spacer" />}
        {end !== undefined && end !== null
          ? <div className="copilotz-appbar-end">{end}</div>
          : null}
      </div>
    </div>
  );
}

export function TopBar(
  { start, center, end, className }: {
    start?: ReactNode;
    center?: ReactNode;
    end?: ReactNode;
    className?: string;
  },
): ReactNode {
  return (
    <div className={cx("copilotz-topbar", className)}>
      {SHEET}
      <div className="copilotz-topbar-inner">
        <div className="copilotz-topbar-start">{start}</div>
        <div className="copilotz-topbar-center">{center}</div>
        <div className="copilotz-topbar-end">{end}</div>
      </div>
    </div>
  );
}
