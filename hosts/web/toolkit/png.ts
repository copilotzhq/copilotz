import { crc32 } from "./zip.ts";

const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** Compresses scanlines into a zlib stream for a PNG or a PDF image. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function chunk(name: string, bytes: Uint8Array) {
  const out = new Uint8Array(12 + bytes.length);
  view(out).setUint32(0, bytes.length);
  out.set(new TextEncoder().encode(name), 4);
  out.set(bytes, 8);
  view(out).setUint32(out.length - 4, crc32(out.subarray(4, -4)));
  return out;
}

function checkRaster(width: number, height: number, stride: number) {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    (stride + 1) * height > 256 * 1024 * 1024
  ) throw new RangeError("Unsupported image dimensions.");
}

/** Makes an opaque 8-bit grayscale PNG by repeating one scanline for a barcode. */
export async function stripePng(
  width: number,
  height: number,
  bars: { x: number; w: number }[],
): Promise<Uint8Array> {
  checkRaster(width, height, width);
  const row = new Uint8Array(width).fill(255);
  for (const { x, w } of bars) row.fill(0, x, x + w);
  const header = new Uint8Array(13);
  view(header).setUint32(0, row.length);
  view(header).setUint32(4, height);
  header[8] = 8;
  const scans = new Uint8Array((row.length + 1) * height);
  for (let y = 0; y < height; y++) scans.set(row, y * (row.length + 1) + 1);
  return join([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", await deflate(scans)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** A parsed PNG keeps its compressed IDATs for PDF's PNG predictor. */
export function readPng(bytes: Uint8Array) {
  if (!signature.every((b, i) => b === bytes[i])) throw new Error("Expected PNG or JPEG bytes.");
  let width = 0, height = 0, bits = 0, kind = 0, channels = 0;
  let interlaced = false;
  let palette: Uint8Array | undefined, transparency: Uint8Array | undefined;
  const parts: Uint8Array[] = [];
  const data = view(bytes);
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = data.getUint32(at);
    const start = at + 8, end = start + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(at + 4, end)) !== data.getUint32(end)) {
      throw new Error("Invalid PNG chunk.");
    }
    const name = String.fromCharCode(...bytes.subarray(at + 4, start));
    const part = bytes.subarray(start, end);
    if (name === "IHDR") {
      if (at !== 8 || length !== 13) throw new Error("Invalid PNG header.");
      width = data.getUint32(start);
      height = data.getUint32(start + 4);
      bits = part[8];
      kind = part[9];
      channels = [1, 0, 3, 1, 2, 0, 4][kind];
      interlaced = part[12] === 1;
      if (
        !channels || part[10] || part[11] || part[12] > 1 ||
        !(bits === 8 || ((kind === 3 || kind === 0) && [1, 2, 4].includes(bits)))
      ) {
        throw new Error("Unsupported PNG encoding. Use an 8-bit PNG.");
      }
      checkRaster(width, height, Math.ceil(width * channels * bits / 8));
    } else if (!width) throw new Error("Missing PNG header.");
    else if (name === "PLTE") palette = part;
    else if (name === "tRNS") transparency = part;
    else if (name === "IDAT") parts.push(part);
    else if (name === "IEND") {
      if (!parts.length) throw new Error("Missing PNG image data.");
      if (
        kind === 3 &&
        (!palette || !palette.length || palette.length % 3 || palette.length > 3 * 2 ** bits)
      ) {
        throw new Error("Invalid PNG palette.");
      }
      if (
        transparency &&
        !(kind === 0 && transparency.length === 2 || kind === 2 && transparency.length === 6 ||
          kind === 3 && transparency.length <= palette!.length / 3)
      ) throw new Error("Invalid PNG transparency.");
      return {
        width,
        height,
        bits,
        kind,
        channels,
        interlaced,
        palette,
        transparency,
        data: join(parts),
      };
    }
    at = end + 4;
  }
  throw new Error("Incomplete PNG.");
}

function paeth(left: number, above: number, corner: number) {
  const p = left + above - corner;
  const a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - corner);
  return a <= b && a <= c ? left : b <= c ? above : corner;
}

/** Undo the row filters of a single pass, in place, retaining each row's leading filter byte. */
function unfilter(scans: Uint8Array, height: number, stride: number, step: number) {
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = scans[start];
    if (filter > 4) throw new Error("Invalid PNG filter.");
    for (let x = 0; x < stride; x++) {
      const i = start + 1 + x;
      const left = x >= step ? scans[i - step] : 0;
      const above = y ? scans[i - stride - 1] : 0;
      const corner = x >= step && y ? scans[i - stride - 1 - step] : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
        ? left
        : filter === 2
        ? above
        : filter === 3
        ? Math.floor((left + above) / 2)
        : paeth(left, above, corner);
      scans[i] += predictor;
    }
  }
}

// Adam7's starting column and row, then the steps to this pass's next column and row.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [
  0,
  1,
  1,
  2,
]];

/** Inflates and reverses PNG's row filters and interlacing. Packed samples stay packed. */
export async function pngPixels(png: ReturnType<typeof readPng>): Promise<Uint8Array> {
  const { width, height, channels, bits, data } = png;
  const pixelBits = channels * bits, step = Math.ceil(pixelBits / 8);
  const stride = Math.ceil(width * pixelBits / 8);
  const passes = (png.interlaced ? ADAM7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const cols = Math.max(0, Math.ceil((width - x) / dx)),
      rows = Math.max(0, Math.ceil((height - y) / dy));
    const packed = Math.ceil(cols * pixelBits / 8);
    return { x, y, dx, dy, cols, rows, packed, size: cols ? (packed + 1) * rows : 0 };
  });
  const scans = new Uint8Array(passes.reduce((n, p) => n + p.size, 0));
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  let at = 0;
  for await (const part of stream) {
    if (at + part.length > scans.length) throw new Error("Extra PNG scanlines.");
    scans.set(part, at);
    at += part.length;
  }
  if (at !== scans.length) throw new Error("Incomplete PNG scanlines.");
  const out = new Uint8Array(stride * height);
  let offset = 0;
  for (const pass of passes) {
    if (!pass.size) continue;
    const filtered = scans.subarray(offset, offset + pass.size);
    unfilter(filtered, pass.rows, pass.packed, step);
    offset += pass.size;
    for (let r = 0; r < pass.rows; r++) {
      const start = r * (pass.packed + 1) + 1;
      const line = filtered.subarray(start, start + pass.packed);
      const dest = (pass.y + r * pass.dy) * stride;
      if (pass.dx === 1) {
        out.set(line, dest);
        continue;
      }
      for (let c = 0; c < pass.cols; c++) {
        const col = pass.x + c * pass.dx;
        if (pixelBits >= 8) {
          for (let b = 0; b < step; b++) out[dest + col * step + b] = line[c * step + b];
        } else {
          const sample = line[Math.floor(c * bits / 8)] >> (8 - bits - c * bits % 8) &
            ((1 << bits) - 1);
          out[dest + Math.floor(col * bits / 8)] |= sample << (8 - bits - col * bits % 8);
        }
      }
    }
  }
  return out;
}
