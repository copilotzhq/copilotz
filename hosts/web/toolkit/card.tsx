/**
 * A surface that holds one thing: a memory, a file, a form. Bordered, on the
 * card color, softly raised; `padding` (`md` by default, or `none` for a
 * front end's own). `interactive` when the card is itself a button or link
 * (`as="button"`, `as="a"`), so it answers the pointer.
 *
 * With a `title`, it has a heading over what it holds (a panel): an `icon`
 * before the title (by name, or the app's own), an `action` at its end, and
 * `padding` is then the body's under it (`none` for a list that runs to its
 * edges). The heading is an `<h3>` unless `level` says otherwise.
 *
 * Its look is the theme's: `card-radius`, `card-border-color`, `card-shadow`,
 * `card-padding` (and `-sm`), and for the heading `card-head-*` (padding,
 * background, foreground, border) and `card-title-*` (font size, weight,
 * family).
 *
 * ```tsx
 * <Card as="li">{memory.text}</Card>
 * <Card title="Summary reports" icon="chart" padding="none"><ListGroup flush items={…} /></Card>
 * ```
 */
import type { ComponentProps, ElementType, ReactNode } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "card",
  `
.copilotz-card { display: block; border: 1px solid var(--card-border-color, var(--border));
  border-radius: var(--card-radius, var(--radius-xl)); background: var(--card); color: var(--card-foreground);
  box-shadow: var(--card-shadow, var(--shadow-sm)); text-align: left; }
.copilotz-card-md { padding: var(--card-padding, 14px 16px); }
.copilotz-card-sm { padding: var(--card-padding-sm, 8px 10px); }
.copilotz-card-interactive { cursor: pointer; text-decoration: none; transition: background-color .15s, border-color .15s; }
.copilotz-card-interactive:hover:not(:disabled) { background: color-mix(in oklab, var(--muted) 70%, var(--card)); }
.copilotz-card-interactive:disabled { cursor: progress; opacity: .7; }
.copilotz-card-head { display: flex; align-items: center; gap: 9px; min-height: 48px;
  padding: var(--card-head-padding, 10px 16px); border-bottom: var(--card-head-border, 1px solid var(--border));
  border-start-start-radius: inherit; border-start-end-radius: inherit;
  background: var(--card-head-background, transparent); color: var(--card-head-foreground, inherit); }
.copilotz-card-head > .copilotz-icon { color: var(--card-head-icon-color, var(--muted-foreground)); }
.copilotz-card-title { flex: 1; min-width: 0; margin: 0; font-family: var(--card-title-font-family, var(--font-display));
  font-size: var(--card-title-font-size, 15px); font-weight: var(--card-title-font-weight, 600); line-height: 1.3;
  letter-spacing: -.005em; overflow-wrap: anywhere; }
.copilotz-card-action { flex: none; display: flex; align-items: center; gap: 6px; margin-block: -4px; }
`,
);

export function Card(
  {
    as = "div",
    padding = "md",
    interactive,
    title,
    icon,
    action,
    level = 3,
    className,
    children,
    ...rest
  }:
    & {
      as?: "div" | "section" | "article" | "li" | "button" | "a" | "aside";
      padding?: "none" | "sm" | "md";
      interactive?: boolean;
      /** A heading over what it holds. */
      title?: ReactNode;
      /** Before the title. */
      icon?: IconLike;
      /** At the heading's end: a button, a menu. */
      action?: ReactNode;
      /** The heading's level: `<h3>` unless given. */
      level?: 2 | 3 | 4 | 5 | 6;
      className?: string;
      children?: ReactNode;
    }
    & Omit<
      ComponentProps<"div"> & ComponentProps<"button"> & ComponentProps<"a">,
      "ref" | "title"
    >,
): ReactNode {
  const Tag = as as ElementType;
  const Heading = `h${level}` as ElementType;
  const pad = padding !== "none" && `copilotz-card-${padding}`;
  const headed = title !== undefined && title !== null && title !== false;
  return (
    <>
      {SHEET}
      <Tag
        {...(as === "button" ? { type: "button" } : {})}
        {...rest}
        className={cx(
          "copilotz-card",
          !headed && pad,
          interactive && "copilotz-card-interactive",
          className,
        )}
      >
        {headed
          ? (
            <>
              <div className="copilotz-card-head">
                {iconOf(icon, 16)}
                <Heading className="copilotz-card-title">{title}</Heading>
                {action ? <div className="copilotz-card-action">{action}</div> : null}
              </div>
              <div className={cx("copilotz-card-body", pad)}>{children}</div>
            </>
          )
          : children}
      </Tag>
    </>
  );
}
