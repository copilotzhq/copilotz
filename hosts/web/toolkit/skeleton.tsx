/**
 * Where something will be once it's read: a softly shimmering block of its
 * `height` (and `width`), rounded as `radius` says. Hidden from screen
 * readers; say `aria-busy` on what it stands in.
 *
 * ```tsx
 * <ul aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} as="li" height={46} />)}</ul>
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "skeleton",
  `
.copilotz-skeleton { display: block; border-radius: var(--radius-md);
  background: linear-gradient(90deg, var(--muted), var(--accent), var(--muted)); background-size: 200% 100%;
  animation: copilotz-shimmer 1.4s infinite linear; }
@keyframes copilotz-shimmer { to { background-position: -200% 0; } }
`,
);

export function Skeleton(
  { as = "div", height = 16, width, radius = "md", className }: {
    as?: "div" | "li" | "span";
    height?: number | string;
    width?: number | string;
    radius?: "sm" | "md" | "lg" | "xl" | "full";
    className?: string;
  },
): ReactNode {
  const Tag = as;
  return (
    <>
      {SHEET}
      <Tag
        className={cx("copilotz-skeleton", className)}
        style={{ height, width, borderRadius: `var(--radius-${radius})` }}
        aria-hidden="true"
      />
    </>
  );
}
