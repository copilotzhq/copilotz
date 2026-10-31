/**
 * A text field: `sm`, `md` or `lg`, with an `icon` before what's typed and
 * anything `end` after it (buttons that act on it), in one box that shows
 * focus as a whole. `invalid` (or `aria-invalid`) marks it. Every other
 * prop is the `<input>`'s; `className` is the box's.
 *
 * ```tsx
 * <Input icon="search" type="search" placeholder="Search memories" value={q} onChange={…} />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "input",
  `
.copilotz-input { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px;
  border: 1px solid var(--input); border-radius: var(--radius-lg); background: var(--card);
  color: var(--muted-foreground); cursor: text; transition: border-color .15s, box-shadow .15s; }
.copilotz-input:focus-within { border-color: var(--ring);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent); }
.copilotz-input[data-invalid] { border-color: var(--destructive); }
.copilotz-input[data-invalid]:focus-within {
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--destructive) 14%, transparent); }
.copilotz-input[data-disabled] { opacity: .55; cursor: default; }
.copilotz-input > input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; outline: 0;
  background: transparent; color: var(--foreground); font-size: 14.5px; }
.copilotz-input > input::placeholder { color: var(--muted-foreground); opacity: .85; }
.copilotz-input-sm { height: 36px; padding: 0 3px 0 10px; border-radius: var(--radius-md); }
.copilotz-input-sm > input { font-size: 14px; }
.copilotz-input-lg { height: 44px; padding: 0 14px; }
.copilotz-input-lg > input { font-size: 15px; }
.copilotz-input-end { display: flex; align-items: center; gap: 2px; }
/* Touch screens: fields a finger finds (their text is 16px at least: the page's base) */
@media (pointer: coarse) {
  .copilotz-input { height: 44px; }
  .copilotz-input-sm { height: 40px; }
  .copilotz-input-lg { height: 48px; }
}
`,
);

export function Input(
  { icon, end, size = "md", invalid, className, ...rest }:
    & {
      icon?: IconName;
      end?: ReactNode;
      size?: "sm" | "md" | "lg";
      invalid?: boolean;
      className?: string;
    }
    & Omit<ComponentProps<"input">, "size">,
): ReactNode {
  const bad = invalid ?? (rest["aria-invalid"] === true || rest["aria-invalid"] === "true");
  return (
    <>
      {SHEET}
      <span
        className={cx("copilotz-input", size !== "md" && `copilotz-input-${size}`, className)}
        data-invalid={bad || undefined}
        data-disabled={rest.disabled || undefined}
        onMouseDown={(event) => {
          // A press on the box, not on what's in it, types into it.
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          event.currentTarget.querySelector("input")?.focus();
        }}
      >
        {icon ? <Icon name={icon} size={size === "sm" ? 15 : 16} /> : null}
        <input {...rest} aria-invalid={bad || undefined} />
        {end ? <span className="copilotz-input-end">{end}</span> : null}
      </span>
    </>
  );
}
