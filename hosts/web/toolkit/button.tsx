/**
 * A button: `primary` (the one thing to do), `secondary`, `outline` (the
 * default), `ghost`, `destructive` or `link`, or a status's solid fill
 * (`success`, `info`, `warning`); `xs`, `sm`, `md` or `lg`; `block`, as wide
 * as its box. With an `icon` before its text (or `iconEnd` after it), by name
 * or an element of the app's own; `loading` shows a spinner and waits. Given
 * an `href`, it's a link that looks like a button, as navigation is links.
 *
 * Its look is the theme's: sizes, padding, radius, type and border by its
 * tokens (`button-height`, `button-padding-sm`, `button-radius`…), the
 * `outline` button's colours by `button-outline-*`, and how a filled one
 * changes under the pointer by `button-hover-mix` (the colour mixed in) and
 * `button-hover-amount` (how much).
 *
 * ```tsx
 * <Button variant="primary" icon="compose" href="/">New conversation</Button>
 * <Button size="sm" onClick={share} icon="share">Share</Button>
 * <Button variant="success" size="xs" icon={<Icon drawing={GLYPHS.ok} />}>Paid</Button>
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { Spinner } from "./spinner.tsx";

type Own = {
  variant?:
    | "primary"
    | "secondary"
    | "outline"
    | "ghost"
    | "destructive"
    | "success"
    | "info"
    | "warning"
    | "link";
  size?: "xs" | "sm" | "md" | "lg";
  icon?: IconLike;
  iconEnd?: IconLike;
  loading?: boolean;
  /** As wide as its box. */
  block?: boolean;
  className?: string;
  children?: ReactNode;
};

export type ButtonProps =
  & Own
  & (
    | ({ href?: undefined } & Omit<ComponentProps<"button">, keyof Own>)
    | ({ href: string } & Omit<ComponentProps<"a">, keyof Own>)
  );

const ICON = { xs: 13, sm: 14, md: 16, lg: 18 };

/** A filled button's fill under the pointer: its colour with another mixed in (the theme's, or its own). */
const HOVER = "color-mix(in oklab, var(--tone-fill), " +
  "var(--button-hover-mix, var(--tone-toward)) var(--button-hover-amount, var(--tone-amount)))";

/** A solid fill in a role's colours, changing under the pointer as `destructive` does. */
const solid = (variant: string, role: string) => `
.copilotz-button-${variant} { --tone-fill: var(--${role}); --tone-toward: var(--foreground); --tone-amount: 13%;
  background: var(--tone-fill); color: var(--${role}-foreground);
  box-shadow: var(--button-shadow, var(--shadow-sm)); }
.copilotz-button-${variant}:hover:not(:disabled) { background: ${HOVER}; }`;

