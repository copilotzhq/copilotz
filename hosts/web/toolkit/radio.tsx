/**
 * One choice of several, with its `label` beside it (or none, named by
 * `aria-label`): the browser's own radio button, drawn in the theme's
 * colours as the Checkbox is. Radios that share a `name` are one choice:
 * arrows move between them, and Tab passes over the group. Its size,
 * border and gap are the theme's (`radio-size`, `radio-border-width`,
 * `radio-gap`).
 *
 * ```tsx
 * <Radio name="plan" value="month" label="Monthly" checked={plan === "month"} onChange={…} />
 * <Radio name="plan" value="year" label="Yearly" checked={plan === "year"} onChange={…} />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "radio",
  `
.copilotz-radio { display: inline-flex; align-items: flex-start; gap: var(--radio-gap, 9px);
  font-size: var(--radio-font-size, 14px); line-height: 1.45; cursor: pointer; }
.copilotz-radio > input { appearance: none; flex: none; display: grid; place-content: center;
  width: var(--radio-size, 16px); height: var(--radio-size, 16px); margin: .15em 0 0;
  border: var(--radio-border-width, 1.5px) solid var(--input); border-radius: 50%; background: var(--card);
  cursor: inherit; transition: border-color .12s; }
.copilotz-radio > input::before { content: ""; width: calc(var(--radio-size, 16px) / 2);
  height: calc(var(--radio-size, 16px) / 2); border-radius: 50%; background: var(--primary);
  transform: scale(0); transition: transform .12s; }
.copilotz-radio > input:checked { border-color: var(--primary); }
.copilotz-radio > input:checked::before { transform: scale(1); }
.copilotz-radio > input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.copilotz-radio:has(> input:disabled) { cursor: default; }
.copilotz-radio > input:disabled { opacity: .7; }
@media (forced-colors: active) { .copilotz-radio > input::before { background: CanvasText; } }
`,
);

export function Radio(
  { label, className, ...rest }:
    & { label?: ReactNode; className?: string }
    & Omit<ComponentProps<"input">, "type">,
): ReactNode {
  return (
    <>
      {SHEET}
      <label className={cx("copilotz-radio", className)}>
        <input {...rest} type="radio" />
        {label ? <span>{label}</span> : null}
      </label>
    </>
  );
}
