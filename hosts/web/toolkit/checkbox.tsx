/**
 * A box to tick, with its `label` beside it (or none, named by
 * `aria-label`). The browser's own checkbox, drawn in the theme's colors;
 * its size, radius and border are the theme's (`checkbox-size`,
 * `checkbox-radius`, `checkbox-border-width`, `checkbox-gap`).
 *
 * ```tsx
 * <Checkbox label="Core: always in mind" checked={core} onChange={…} />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "checkbox",
  `
.copilotz-checkbox { display: inline-flex; align-items: flex-start; gap: var(--checkbox-gap, 9px);
  font-size: var(--checkbox-font-size, 14px); line-height: 1.45; cursor: pointer; }
.copilotz-checkbox > input { appearance: none; flex: none; display: grid; place-content: center;
  width: var(--checkbox-size, 16px); height: var(--checkbox-size, 16px); margin: .15em 0 0;
  border: var(--checkbox-border-width, 1.5px) solid var(--input);
  border-radius: var(--checkbox-radius, calc(var(--radius) / 3)); background: var(--card); cursor: inherit;
  transition: background-color .12s, border-color .12s; }
.copilotz-checkbox > input::before { content: ""; width: calc(var(--checkbox-size, 16px) * .625);
  height: calc(var(--checkbox-size, 16px) * .625); background: var(--primary-foreground);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%); transform: scale(0);
  transition: transform .12s; }
.copilotz-checkbox > input:checked { border-color: var(--primary); background: var(--primary); }
.copilotz-checkbox > input:checked::before { transform: scale(1); }
.copilotz-checkbox > input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.copilotz-checkbox:has(> input:disabled) { cursor: default; }
.copilotz-checkbox > input:disabled:not(:checked) { opacity: .7; }
`,
);

export function Checkbox(
  { label, className, ...rest }:
    & { label?: ReactNode; className?: string }
    & Omit<ComponentProps<"input">, "type">,
): ReactNode {
  return (
    <>
      {SHEET}
      <label className={cx("copilotz-checkbox", className)}>
        <input {...rest} type="checkbox" />
        {label ? <span>{label}</span> : null}
      </label>
    </>
  );
}
