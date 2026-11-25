import { type BarcodeOptions, bars } from "./code128.ts";
import { stripePng } from "./png.ts";

/** Makes barcode PNG bytes for an email, a label or an image response, with quiet margins by default. */
export async function barcodePng(
  value: string,
  options: BarcodeOptions & { width?: number; height?: number } = {},
): Promise<Uint8Array> {
  const drawn = bars(value, options.width, { quiet: true, ...options });
  const row = new Uint8Array(drawn.width).fill(255);
  for (const { x, w } of drawn.bars) row.fill(0, x, x + w);
  return await stripePng(row, options.height ?? 50);
}
