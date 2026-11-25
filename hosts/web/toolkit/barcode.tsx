/**
 * A product or order barcode (see `code128.ts`): what a receipt, a label or a shelf
 * tag prints for a scanner, as an SVG of whole-pixel bars with a preferred `width`
 * and a fixed `height`, named by its `value` for screen readers,
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
import { type BarcodeOptions, bars } from "./code128.ts";
import { eanDigits } from "./retail-barcodes.ts";
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

/** Draws a scannable SVG with an optional human-readable caption. */
export function Barcode(
  { value, width, height = 50, caption = false, quiet = true, set, format, check, className }:
    & BarcodeOptions
    & {
      value: string;
      /** Preferred width in pixels. Each module takes at least one pixel. */
      width?: number;
      /** Its bars' height, in pixels. */
      height?: number;
      /** Prints the value under the bars. */
      caption?: boolean;
      className?: string;
    },
): ReactNode {
  const label = format === "ean13"
    ? eanDigits(value, 13)
    : format === "ean8"
    ? eanDigits(value, 8)
    : value;
  const drawn = bars(label, width, { quiet, set, format, check });
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
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <path d={d} fill="currentColor" />
      </svg>
      {caption
        ? <span className="copilotz-barcode-caption" aria-hidden="true">{label}</span>
        : null}
    </span>
  );
}
