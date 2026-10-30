/**
 * A choice from a few, the browser's own `<select>` (its list, keyboard and
 * screen-reader behaviour), in the toolkit's box: `sm`, `md` or `lg`.
 * Every prop is the `<select>`'s; `className` is the box's.
 *
 * ```tsx
 * <Select value={role} onChange={…}><option value="viewer">Viewer</option>…</Select>
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "select",
  `
.copilotz-select { position: relative; display: inline-flex; align-items: center; min-width: 160px; }
.copilotz-select > select { appearance: none; width: 100%; height: 40px; margin: 0; padding: 0 36px 0 12px;
  border: 1px solid var(--input); border-radius: var(--radius-lg); background: var(--card);
  color: var(--foreground); font-size: 14.5px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.copilotz-select > select:focus-visible { outline: none; border-color: var(--ring);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent); }
.copilotz-select > select:disabled { opacity: .55; cursor: default; }
.copilotz-select > .copilotz-icon { position: absolute; right: 11px; color: var(--muted-foreground); pointer-events: none; }
.copilotz-select-sm > select { height: 34px; border-radius: var(--radius-md); font-size: 14px; }
.copilotz-select-lg > select { height: 44px; font-size: 15px; }
`,
);

export function Select(
  { size = "md", className, children, ...rest }:
    & { size?: "sm" | "md" | "lg"; className?: string }
    & Omit<ComponentProps<"select">, "size">,
): ReactNode {
  return (
    <>
      {SHEET}
      <span
        className={cx("copilotz-select", size !== "md" && `copilotz-select-${size}`, className)}
      >
        <select {...rest}>{children}</select>
        <Icon name="chevron-down" size={16} />
      </span>
    </>
  );
}
