/**
 * A surface that holds one thing: a memory, a file, a form. Bordered, on the
 * card color, softly raised; `padding` (`md` by default, or `none` for a
 * front end's own). `interactive` when the card is itself a button or link
 * (`as="button"`, `as="a"`), so it answers the pointer.
 *
 * ```tsx
 * <Card as="li">{memory.text}</Card>
 * ```
 */
import type { ComponentProps, ElementType, ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "card",
  `
.copilotz-card { display: block; border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: var(--card); color: var(--card-foreground); box-shadow: var(--shadow-sm); text-align: left; }
.copilotz-card-md { padding: 14px 16px; }
.copilotz-card-sm { padding: 8px 10px; }
.copilotz-card-interactive { cursor: pointer; text-decoration: none; transition: background-color .15s, border-color .15s; }
.copilotz-card-interactive:hover:not(:disabled) { background: color-mix(in oklab, var(--muted) 70%, var(--card)); }
.copilotz-card-interactive:disabled { cursor: progress; opacity: .7; }
`,
);

export function Card(
  { as = "div", padding = "md", interactive, className, children, ...rest }:
    & {
      as?: "div" | "section" | "article" | "li" | "button" | "a" | "aside";
      padding?: "none" | "sm" | "md";
      interactive?: boolean;
      className?: string;
      children?: ReactNode;
    }
    & Omit<ComponentProps<"div"> & ComponentProps<"button"> & ComponentProps<"a">, "ref">,
): ReactNode {
  const Tag = as as ElementType;
  return (
    <>
      {SHEET}
      <Tag
        {...(as === "button" ? { type: "button" } : {})}
        {...rest}
        className={cx(
          "copilotz-card",
          padding !== "none" && `copilotz-card-${padding}`,
          interactive && "copilotz-card-interactive",
          className,
        )}
      >
        {children}
      </Tag>
    </>
  );
}
