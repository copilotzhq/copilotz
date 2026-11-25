import { deflate, pngPixels, readPng } from "./png.ts";

/** A PNG or JPEG prepared by pdfImage. Reuse it wherever a document draws the same logo. */
export type PdfImage = {
  width: number;
  height: number;
  bits: number;
  colors: 1 | 3 | 4;
  filter: "FlateDecode" | "DCTDecode";
  data: Uint8Array;
  palette?: Uint8Array;
  predictor?: boolean;
  inverted?: boolean;
  alpha?: Uint8Array;
};

function jpeg(data: Uint8Array): PdfImage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let adobe = false;
  let frame: PdfImage | undefined;
  for (let at = 2; at + 4 <= data.length && data[at] === 255;) {
    while (data[at] === 255) at++;
    const marker = data[at++];
    if (marker === 0xd9 || at + 2 > data.length) break;
    const length = view.getUint16(at);
    if (length < 2 || at + length > data.length) break;
    if (marker === 0xda) {
      const scan = at + length;
      const components = data[at + 2];
      // Entropy data begins with a byte or a byte-stuffed FF 00, never a marker.
      if (
        frame && components >= 1 && components <= frame.colors && length === 6 + 2 * components &&
        scan < data.length && (data[scan] !== 0xff || data[scan + 1] === 0)
      ) return { ...frame, inverted: adobe && frame.colors === 4 };
      break;
    }
    if (marker === 0xee && String.fromCharCode(...data.subarray(at + 2, at + 7)) === "Adobe") {
      adobe = true;
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      const bits = data[at + 2],
        height = view.getUint16(at + 3),
        width = view.getUint16(at + 5),
        colors = data[at + 7];
      if (
        !width || !height || bits !== 8 || (colors !== 1 && colors !== 3 && colors !== 4) ||
        length !== 8 + 3 * colors
      ) break;
      frame = {
        width,
        height,
        bits,
        colors,
        filter: "DCTDecode",
        data,
      };
    }
    at += length;
  }
  if (frame) throw new Error("JPEG is missing valid scan data.");
  throw new Error("Invalid or unsupported JPEG frame.");
}

/** Reads PNG or JPEG bytes (or a base64 image data URL) once, before laying out a table or document. */
export async function pdfImage(source: Uint8Array | string): Promise<PdfImage> {
  let bytes: Uint8Array;
  if (typeof source === "string") {
    const match = /^data:image\/(?:jpeg|png);base64,([\s\S]+)$/i.exec(source);
    if (!match) throw new Error("Expected a PNG or JPEG data URL.");
    bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
  } else bytes = source;
  if (bytes[0] === 255 && bytes[1] === 216) return jpeg(bytes);
  const png = readPng(bytes);
  const { width, height, bits, kind, channels, transparency } = png;
  const hasAlpha = kind === 4 || kind === 6;
  const colors = kind === 2 || kind === 6 ? 3 : 1;
  const image: PdfImage = {
    width,
    height,
    bits,
    colors,
    filter: "FlateDecode",
    data: png.data,
    palette: kind === 3 ? png.palette : undefined,
    predictor: true,
  };
  if (!png.interlaced && !hasAlpha && !transparency) return image;
  if (width * height > 256 * 1024 * 1024) {
    throw new RangeError("Unsupported alpha mask dimensions.");
  }
  const pixels = await pngPixels(png);
  if (png.interlaced && !hasAlpha) {
    image.data = await deflate(pixels);
    image.predictor = false;
  }
  if (!hasAlpha && !transparency) return image;
  const alpha = new Uint8Array(width * height);
  if (hasAlpha) {
    const samples = new Uint8Array(alpha.length * colors);
    for (let p = 0; p < alpha.length; p++) {
      const src = p * channels;
      for (let c = 0; c < colors; c++) samples[p * colors + c] = pixels[src + c];
      alpha[p] = pixels[src + colors];
    }
    image.data = await deflate(samples);
    image.predictor = false;
  } else {
    const stride = Math.ceil(width * channels * bits / 8);
    const key = transparency!;
    const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (let p = 0; p < alpha.length; p++) {
      if (kind === 2) {
        const same = [0, 1, 2].every((c) => pixels[p * 3 + c] === keyView.getUint16(c * 2));
        alpha[p] = same ? 0 : 255;
      } else {
        const bit = (p % width) * bits;
        const byte = pixels[Math.floor(p / width) * stride + Math.floor(bit / 8)];
        const sample = (byte >> (8 - bits - bit % 8)) & (2 ** bits - 1);
        alpha[p] = kind === 3 ? key[sample] ?? 255 : sample === keyView.getUint16(0) ? 0 : 255;
      }
    }
  }
  image.alpha = await deflate(alpha);
  return image;
}
