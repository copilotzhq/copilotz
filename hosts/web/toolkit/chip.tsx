/**
 * A pill with a few words and an icon (or an avatar, as a child): where a
 * conversation is, what an agent did, something to start with. `soft` (the
 * default), `outline` or `primary`; `sm`, `md` or `lg`. With `onClick` it's a
 * button, with `href` a link, and `as="summary"` it opens a `<details>`.
 *
 * ```tsx
 * <Chip size="sm" icon="person">Personal</Chip>
 * <Chip variant="outline" onClick={() => pick(text)}>{text}</Chip>
 * ```
 */
import type { MouseEventHandler, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "chip",
  `
.copilotz-chip { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 30px;
  padding: 4px 11px; border: 1px solid transparent; border-radius: var(--radius-full);
  background: var(--muted); color: var(--secondary-foreground); font-size: 13px; font-weight: 500;
  line-height: 1.35; text-align: left; text-decoration: none; white-space: nowrap; list-style: none;
  user-select: none; transition: background-color .15s, border-color .15s, color .15s; }
.copilotz-chip::-webkit-details-marker { display: none; }
.copilotz-chip > .copilotz-icon { color: var(--muted-foreground); }
.copilotz-chip-sm { gap: 6px; min-height: 24px; padding: 2px 9px; font-size: 12.5px; font-weight: 540; }
.copilotz-chip-lg { min-height: 36px; padding: 7px 14px; font-size: 13.5px; }
.copilotz-chip-outline { background: var(--card); border-color: var(--border); }
.copilotz-chip-primary { background: var(--primary-soft); color: var(--primary-text); font-weight: 560; }
.copilotz-chip-primary > .copilotz-icon { color: inherit; }
.copilotz-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
:is(button, a, summary).copilotz-chip { cursor: pointer; }
:is(button, a, summary).copilotz-chip-outline { box-shadow: var(--shadow-sm); }
:is(button, a, summary).copilotz-chip:hover { background: var(--accent); color: var(--accent-foreground); }
:is(button, a, summary).copilotz-chip-outline:hover { background: var(--muted); border-color: var(--input); }
:is(button, a, summary).copilotz-chip-primary:hover {
  background: color-mix(in oklab, var(--primary) 16%, var(--background)); color: var(--primary-text); }
`,
);

export function Chip(
  { variant = "soft", size = "md", icon, as, href, onClick, className, title, children }: {
    variant?: "soft" | "outline" | "primary";
    size?: "sm" | "md" | "lg";
    icon?: IconName;
    as?: "span" | "summary";
    href?: string;
    onClick?: MouseEventHandler<HTMLElement>;
    className?: string;
    title?: string;
    children: ReactNode;
  },
): ReactNode {
  const classes = cx(
    "copilotz-chip",
    variant !== "soft" && `copilotz-chip-${variant}`,
    size !== "md" && `copilotz-chip-${size}`,
    className,
  );
  const inside = (
    <>
      {icon ? <Icon name={icon} size={size === "sm" ? 13 : 14} /> : null}
      {typeof children === "string"
        ? <span className="copilotz-chip-text">{children}</span>
        : children}
    </>
  );
  const Tag = href !== undefined ? "a" : as ?? (onClick ? "button" : "span");
  return (
    <>
      {SHEET}
      <Tag
        className={classes}
        title={title}
        onClick={onClick}
        {...(Tag === "a" ? { href } : Tag === "button" ? { type: "button" as const } : {})}
      >
        {inside}
      </Tag>
    </>
  );
}
