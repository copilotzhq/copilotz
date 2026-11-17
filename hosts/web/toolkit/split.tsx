/**
 * Two columns: what the screen is about, and beside it an `aside` that
 * stays in view (a register's cart, and its summary and payment at the
 * right). The main column takes the room; the aside is `md` wide (340px;
 * `sm` 280px, `lg` 420px, each a token), at the `end` or the `start`, and
 * `sticky` keeps it in view as the main column scrolls. Narrower than the
 * two need (720px), they stack: the aside under what it's beside, or over
 * it (`stacked="aside-first"`). It measures itself, not the window.
 *
 * ```tsx
 * <Split aside={<Card><Summary /></Card>} sticky>
 *   <DataTable … />
 * </Split>
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "split",
  `
.copilotz-split-box { container-type: inline-size; min-width: 0; }
.copilotz-split { display: grid; grid-template-columns: minmax(0, 1fr) var(--copilotz-split-aside);
  grid-template-areas: "main aside"; align-items: start; gap: var(--split-gap, 24px); }
.copilotz-split-start { grid-template-columns: var(--copilotz-split-aside) minmax(0, 1fr);
  grid-template-areas: "aside main"; }
.copilotz-split-sm { --copilotz-split-aside: var(--split-aside-width-sm, 280px); }
.copilotz-split-md { --copilotz-split-aside: var(--split-aside-width, 340px); }
.copilotz-split-lg { --copilotz-split-aside: var(--split-aside-width-lg, 420px); }
.copilotz-split-main { grid-area: main; min-width: 0; }
.copilotz-split-aside { grid-area: aside; min-width: 0; }
.copilotz-split-sticky > .copilotz-split-aside { position: sticky; top: var(--split-sticky-top, 16px); }
@container (max-width: 720px) {
  .copilotz-split, .copilotz-split-start { grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "main" "aside"; }
  .copilotz-split-aside-first { grid-template-areas: "aside" "main"; }
  .copilotz-split-sticky > .copilotz-split-aside { position: static; }
}
`,
);

export function Split(
  { aside, side = "end", width = "md", sticky, stacked = "aside-last", label, className, children }:
    {
      /** What's beside the main column. */
      aside: ReactNode;
      /** Which side it's on. */
      side?: "start" | "end";
      width?: "sm" | "md" | "lg";
      /** It stays in view as the main column scrolls. */
      sticky?: boolean;
      /** Where it goes when the two stack. */
      stacked?: "aside-first" | "aside-last";
      /** What the aside is, said to screen readers ("Summary"). */
      label?: string;
      className?: string;
      children?: ReactNode;
    },
): ReactNode {
  return (
    <div className="copilotz-split-box">
      {SHEET}
      <div
        className={cx(
          "copilotz-split",
          `copilotz-split-${width}`,
          side === "start" && "copilotz-split-start",
          sticky && "copilotz-split-sticky",
          stacked === "aside-first" && "copilotz-split-aside-first",
          className,
        )}
      >
        <div className="copilotz-split-main">{children}</div>
        <aside className="copilotz-split-aside" aria-label={label}>{aside}</aside>
      </div>
    </div>
  );
}
