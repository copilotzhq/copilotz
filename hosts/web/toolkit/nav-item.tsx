/**
 * A row in a navigation list (a sidebar's spaces, conversations, pages): a
 * link (`href`), or a button (`onClick`), with an `icon` or anything
 * `leading` (an avatar), its label, anything at its `end` (a count, a time,
 * a check), and a `description` line under it. It never widens its list: what
 * doesn't fit ends in an ellipsis. `current` says which it is
 * and shows it: `page`, the page open (raised); `location`, where you are,
 * such as the space you work in (tinted). `quiet` for a quieter action row.
 * A button that folds a list says so (`aria-expanded`, `aria-controls`).
 *
 * ```tsx
 * <NavItem href="/memories" icon="sparkles" current="page" end={<Badge>4</Badge>}>
 *   Memories
 * </NavItem>
 * ```
 */
import type { MouseEventHandler, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "nav-item",
  `
.copilotz-nav-item { display: flex; flex-direction: column; justify-content: center; gap: 1px; width: 100%;
  contain: inline-size; min-height: 36px; padding: 5px 9px; border: 1px solid transparent;
  border-radius: var(--radius-md); background: transparent; color: var(--sidebar-foreground); font-size: 14px;
  text-align: left; text-decoration: none; cursor: pointer; transition: background-color .12s, color .12s; }
.copilotz-nav-item:hover { background: var(--sidebar-accent); color: var(--sidebar-accent-foreground); }
.copilotz-nav-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.copilotz-nav-icon { display: grid; place-items: center; flex: none; width: 22px; height: 22px; color: var(--primary-text); }
.copilotz-nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-nav-item:has(.copilotz-nav-description) { padding-block: 6px; }
.copilotz-nav-item:has(.copilotz-nav-description) .copilotz-nav-label { font-weight: 520; }
.copilotz-nav-end { flex: none; display: flex; align-items: center; color: var(--muted-foreground); font-size: 11.5px; }
.copilotz-nav-end > .copilotz-time { font-size: 11.5px; }
.copilotz-nav-description { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted-foreground); font-size: 12.5px; }
.copilotz-nav-item[aria-current=page] { border-color: var(--border); background: var(--card);
  color: var(--card-foreground); box-shadow: var(--shadow-sm); }
.copilotz-nav-item[aria-current=location] { background: var(--primary-soft); color: var(--sidebar-foreground); }
.copilotz-nav-item[aria-current] .copilotz-nav-label { font-weight: 620; }
.copilotz-nav-item[aria-current=location] .copilotz-nav-end { color: var(--primary-text); }
.copilotz-nav-quiet { color: var(--muted-foreground); }
`,
);

export function NavItem(
  {
    href,
    onClick,
    icon,
    leading,
    end,
    description,
    current,
    quiet,
    title,
    className,
    children,
    ...aria
  }: {
    href?: string;
    onClick?: MouseEventHandler<HTMLElement>;
    icon?: IconName;
    leading?: ReactNode;
    end?: ReactNode;
    description?: ReactNode;
    current?: "page" | "location";
    quiet?: boolean;
    title?: string;
    className?: string;
    children: ReactNode;
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
  },
): ReactNode {
  const inside = (
    <>
      <span className="copilotz-nav-row">
        {icon
          ? (
            <span className="copilotz-nav-icon">
              <Icon name={icon} size={16} />
            </span>
          )
          : leading}
        <span className="copilotz-nav-label">{children}</span>
        {end ? <span className="copilotz-nav-end">{end}</span> : null}
      </span>
      {description ? <span className="copilotz-nav-description">{description}</span> : null}
    </>
  );
  const common = {
    className: cx("copilotz-nav-item", quiet && "copilotz-nav-quiet", className),
    title,
    onClick,
    "aria-current": current,
    ...aria,
  };
  return (
    <>
      {SHEET}
      {href !== undefined
        ? <a {...common} href={href}>{inside}</a>
        : <button type="button" {...common}>{inside}</button>}
    </>
  );
}
