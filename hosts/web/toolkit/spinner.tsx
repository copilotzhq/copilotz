/**
 * Something's on its way: a ring (`ring`, the default) or three dots that
 * pulse (`dots`, someone thinking or writing), in the text's color.
 * Decorative unless given a `label`.
 */
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "spinner",
  `
.copilotz-spinner { --size: 16px; display: inline-block; width: var(--size); height: var(--size); flex: none;
  border-radius: var(--radius-full); border: 2px solid currentColor; border-right-color: transparent;
  opacity: .8; animation: copilotz-spin .7s linear infinite; }
@keyframes copilotz-spin { to { transform: rotate(360deg); } }
.copilotz-dots { --size: 6px; display: inline-flex; align-items: center; gap: calc(var(--size) * .66); }
.copilotz-dots i { width: var(--size); height: var(--size); border-radius: var(--radius-full);
  background: currentColor; animation: copilotz-dot 1.2s infinite ease-in-out; }
.copilotz-dots i:nth-child(2) { animation-delay: .16s; }
.copilotz-dots i:nth-child(3) { animation-delay: .32s; }
@keyframes copilotz-dot { 0%, 80%, 100% { opacity: .3; transform: none; }
  40% { opacity: 1; transform: translateY(calc(var(--size) * -.5)); } }
`,
);

export function Spinner(
  { variant = "ring", size, label, className }: {
    variant?: "ring" | "dots";
    /** The ring's width, or each dot's (16 and 6 pixels by default). */
    size?: number;
    label?: string;
    className?: string;
  },
): ReactNode {
  const style = size ? { "--size": `${size}px` } as CSSProperties : undefined;
  const a11y = label ? { role: "status", "aria-label": label } : { "aria-hidden": true };
  return (
    <>
      {SHEET}
      {variant === "dots"
        ? (
          <span className={cx("copilotz-dots", className)} style={style} {...a11y}>
            <i />
            <i />
            <i />
          </span>
        )
        : <span className={cx("copilotz-spinner", className)} style={style} {...a11y} />}
    </>
  );
}
