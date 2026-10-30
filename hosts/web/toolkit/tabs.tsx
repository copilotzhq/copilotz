/**
 * Views of one thing, one at a time: a tablist, `segmented` (the default, a
 * track with the current one raised) or `line` (underlined). Each tab is a
 * `value`, a `label`, maybe an `icon` and a `count`. Arrow keys, Home and
 * End move between them and choose as they go; only the current one is in
 * the tab order. `panel` is the id of what they show, which says
 * `role="tabpanel"`. A tab with an `href` is a link (a page's tab that the
 * address says, `?tab=files`): following it is choosing it, and it opens in
 * a new browser tab as links do. Where they don't all fit, they scroll
 * sideways, and the chosen one is kept in view.
 *
 * ```tsx
 * <Tabs label="Which memories" value={which} onChange={setWhich} panel={id}
 *   tabs={[{ value: "all", label: "All", count: 12 }, { value: "core", label: "Core", count: 3 }]} />
 * ```
 */
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

export type Tab<T extends string> = {
  value: T;
  label: ReactNode;
  icon?: IconName;
  count?: number;
  /** Where choosing it goes, as a link. */
  href?: string;
  /** Its name on hover, for a tab that shows only its icon. */
  title?: string;
};

const SHEET = sheet(
  "tabs",
  `
.copilotz-tabs { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; overflow-x: auto;
  scrollbar-width: none; }
.copilotz-tab { display: inline-flex; text-decoration: none; align-items: center; gap: 6px; flex: none; height: 34px; padding: 0 12px;
  border: 0; border-radius: var(--radius-md); background: transparent; color: var(--muted-foreground);
  font-size: 13.5px; font-weight: 560; white-space: nowrap; cursor: pointer;
  transition: background-color .15s, color .15s, box-shadow .15s, border-color .15s; }
.copilotz-tab:hover { color: var(--foreground); }
.copilotz-tab:focus-visible { outline-offset: -1px; }
.copilotz-tab-count { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
.copilotz-tabs-segmented { padding: 3px; border-radius: var(--radius-lg); background: var(--muted); }
.copilotz-tabs-segmented .copilotz-tab[aria-selected=true] { background: var(--card); color: var(--card-foreground);
  box-shadow: var(--shadow-sm); }
.copilotz-tabs-line { gap: 6px; border-bottom: 1px solid var(--border); }
.copilotz-tabs-line .copilotz-tab { height: 40px; padding: 0 6px; border-radius: 0; border-bottom: 2px solid transparent;
  margin-bottom: -1px; }
.copilotz-tabs-line .copilotz-tab[aria-selected=true] { color: var(--foreground); border-bottom-color: var(--primary); }
`,
);

export function Tabs<T extends string>(
  { label, value, onChange, tabs, variant = "segmented", panel, className }: {
    label: string;
    value: T;
    onChange(value: NoInfer<T>): void;
    tabs: Tab<NoInfer<T>>[];
    variant?: "segmented" | "line";
    panel?: string;
    className?: string;
  },
): ReactNode {
  const list = useRef<HTMLDivElement>(null);
  // The chosen one in view, sideways only (the page doesn't move).
  useLayoutEffect(() => {
    const box = list.current;
    const tab = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !tab || box.scrollWidth <= box.clientWidth) return;
    const left = tab.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft) box.scrollLeft = left - 12;
    else if (left + tab.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = left + tab.offsetWidth - box.clientWidth + 24;
    }
  }, [value]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.value === value);
    const next = {
      ArrowRight: at + 1,
      ArrowDown: at + 1,
      ArrowLeft: at - 1,
      ArrowUp: at - 1,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    onChange(tab.value);
    list.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(tab.value)}"]`)?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={cx("copilotz-tabs", `copilotz-tabs-${variant}`, className)}
      onKeyDown={keys}
    >
      {SHEET}
      {tabs.map((tab) => {
        const current = tab.value === value;
        const own = {
          role: "tab",
          className: "copilotz-tab",
          "data-value": tab.value,
          "aria-selected": current,
          "aria-controls": panel,
          tabIndex: current ? 0 : -1,
          title: tab.title,
        };
        const inside = (
          <>
            {tab.icon ? <Icon name={tab.icon} size={15} /> : null}
            {tab.label}
            {tab.count !== undefined
              ? <span className="copilotz-tab-count">{tab.count}</span>
              : null}
          </>
        );
        return tab.href !== undefined
          ? <a key={tab.value} {...own} href={tab.href}>{inside}</a>
          : (
            <button key={tab.value} type="button" {...own} onClick={() => onChange(tab.value)}>
              {inside}
            </button>
          );
      })}
    </div>
  );
}
