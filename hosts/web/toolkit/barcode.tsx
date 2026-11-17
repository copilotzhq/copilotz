/**
 * A Code 128 barcode (see `code128.ts`): what a receipt, a label or a shelf
 * tag prints for a scanner, as an SVG of whole-pixel bars at most `width`
 * pixels wide and `height` tall, named by its `value` for screen readers,
 * with the value under it when `caption` is on. It keeps the blank margin
 * scanners need at each end (`quiet`, on by default), and its bars are
 * dark on light whatever the screen's scheme, since that's what scanners
 * read: a theme changes either with its tokens (`barcode-color`,
 * `barcode-background`).
 *
 * ```tsx
 * <Barcode value="POS 12" width={300} height={50} caption />
 * ```
 */
import type { ReactNode } from "react";
import { bars } from "./code128.ts";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "barcode",
  `
.copilotz-barcode { display: inline-flex; flex-direction: column; align-items: center;
  gap: var(--barcode-caption-gap, 2px); padding: var(--barcode-padding, 0);
  background: var(--barcode-background, #fff); color: var(--barcode-color, #000);
  border-radius: var(--barcode-radius, 0); }
.copilotz-barcode > svg { display: block; max-width: 100%; height: auto; }
.copilotz-barcode-caption { font-family: var(--barcode-font, var(--font-mono));
  font-size: var(--barcode-font-size, 12px); letter-spacing: var(--barcode-letter-spacing, .08em);
  line-height: 1.2; }
`,
);

export function Barcode(
  { value, width = 300, height = 50, caption = false, quiet = true, set, className }: {
    value: string;
    /** The most it may take, in pixels: its modules are whole pixels, as wide as fit. */
    width?: number;
    /** Its bars' height, in pixels. */
    height?: number;
    /** Prints the value under the bars. */
    caption?: boolean;
    /** The blank margin scanners need at each end (ten modules). */
    quiet?: boolean;
    /** Code set B only, as some systems print (digits aren't packed). */
    set?: "auto" | "B";
    className?: string;
  },
): ReactNode {
  const drawn = bars(value, width, { quiet, ...(set ? { set } : {}) });
  // One path of rectangles, not a node per bar.
  const d = drawn.bars.map(({ x, w }) => `M${x} 0h${w}v${height}h-${w}z`).join("");
  return (
    <span className={cx("copilotz-barcode", className)}>
      {SHEET}
      <svg
        width={drawn.width}
        height={height}
        viewBox={`0 0 ${drawn.width} ${height}`}
        role="img"
        aria-label={value}
        shapeRendering="crispEdges"
      >
        <path d={d} fill="currentColor" />
      </svg>
      {caption
        ? <span className="copilotz-barcode-caption" aria-hidden="true">{value}</span>
        : null}
    </span>
  );
}
