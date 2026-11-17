/**
 * A place or an action in a rail (a sidebar folded to its icons, as the web
 * shell's is): an `icon`, or anything `leading` (an avatar, the app's mark),
 * in a square, named by its `label`, which shows as a tooltip beside it (with
 * its `shortcut`, a key that does it too, as a keycap). A link (`href`), or a
 * button (`onClick`; or a menu's own trigger, given what opens it). `current`
 * is `NavItem`'s: `page`, the page open (raised), or `location`, where you
 * are (tinted). A `badge` (a count) sits at its corner, in the `warning` tone
 * for what waits on the person; it's only seen, so the label says it too.
 *
 * ```tsx
 * <RailItem href="/" icon="compose" label="New chat" current="page" />
 * <RailItem href="/thread/t1" icon="alert" label="2 chats waiting on you" badge={2} tone="warning" />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { Kbd } from "./kbd.tsx";
import { sheet } from "./sheet.tsx";
import { Tooltip } from "./tooltip.tsx";

type Own = {
  label: string;
  icon?: IconLike;
  /** Instead of an icon: an avatar, the app's mark. */
  leading?: ReactNode;
  current?: "page" | "location";
  /** A count at its corner (nothing when 0 or absent). */
  badge?: number;
  tone?: "warning";
  /** A key that does it too, as its tooltip shows it after the label: "⌘B". */
  shortcut?: string;
  /** Whether its label shows as a tooltip beside it (not while the menu it opens is open). */
  tooltip?: boolean;
  className?: string;
};

export type RailItemProps =
  & Own
  & (
    | ({ href?: undefined } & Omit<ComponentProps<"button">, keyof Own | "children">)
    | ({ href: string } & Omit<ComponentProps<"a">, keyof Own | "children">)
  );

const SHEET = sheet(
  "rail-item",
  `
.copilotz-rail-item { position: relative; display: grid; place-items: center; flex: none; width: 40px; height: 40px;
  padding: 0; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent;
  color: var(--sidebar-foreground); cursor: pointer; text-decoration: none;
  transition: background-color .12s, color .12s; }
.copilotz-rail-item > .copilotz-icon { color: var(--muted-foreground); transition: color .12s; }
.copilotz-rail-item:hover, .copilotz-rail-item[aria-expanded=true] { background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground); }
.copilotz-rail-item:hover > .copilotz-icon { color: inherit; }
.copilotz-rail-item[aria-current=page] { border-color: var(--border); background: var(--card);
  color: var(--card-foreground); box-shadow: var(--shadow-sm); }
.copilotz-rail-item[aria-current=location] { background: var(--primary-soft); }
.copilotz-rail-item[aria-current] > .copilotz-icon { color: var(--primary-text); }
.copilotz-rail-item[data-tone=warning] > .copilotz-icon { color: var(--warning-text); }
.copilotz-rail-badge { position: absolute; top: -2px; right: -3px; display: grid; place-items: center; min-width: 17px;
  height: 17px; padding: 0 4px; border-radius: var(--radius-full); background: var(--primary);
  color: var(--primary-foreground); outline: 2px solid var(--sidebar); font: 700 10px/1 var(--font-sans);
  font-variant-numeric: tabular-nums; pointer-events: none; }
.copilotz-rail-item[data-tone=warning] .copilotz-rail-badge { background: var(--warning);
  color: var(--warning-foreground); }
/* Touch screens: targets a finger finds */
@media (pointer: coarse) {
  .copilotz-rail-item { width: 44px; height: 44px; }
}
`,
);

export function RailItem(props: RailItemProps): ReactNode {
  const {
    label,
    icon,
    leading,
    current,
    badge,
    tone,
    shortcut,
    tooltip = true,
    className,
    ...rest
  } = props;
  const inside = (
    <>
      {icon ? iconOf(icon, 18) : leading}
      {badge ? <span className="copilotz-rail-badge" aria-hidden="true">{badge}</span> : null}
    </>
  );
  const common = {
    className: cx("copilotz-rail-item", className),
    "aria-label": label,
    "aria-current": current,
    "data-tone": tone,
  };
  const item = rest.href !== undefined
    ? <a {...rest as ComponentProps<"a">} {...common}>{inside}</a>
    : <button type="button" {...rest as ComponentProps<"button">} {...common}>{inside}</button>;
  return (
    <>
      {SHEET}
      <Tooltip
        text={shortcut
          ? (
            <>
              {label}
              <Kbd>{shortcut}</Kbd>
            </>
          )
          : label}
        side="end"
        describe={false}
        disabled={!tooltip}
      >
        {item}
      </Tooltip>
    </>
  );
}
