/**
 * A button that is only an icon, named by its `label` (said to screen
 * readers, and shown as a tooltip unless `tooltip` is false): `ghost` (the
 * default), `outline`, `secondary` or `primary`; `sm`, `md` or `lg`.
 * `loading` shows a spinner and waits. Given an `href`, it's a link.
 *
 * ```tsx
 * <IconButton icon="close" label="Close" onClick={close} />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { Spinner } from "./spinner.tsx";
import { Tooltip } from "./tooltip.tsx";

type Own = {
  icon: IconName;
  label: string;
  variant?: "ghost" | "outline" | "secondary" | "primary";
  size?: "sm" | "md" | "lg";
  /** The glyph's size, when not the size's own. */
  iconSize?: number;
  loading?: boolean;
  tooltip?: boolean;
  className?: string;
};

export type IconButtonProps =
  & Own
  & (
    | ({ href?: undefined } & Omit<ComponentProps<"button">, keyof Own | "children">)
    | ({ href: string } & Omit<ComponentProps<"a">, keyof Own | "children">)
  );

const ICON = { sm: 15, md: 18, lg: 20 };

const SHEET = sheet(
  "icon-button",
  `
.copilotz-icon-button { display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px;
  padding: 0; border-radius: var(--radius-md); border: 1px solid transparent; background: transparent;
  color: var(--muted-foreground); cursor: pointer; text-decoration: none;
  transition: background-color .15s, color .15s, box-shadow .15s, transform .1s; }
.copilotz-icon-button:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
.copilotz-icon-button:disabled { opacity: .5; cursor: default; }
.copilotz-icon-button-sm { width: 28px; height: 28px; border-radius: var(--radius-sm); }
.copilotz-icon-button-lg { width: 38px; height: 38px; }
.copilotz-icon-button-outline { background: var(--card); color: var(--card-foreground); border-color: var(--input);
  box-shadow: var(--shadow-sm); }
.copilotz-icon-button-outline:hover:not(:disabled) { background: var(--muted); color: var(--card-foreground); }
.copilotz-icon-button-secondary { background: var(--secondary); color: var(--secondary-foreground); }
.copilotz-icon-button-primary { background: var(--primary); color: var(--primary-foreground); box-shadow: var(--shadow-sm); }
.copilotz-icon-button-primary:hover:not(:disabled) {
  background: color-mix(in oklab, var(--primary) 86%, var(--primary-foreground)); color: var(--primary-foreground); }
.copilotz-icon-button-primary:active:not(:disabled) { transform: scale(.94); }
.copilotz-icon-button-primary:disabled { opacity: 1; background: var(--muted); box-shadow: none;
  color: color-mix(in oklab, var(--muted-foreground) 55%, var(--background)); }
`,
);

export function IconButton(props: IconButtonProps): ReactNode {
  const {
    icon,
    label,
    variant = "ghost",
    size = "md",
    iconSize,
    loading,
    tooltip = true,
    className,
    ...rest
  } = props;
  const classes = cx(
    "copilotz-icon-button",
    variant !== "ghost" && `copilotz-icon-button-${variant}`,
    size !== "md" && `copilotz-icon-button-${size}`,
    className,
  );
  const glyph = loading
    ? <Spinner size={(iconSize ?? ICON[size]) - 3} />
    : <Icon name={icon} size={iconSize ?? ICON[size]} />;
  const button = rest.href !== undefined
    ? (
      <a {...rest as ComponentProps<"a">} className={classes} aria-label={label}>
        {glyph}
      </a>
    )
    : (
      <button
        type="button"
        {...rest as ComponentProps<"button">}
        className={classes}
        aria-label={label}
        disabled={(rest as ComponentProps<"button">).disabled || loading}
        aria-busy={loading || undefined}
      >
        {glyph}
      </button>
    );
  return (
    <>
      {SHEET}
      <Tooltip text={label} describe={false} disabled={!tooltip}>{button}</Tooltip>
    </>
  );
}
