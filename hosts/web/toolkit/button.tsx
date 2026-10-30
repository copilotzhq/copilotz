/**
 * A button: `primary` (the one thing to do), `secondary`, `outline` (the
 * default), `ghost`, `destructive` or `link`; `sm`, `md` or `lg`. With an
 * `icon` before its text (or `iconEnd` after it); `loading` shows a spinner
 * and waits. Given an `href`, it's a link that looks like a button, as
 * navigation is links.
 *
 * ```tsx
 * <Button variant="primary" icon="compose" href="/">New conversation</Button>
 * <Button size="sm" onClick={share} icon="share">Share</Button>
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { Spinner } from "./spinner.tsx";

type Own = {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconEnd?: IconName;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
};

export type ButtonProps =
  & Own
  & (
    | ({ href?: undefined } & Omit<ComponentProps<"button">, keyof Own>)
    | ({ href: string } & Omit<ComponentProps<"a">, keyof Own>)
  );

const ICON = { sm: 14, md: 16, lg: 18 };

const SHEET = sheet(
  "button",
  `
.copilotz-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 36px; padding: 0 14px; border-radius: var(--radius-md); border: 1px solid transparent;
  background: transparent; color: inherit; font-size: 14px; font-weight: 560; line-height: 1;
  cursor: pointer; text-decoration: none; white-space: nowrap; user-select: none;
  transition: background-color .15s, border-color .15s, box-shadow .15s, color .15s, opacity .15s; }
.copilotz-button:active:not(:disabled) { transform: translateY(.5px); }
.copilotz-button:disabled { opacity: .5; cursor: default; }
.copilotz-button[aria-busy=true] { cursor: progress; }
.copilotz-button-sm { min-height: 30px; padding: 0 11px; gap: 6px; font-size: 13px; }
.copilotz-button-lg { min-height: 44px; padding: 0 18px; font-size: 15px; }
.copilotz-button-outline { background: var(--card); color: var(--card-foreground); border-color: var(--input);
  box-shadow: var(--shadow-sm); }
.copilotz-button-outline:hover:not(:disabled) { background: var(--muted); }
.copilotz-button-primary { background: var(--primary); color: var(--primary-foreground); box-shadow: var(--shadow-sm); }
.copilotz-button-primary:hover:not(:disabled) {
  background: color-mix(in oklab, var(--primary) 86%, var(--primary-foreground)); }
.copilotz-button-secondary { background: var(--secondary); color: var(--secondary-foreground); }
.copilotz-button-secondary:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
.copilotz-button-ghost { color: var(--secondary-foreground); }
.copilotz-button-ghost:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
.copilotz-button-destructive { background: var(--destructive); color: var(--destructive-foreground);
  box-shadow: var(--shadow-sm); }
.copilotz-button-destructive:hover:not(:disabled) {
  background: color-mix(in oklab, var(--destructive) 87%, var(--foreground)); }
.copilotz-button-link { min-height: 0; padding: 0; border: 0; border-radius: var(--radius-xs); gap: 5px;
  color: var(--primary-text); text-underline-offset: 3px; text-decoration-thickness: 1px; }
.copilotz-button-link:hover:not(:disabled) { text-decoration-line: underline; }
`,
);

export function Button(props: ButtonProps): ReactNode {
  const { variant = "outline", size = "md", icon, iconEnd, loading, className, children, ...rest } =
    props;
  const classes = cx(
    "copilotz-button",
    `copilotz-button-${variant}`,
    size !== "md" && `copilotz-button-${size}`,
    className,
  );
  const inside = (
    <>
      {loading
        ? <Spinner size={ICON[size] - 2} />
        : icon
        ? <Icon name={icon} size={ICON[size]} />
        : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={ICON[size]} /> : null}
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
