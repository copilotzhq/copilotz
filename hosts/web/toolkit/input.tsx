/**
 * A text field: `sm`, `md` or `lg`, with an `icon` before what's typed (by
 * name, or an element of the app's own) and anything `end` after it
 * (buttons that act on it), in one box that shows focus as a whole.
 * `invalid` (or `aria-invalid`) marks it. Every other prop is the
 * `<input>`'s; `className` is the box's, or the group's when it has addons.
 *
 * Addons sit outside the box and joined to it, as a form's input groups:
 * `addon` before it, `addonEnd` after it. Words or a glyph ("$", "%", an
 * `<Icon>`) sit on a tinted face; a control (a button, a switch) is the
 * addon itself.
 *
 * Its look is the theme's: `input-height`, `input-padding`, `input-radius`,
 * `input-border-width`, `input-background`, `input-focus-shadow` and the
 * rest (each size its own: `input-height-sm`…), and `input-addon-*` for the
 * addons. Select and Textarea follow the same tokens unless their own are
 * set.
 *
 * ```tsx
 * <Input icon="search" type="search" placeholder="Search memories" value={q} onChange={…} />
 * <Input addon="$" inputMode="decimal" value={price} onChange={…} />
 * <Input addonEnd={<Switch checked={fixed} onChange={setFixed} on="$" off="%" />} … />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const RADIUS = "var(--input-radius, var(--radius-lg))";
const RADIUS_SM = "var(--input-radius-sm, var(--radius-md))";

const SHEET = sheet(
  "input",
  `
.copilotz-input { display: flex; align-items: center; gap: var(--input-gap, 8px);
  height: var(--input-height, 40px); padding: var(--input-padding, 0 12px);
  border: var(--input-border-width, 1px) solid var(--input); border-radius: ${RADIUS};
  background: var(--input-background, var(--card));
  color: var(--muted-foreground); cursor: text; transition: border-color .15s, box-shadow .15s; }
.copilotz-input:focus-within { border-color: var(--ring);
  box-shadow: var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent)); }
.copilotz-input[data-invalid] { border-color: var(--destructive); }
.copilotz-input[data-invalid]:focus-within { box-shadow: var(--input-invalid-focus-shadow,
  0 0 0 4px color-mix(in oklab, var(--destructive) 14%, transparent)); }
.copilotz-input[data-disabled] { opacity: var(--input-disabled-opacity, .55); cursor: default; }
.copilotz-input:is([data-disabled], :has(> input[readonly])) {
  background: var(--input-disabled-background, var(--input-background, var(--card))); }
.copilotz-input > input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; outline: 0;
  background: transparent; color: var(--foreground); font-size: var(--input-font-size, 14.5px); }
.copilotz-input > input::placeholder { color: var(--input-placeholder, var(--muted-foreground));
  opacity: var(--input-placeholder-opacity, .85); }
.copilotz-input-sm { height: var(--input-height-sm, 36px); padding: var(--input-padding-sm, 0 3px 0 10px);
  border-radius: ${RADIUS_SM}; }
.copilotz-input-sm > input { font-size: var(--input-font-size-sm, 14px); }
.copilotz-input-lg { height: var(--input-height-lg, 44px); padding: var(--input-padding-lg, 0 14px);
  border-radius: var(--input-radius-lg, ${RADIUS}); }
.copilotz-input-lg > input { font-size: var(--input-font-size-lg, 15px); }
.copilotz-input-end { display: flex; align-items: center; gap: 2px; }
/* Touch screens: fields a finger finds (their text is 16px at least: the page's base) */
@media (pointer: coarse) {
  .copilotz-input { height: max(44px, var(--input-height, 40px)); }
  .copilotz-input-sm { height: max(40px, var(--input-height-sm, 36px)); }
  .copilotz-input-lg { height: max(48px, var(--input-height-lg, 44px)); }
}
/* Addons: outside the box, joined to it. */
.copilotz-input-group { display: flex; align-items: stretch; min-width: 0; }
.copilotz-input-group > .copilotz-input { flex: 1; min-width: 0; }
.copilotz-input-group > .copilotz-input:not(:first-child) {
  border-start-start-radius: 0; border-end-start-radius: 0; }
