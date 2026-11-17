/**
 * Words in the theme's type, without CSS. `Text` is a run of text: a `size`
 * (`xs` to `lg`), a `tone` (`muted` for what's quieter; `primary`,
 * `success`, `warning`, `danger`, `info` for what it says), a `weight`, an
 * `align`ment, `mono` for figures and codes, `truncate` to one line; a
 * `span` unless `as` says (`p`, `div`, `label`, `strong`). `Heading` is a
 * section's title, `h1` to `h4` (`level`), in the theme's display font,
 * sized by its level unless `size` says (each size a token).
 *
 * ```tsx
 * <Heading level={2}>Payments</Heading>
 * <Text as="p" tone="muted" size="sm">Fields marked * are required.</Text>
 * <Text weight="bold" align="end" mono>{total}</Text>
 * ```
 */
import { type ComponentProps, createElement, type ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

/** What a text says, by colour. */
export type TextTone = "default" | "muted" | "primary" | "success" | "warning" | "danger" | "info";

const SHEET = sheet(
  "text",
  `
.copilotz-text-xs { font-size: var(--text-size-xs, 12px); line-height: 1.4; }
.copilotz-text-sm { font-size: var(--text-size-sm, 13px); line-height: 1.45; }
.copilotz-text-md { font-size: var(--text-size-md, 14.5px); line-height: 1.55; }
.copilotz-text-lg { font-size: var(--text-size-lg, 17px); line-height: 1.5; }
p.copilotz-text { margin: 0; }
.copilotz-text-muted { color: var(--muted-foreground); }
.copilotz-text-primary { color: var(--primary-text); }
.copilotz-text-success { color: var(--success-text); }
.copilotz-text-warning { color: var(--warning-text); }
.copilotz-text-danger { color: var(--destructive-text); }
.copilotz-text-info { color: var(--info-text); }
.copilotz-text-regular { font-weight: 400; }
.copilotz-text-medium { font-weight: 560; }
.copilotz-text-bold { font-weight: 680; }
.copilotz-text-start { text-align: start; }
.copilotz-text-center { text-align: center; }
.copilotz-text-end { text-align: end; }
.copilotz-text-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.copilotz-text-truncate { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-heading { margin: 0; color: var(--foreground); font-family: var(--heading-font, var(--font-display));
  font-weight: var(--heading-font-weight, 650); letter-spacing: var(--heading-letter-spacing, -.015em);
  line-height: 1.25; overflow-wrap: anywhere; }
.copilotz-heading-1 { font-size: var(--heading-size-1, 28px); letter-spacing: -.025em; }
.copilotz-heading-2 { font-size: var(--heading-size-2, 21px); }
.copilotz-heading-3 { font-size: var(--heading-size-3, 17px); }
.copilotz-heading-4 { font-size: var(--heading-size-4, 15px); }
`,
);

export function Text(
  {
    as = "span",
    size,
    tone = "default",
    weight,
    align,
    mono,
    truncate,
    className,
    children,
    ...rest
  }:
    & {
      as?: "span" | "p" | "div" | "label" | "strong" | "small" | "em";
      size?: "xs" | "sm" | "md" | "lg";
      tone?: TextTone;
      weight?: "regular" | "medium" | "bold";
      align?: "start" | "center" | "end";
      mono?: boolean;
      truncate?: boolean;
      className?: string;
      children?: ReactNode;
    }
    & Omit<ComponentProps<"span">, "className" | "children">,
): ReactNode {
  return createElement(
    as,
    {
      ...rest,
      className: cx(
        "copilotz-text",
        size && `copilotz-text-${size}`,
        tone !== "default" && `copilotz-text-${tone}`,
        weight && `copilotz-text-${weight}`,
        align && `copilotz-text-${align}`,
        mono && "copilotz-text-mono",
        truncate && "copilotz-text-truncate",
        className,
      ),
    },
    SHEET,
    children,
  );
}

export function Heading(
  { level = 2, size, className, children, ...rest }:
    & {
      level?: 1 | 2 | 3 | 4;
      /** Sized as another level's (an `h2` that looks like an `h3`). */
      size?: 1 | 2 | 3 | 4;
      className?: string;
      children?: ReactNode;
    }
    & Omit<ComponentProps<"h2">, "className" | "children">,
): ReactNode {
  return createElement(
    `h${level}`,
    { ...rest, className: cx("copilotz-heading", `copilotz-heading-${size ?? level}`, className) },
    SHEET,
    children,
  );
}
