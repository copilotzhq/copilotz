/**
 * A choice from a few, the browser's own `<select>` (its list, keyboard and
 * screen-reader behaviour), in the toolkit's box: `sm`, `md` or `lg`.
 * Every prop is the `<select>`'s; `className` is the box's. Its look is the
 * Input's tokens (`input-height`, `input-radius`…) unless the theme sets its
 * own (`select-height`, `select-padding`…).
 *
 * `addon` before it and `addonEnd` after it are joined to it as the Input's
 * are (same classes and `input-addon-*` tokens); `className` is then the
 * group's. In a table cell it fills the cell and has no minimum width.
 *
 * ```tsx
 * <Select value={role} onChange={…}><option value="viewer">Viewer</option>…</Select>
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./icon.tsx";
import { AddonGroup } from "./input.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "select",
  `
.copilotz-select { position: relative; display: inline-flex; align-items: center;
  min-width: var(--select-min-width, 160px); }
.copilotz-select > select { appearance: none; width: 100%; margin: 0;
  height: var(--select-height, var(--input-height, 40px)); padding: var(--select-padding, 0 36px 0 12px);
  border: var(--select-border-width, var(--input-border-width, 1px)) solid var(--input);
  border-radius: var(--select-radius, var(--input-radius, var(--radius-lg)));
  background: var(--select-background, var(--input-background, var(--card)));
  color: var(--foreground); font-size: var(--select-font-size, var(--input-font-size, 14.5px)); cursor: pointer;
  transition: border-color .15s, box-shadow .15s; }
.copilotz-select > select:focus-visible { outline: none; border-color: var(--ring);
  box-shadow: var(--select-focus-shadow,
    var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))); }
.copilotz-select > select:disabled { opacity: var(--select-disabled-opacity, var(--input-disabled-opacity, .55));
  background: var(--select-disabled-background,
    var(--input-disabled-background, var(--select-background, var(--input-background, var(--card)))));
  cursor: default; }
.copilotz-select > .copilotz-icon { position: absolute; right: 11px; color: var(--muted-foreground); pointer-events: none; }
.copilotz-select-sm > select { height: var(--select-height-sm, var(--input-height-sm, 36px));
  border-radius: var(--select-radius-sm, var(--input-radius-sm, var(--radius-md)));
  font-size: var(--select-font-size-sm, var(--input-font-size-sm, 14px)); }
.copilotz-select-lg > select { height: var(--select-height-lg, var(--input-height-lg, 44px));
  font-size: var(--select-font-size-lg, var(--input-font-size-lg, 15px)); }
`,
);

export function Select(
  { size = "md", addon, addonEnd, className, children, ...rest }:
    & {
      size?: "sm" | "md" | "lg";
      /** Before the box, joined to it: words, a glyph or a control. */
      addon?: ReactNode;
      /** After the box, joined to it. */
      addonEnd?: ReactNode;
      className?: string;
    }
    & Omit<ComponentProps<"select">, "size">,
): ReactNode {
  const grouped = addon !== undefined || addonEnd !== undefined;
  const box = (
    <span
      className={cx(
        "copilotz-select",
        size !== "md" && `copilotz-select-${size}`,
        !grouped && className,
      )}
    >
      <select {...rest}>{children}</select>
      <Icon name="chevron-down" size={16} />
    </span>
  );
  return (
    <>
      {SHEET}
      {grouped
        ? (
          <AddonGroup addon={addon} addonEnd={addonEnd} size={size} className={className}>
            {box}
          </AddonGroup>
        )
        : box}
    </>
  );
}