.copilotz-input-group > .copilotz-input:not(:last-child) {
  border-start-end-radius: 0; border-end-end-radius: 0; }
.copilotz-input-addon { display: flex; align-items: center; justify-content: center; flex: none;
  min-width: var(--input-addon-min-width, 36px); padding: var(--input-addon-padding, 0 10px);
  border: var(--input-addon-border-width, var(--input-border-width, 1px)) solid var(--input);
  background: var(--input-addon-background, var(--muted));
  color: var(--input-addon-foreground, var(--muted-foreground));
  font-size: var(--input-addon-font-size, 14px); line-height: 1; white-space: nowrap; }
.copilotz-input-addon:first-child { border-inline-end: 0;
  border-start-start-radius: ${RADIUS}; border-end-start-radius: ${RADIUS}; }
.copilotz-input-addon:last-child { border-inline-start: 0;
  border-start-end-radius: ${RADIUS}; border-end-end-radius: ${RADIUS}; }
.copilotz-input-group-sm > .copilotz-input-addon:first-child {
  border-start-start-radius: ${RADIUS_SM}; border-end-start-radius: ${RADIUS_SM}; }
.copilotz-input-group-sm > .copilotz-input-addon:last-child {
  border-start-end-radius: ${RADIUS_SM}; border-end-end-radius: ${RADIUS_SM}; }
.copilotz-input-group-lg > .copilotz-input-addon:first-child {
  border-start-start-radius: var(--input-radius-lg, ${RADIUS});
  border-end-start-radius: var(--input-radius-lg, ${RADIUS}); }
.copilotz-input-group-lg > .copilotz-input-addon:last-child {
  border-start-end-radius: var(--input-radius-lg, ${RADIUS});
  border-end-end-radius: var(--input-radius-lg, ${RADIUS}); }
/* A control in an addon is the addon: no face of its own, its outer corners the group's. */
.copilotz-input-addon:has(> :is(button, a, [role=switch])) { min-width: 0; padding: 0; border: 0;
  background: none; overflow: hidden; }
.copilotz-input-addon > :is(button, a, [role=switch]) { align-self: stretch; height: auto; min-height: 0;
  border-radius: 0; }
`,
);

export function Input(
  { icon, end, addon, addonEnd, size = "md", invalid, className, ...rest }:
    & {
      icon?: IconLike;
      end?: ReactNode;
      /** Before the box, joined to it: words, a glyph or a control. */
      addon?: ReactNode;
      /** After the box, joined to it. */
      addonEnd?: ReactNode;
      size?: "sm" | "md" | "lg";
      invalid?: boolean;
      className?: string;
    }
    & Omit<ComponentProps<"input">, "size">,
): ReactNode {
  const bad = invalid ?? (rest["aria-invalid"] === true || rest["aria-invalid"] === "true");
  const grouped = addon !== undefined || addonEnd !== undefined;
  const box = (
    <span
      className={cx(
        "copilotz-input",
        size !== "md" && `copilotz-input-${size}`,
        !grouped && className,
      )}
      data-invalid={bad || undefined}
      data-disabled={rest.disabled || undefined}
      onMouseDown={(event) => {
        // A press on the box, not on what's in it, types into it.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.currentTarget.querySelector("input")?.focus();
      }}
    >
      {iconOf(icon, size === "sm" ? 15 : 16)}
      <input {...rest} aria-invalid={bad || undefined} />
      {end ? <span className="copilotz-input-end">{end}</span> : null}
    </span>
  );
  if (!grouped) {
    return (
      <>
        {SHEET}
        {box}
      </>
    );
  }
  return (
    <>
      {SHEET}
      <span
        className={cx(
          "copilotz-input-group",
          size !== "md" && `copilotz-input-group-${size}`,
          className,
        )}
      >
        {addon !== undefined ? <span className="copilotz-input-addon">{addon}</span> : null}
        {box}
        {addonEnd !== undefined ? <span className="copilotz-input-addon">{addonEnd}</span> : null}
      </span>
    </>
  );
}