const SHEET = sheet(
  "button",
  `
.copilotz-button { display: inline-flex; align-items: center; justify-content: center; gap: var(--button-gap, 8px);
  min-height: var(--button-height, 36px); padding: var(--button-padding, 0 14px);
  border-radius: var(--button-radius, var(--radius-md));
  border: var(--button-border-width, 1px) solid transparent;
  background: transparent; color: inherit;
  font-size: var(--button-font-size, 14px); font-weight: var(--button-font-weight, 560);
  line-height: var(--button-line-height, 1);
  cursor: pointer; text-decoration: none; white-space: nowrap; user-select: none;
  transition: background-color .15s, border-color .15s, box-shadow .15s, color .15s, opacity .15s; }
.copilotz-button:active:not(:disabled) { transform: var(--button-active-transform, translateY(.5px)); }
.copilotz-button:is(.copilotz-button-outline, .copilotz-button-primary, .copilotz-button-destructive,
  .copilotz-button-success, .copilotz-button-info, .copilotz-button-warning):active:not(:disabled) {
  box-shadow: var(--button-active-shadow, var(--button-shadow, var(--shadow-sm))); }
.copilotz-button:disabled { opacity: var(--button-disabled-opacity, .5); cursor: var(--button-disabled-cursor, default); }
.copilotz-button[aria-busy=true] { cursor: progress; }
.copilotz-button-xs { min-height: var(--button-height-xs, 26px); padding: var(--button-padding-xs, 0 8px);
  gap: var(--button-gap-xs, 5px); font-size: var(--button-font-size-xs, 12px);
  border-radius: var(--button-radius-xs, var(--button-radius, var(--radius-md))); }
.copilotz-button-sm { min-height: var(--button-height-sm, 30px); padding: var(--button-padding-sm, 0 11px);
  gap: var(--button-gap-sm, 6px); font-size: var(--button-font-size-sm, 13px);
  border-radius: var(--button-radius-sm, var(--button-radius, var(--radius-md))); }
.copilotz-button-lg { min-height: var(--button-height-lg, 44px); padding: var(--button-padding-lg, 0 18px);
  font-size: var(--button-font-size-lg, 15px);
  border-radius: var(--button-radius-lg, var(--button-radius, var(--radius-md))); }
.copilotz-button-block { display: flex; width: 100%; }
/* Touch screens: targets a finger finds (44px, as phones' own guidelines ask) */
@media (pointer: coarse) {
  .copilotz-button { min-height: max(44px, var(--button-height, 36px)); }
  .copilotz-button-xs { min-height: max(36px, var(--button-height-xs, 26px)); }
  .copilotz-button-sm { min-height: max(40px, var(--button-height-sm, 30px)); }
  .copilotz-button-lg { min-height: max(48px, var(--button-height-lg, 44px)); }
}
.copilotz-button-outline { background: var(--button-outline-background, var(--card));
  color: var(--button-outline-foreground, var(--card-foreground));
  border-color: var(--button-outline-border, var(--input)); box-shadow: var(--button-shadow, var(--shadow-sm)); }
.copilotz-button-outline:hover:not(:disabled) {
  background: var(--button-outline-hover-background, var(--muted));
  color: var(--button-outline-hover-foreground, var(--button-outline-foreground, var(--card-foreground)));
  border-color: var(--button-outline-hover-border, var(--button-outline-border, var(--input))); }
.copilotz-button-primary { --tone-fill: var(--primary); --tone-toward: var(--primary-foreground); --tone-amount: 14%;
  background: var(--tone-fill); color: var(--primary-foreground); box-shadow: var(--button-shadow, var(--shadow-sm)); }
.copilotz-button-primary:hover:not(:disabled) { background: ${HOVER}; }
.copilotz-button-secondary { background: var(--secondary); color: var(--secondary-foreground); }
.copilotz-button-secondary:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
.copilotz-button-ghost { color: var(--secondary-foreground); }
.copilotz-button-ghost:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
${solid("destructive", "destructive")}
${solid("success", "success")}
${solid("info", "info")}
${solid("warning", "warning")}
.copilotz-button-link { min-height: 0; padding: var(--button-link-padding, 0); border: 0;
  border-radius: var(--radius-xs); gap: 5px;
  color: var(--button-link-foreground, var(--primary-text)); text-underline-offset: 3px; text-decoration-thickness: 1px; }
.copilotz-button-link:hover:not(:disabled) { text-decoration-line: underline; }
`,
);

export function Button(props: ButtonProps): ReactNode {
  const {
    variant = "outline",
    size = "md",
    icon,
    iconEnd,
    loading,
    block,
    className,
    children,
    ...rest
  } = props;
  const classes = cx(
    "copilotz-button",
    `copilotz-button-${variant}`,
    size !== "md" && `copilotz-button-${size}`,
    block && "copilotz-button-block",
    className,
  );
  const inside = (
    <>
      {loading ? <Spinner size={ICON[size] - 2} /> : iconOf(icon, ICON[size])}
      {children}
      {iconOf(iconEnd, ICON[size])}
    </>
  );
  if (rest.href !== undefined) {
    return (
      <>
        {SHEET}
        <a {...rest as ComponentProps<"a">} className={classes}>{inside}</a>
      </>
    );
  }
  const button = rest as ComponentProps<"button">;
  return (
    <>
      {SHEET}
      <button
        type="button"
        {...button}
        className={classes}
        disabled={button.disabled || loading}
        aria-busy={loading || undefined}
      >
        {inside}
      </button>
    </>
  );
}
