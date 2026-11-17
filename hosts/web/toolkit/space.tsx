/**
 * The toolkit's spacing scale, for the space between things: `xs` (4px),
 * `sm` (8px), `md` (12px), `lg` (16px), `xl` (24px), `2xl` (32px), each a
 * token a theme may change (`space-md`), and `none`. Layout pieces take it
 * as their `gap` (`Stack`, `Grid`, `Toolbar`), so a screen spaces itself
 * without CSS.
 */
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

/** A step of the spacing scale. */
export type Space = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/** The gaps, as classes: one per step. */
export const GAPS = sheet(
  "space",
  `
.copilotz-gap-none { gap: 0; }
.copilotz-gap-xs { gap: var(--space-xs, 4px); }
.copilotz-gap-sm { gap: var(--space-sm, 8px); }
.copilotz-gap-md { gap: var(--space-md, 12px); }
.copilotz-gap-lg { gap: var(--space-lg, 16px); }
.copilotz-gap-xl { gap: var(--space-xl, 24px); }
.copilotz-gap-2xl { gap: var(--space-2xl, 32px); }
`,
);

/** The class that sets a gap of `space`. */
export const gapClass = (space: Space): string => cx(`copilotz-gap-${space}`);
