import { barcodeBars, type BarcodeOptions } from "./code128.ts";
import { stripePng } from "./png.ts";

/** Makes barcode PNG bytes for an email, a label or an image response, with quiet margins by default. */
export async function barcodePng(
  value: string,
  options: BarcodeOptions & { width?: number; height?: number } = {},
): Promise<Uint8Array> {
  const drawn = barcodeBars(value, options.width, { quiet: true, ...options });
  return await stripePng(drawn.width, options.height ?? 50, drawn.bars);
}
