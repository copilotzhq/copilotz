/**
 * The theme's mark as a PNG, for what wants pixels: an installed app's
 * icons (192 and 512 px, and a maskable one that an operating system crops
 * to its own shape). It draws the mark's paths (SVG path data: every
 * command, arcs included) filled in their colours, antialiased, on the
 * theme's background, and encodes the image with the platform's own
 * `CompressionStream`: web standards only, no image library, so it runs
 * wherever the server does. A colour it can't read as plain (a variable, a
 * mix) is the theme's text colour.
 */
import { plainColour } from "./css.ts";
import type { Theme } from "./default.ts";
import { type Drawing, pictureOf } from "./picture.ts";

type Point = [number, number];
type Rgba = [number, number, number, number];

/** A path's outlines, as polygons: each subpath, its curves flattened to short lines. */
export function outlines(d: string, at: (p: Point) => Point, step = 1): Point[][] {
  const shapes: Point[][] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const number = () => {
    skip();
    const found = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!found) throw new Error(`png: no number at ${i} in path data`);
    i += found[0].length;
    return Number(found[0]);
  };
  const flag = () => {
    skip();
    const f = d[i++];
    if (f !== "0" && f !== "1") throw new Error(`png: no arc flag at ${i - 1}`);
    return f === "1";
  };
  const more = () => {
    skip();
    return i < d.length && /[+\-.\d]/.test(d[i]);
  };
  let shape: Point[] = [];
  let here: Point = [0, 0];
  let start: Point = [0, 0];
  let control: Point | undefined;
  let quad: Point | undefined;
  const to = (p: Point) => {
    here = p;
    shape.push(at(p));
  };
  const close = () => {
    if (shape.length > 2) shapes.push(shape);
    shape = [];
  };
  /** How many lines a curve over these points becomes: about one per `step` pixels. */
  const pieces = (points: Point[]) => {
    let length = 0;
    for (let k = 1; k < points.length; k++) {
      const [a, b] = [at(points[k - 1]), at(points[k])];
      length += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return Math.max(2, Math.min(96, Math.ceil(length / step)));
  };
  const cubic = (c1: Point, c2: Point, end: Point) => {
    const p0 = here;
    const n = pieces([p0, c1, c2, end]);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      to([
        u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
      ]);
    }
    control = c2;
  };
  const quadratic = (c: Point, end: Point) => {
    const p0 = here;
    const n = pieces([p0, c, end]);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      to([
        u * u * p0[0] + 2 * u * t * c[0] + t * t * end[0],
        u * u * p0[1] + 2 * u * t * c[1] + t * t * end[1],
      ]);
    }
    quad = c;
  };
  /** An elliptical arc, by its centre (SVG's own conversion, F.6.5). */
  const arc = (
    rx: number,
    ry: number,
    angle: number,
    large: boolean,
    sweep: boolean,
    end: Point,
  ) => {
    const [x1, y1] = here;
    const [x2, y2] = end;
    if (!rx || !ry) return to(end);
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (angle * Math.PI) / 180;
    const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const xp = cos * dx + sin * dy;
    const yp = -sin * dx + cos * dy;
    const grow = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (grow > 1) [rx, ry] = [rx * Math.sqrt(grow), ry * Math.sqrt(grow)];
    const sign = large === sweep ? -1 : 1;
    const top = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const k = sign * Math.sqrt(Math.max(0, top / (rx * rx * yp * yp + ry * ry * xp * xp)));
    const cxp = (k * rx * yp) / ry;
    const cyp = (-k * ry * xp) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const angleOf = (ux: number, uy: number) => Math.atan2(uy, ux);
    const from = angleOf((xp - cxp) / rx, (yp - cyp) / ry);
    let span = angleOf((-xp - cxp) / rx, (-yp - cyp) / ry) - from;
    if (!sweep && span > 0) span -= 2 * Math.PI;
    if (sweep && span < 0) span += 2 * Math.PI;
    const n = Math.max(4, Math.min(128, Math.ceil(pieces([here, end]) * Math.abs(span) / 2)));
    for (let s = 1; s <= n; s++) {
      const t = from + (span * s) / n;
      to([
        cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
        cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
      ]);
    }
  };
  let command = "";
  while (true) {
    skip();
    if (i >= d.length) break;
    if (/[A-Za-z]/.test(d[i])) command = d[i++];
    else if (!command) throw new Error("png: path data starts without a command");
    const rel = command === command.toLowerCase();
    const [ox, oy] = rel ? here : [0, 0];
    const C = command.toUpperCase();
    const smooth = C === "S" || C === "T";
    if (C !== "C" && C !== "S") control = smooth ? control : undefined;
    if (C !== "Q" && C !== "T") quad = smooth ? quad : undefined;
    switch (C) {
      case "M": {
        close();
        const p: Point = [ox + number(), oy + number()];
        to(p);
        start = p;
        // Pairs after a move are lines.
        command = rel ? "l" : "L";
        continue;
      }
      case "L":
        to([ox + number(), oy + number()]);
        break;
      case "H":
        to([(rel ? here[0] : 0) + number(), here[1]]);
        break;
      case "V":
        to([here[0], (rel ? here[1] : 0) + number()]);
        break;
      case "C":
        cubic(
          [ox + number(), oy + number()],
          [ox + number(), oy + number()],
          [ox + number(), oy + number()],
        );
        break;
      case "S": {
        const c1: Point = control ? [2 * here[0] - control[0], 2 * here[1] - control[1]] : here;
        cubic(c1, [ox + number(), oy + number()], [ox + number(), oy + number()]);
        break;
      }
      case "Q":
        quadratic([ox + number(), oy + number()], [ox + number(), oy + number()]);
        break;
      case "T": {
        const c: Point = quad ? [2 * here[0] - quad[0], 2 * here[1] - quad[1]] : here;
        quadratic(c, [ox + number(), oy + number()]);
        break;
      }
      case "A": {
        const [rx, ry, angle] = [number(), number(), number()];
        const [large, sweep] = [flag(), flag()];
        arc(rx, ry, angle, large, sweep, [ox + number(), oy + number()]);
        break;
      }
      case "Z":
        close();
        // What follows without a move starts where this subpath did.
        here = start;
        shape = [at(start)];
        continue;
      default:
        throw new Error(`png: unknown path command ${command}`);
    }
    if (C !== "C" && C !== "S") control = undefined;
    if (C !== "Q" && C !== "T") quad = undefined;
    if (!more() && i < d.length && !/[A-Za-z]/.test(d[i])) break;
  }
  close();
  return shapes;
}

/** How much of each pixel the shapes cover (0 to 1), by the nonzero rule, antialiased. */
export function coverage(shapes: Point[][], width: number, height: number): Float32Array {
  const ROWS = 5;
  const cover = new Float32Array(width * height);
  const edges: { x0: number; y0: number; x1: number; y1: number; dir: number }[] = [];
  for (const shape of shapes) {
    for (let k = 0; k < shape.length; k++) {
      const [x0, y0] = shape[k];
      const [x1, y1] = shape[(k + 1) % shape.length];
      if (y0 !== y1) edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1 });
    }
  }
  const crossings: { x: number; dir: number }[] = [];
  for (let row = 0; row < height; row++) {
    for (let sub = 0; sub < ROWS; sub++) {
      const y = row + (sub + 0.5) / ROWS;
      crossings.length = 0;
      for (const e of edges) {
        const [lo, hi] = e.y0 < e.y1 ? [e.y0, e.y1] : [e.y1, e.y0];
        if (y < lo || y >= hi) continue;
        crossings.push({ x: e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), dir: e.dir });
      }
      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let c = 0; c < crossings.length - 1; c++) {
        winding += crossings[c].dir;
        if (!winding) continue;
        const from = Math.max(0, crossings[c].x);
        const to = Math.min(width, crossings[c + 1].x);
        if (to <= from) continue;
        // Each pixel the span touches gets the part of its width the span covers.
        for (let x = Math.floor(from); x < Math.ceil(to); x++) {
          const part = Math.min(to, x + 1) - Math.max(from, x);
          if (part > 0) cover[row * width + x] += part / ROWS;
        }
      }
    }
  }
  return cover;
}

/** A colour as red, green, blue and alpha (0–255), or none when it isn't plain. */
export function rgbaOf(colour: string | undefined): Rgba | undefined {
  const value = plainColour(colour)?.toLowerCase();
  if (!value) return undefined;
  const hex = /^#([\da-f]{3,8})$/.exec(value)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (k: number) => parseInt(full.slice(k * 2, k * 2 + 2), 16);
    return [n(0), n(1), n(2), full.length === 8 ? n(3) : 255];
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean);
    const channel = (p: string) =>
      p.endsWith("%") ? Math.round(parseFloat(p) * 2.55) : Math.round(parseFloat(p));
    const alpha = parts[3] === undefined ? 255 : Math.round(
      (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) * 255,
    );
    const out = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
    return out.every((n) => Number.isFinite(n))
      ? out.map((n) => Math.max(0, Math.min(255, n))) as Rgba
      : undefined;
  }
  return { white: [255, 255, 255, 255], black: [0, 0, 0, 255] }[value] as Rgba | undefined;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Bytes through the platform's zlib (`deflate`), as PNG's image data is. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA pixels as a PNG file. */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(rows)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Paints `colour` over the pixels by how much `cover` covers each (source over). */
function paint(pixels: Uint8Array, cover: Float32Array, colour: Rgba) {
  for (let p = 0; p < cover.length; p++) {
    const a = Math.min(1, cover[p]) * (colour[3] / 255);
    if (a <= 0) continue;
    const o = p * 4;
    const under = pixels[o + 3] / 255;
    const out = a + under * (1 - a);
    for (let c = 0; c < 3; c++) {
      pixels[o + c] = Math.round((colour[c] * a + pixels[o + c] * under * (1 - a)) / out);
    }
    pixels[o + 3] = Math.round(out * 255);
  }
}

/** A rounded square's outline, `size` wide at `inset`, its corners `radius` round. */
function roundedSquare(inset: number, size: number, radius: number): Point[] {
  const points: Point[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let k = 0; k <= 12; k++) {
      const t = from + (k / 12) * (Math.PI / 2);
      points.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
    }
  };
  const [a, b] = [inset + radius, inset + size - radius];
  corner(b, a, -Math.PI / 2);
  corner(b, b, 0);
  corner(a, b, Math.PI / 2);
  corner(a, a, Math.PI);
  return points;
}

/**
 * The theme's mark as a square PNG icon, `size` pixels: `any`, the mark on
 * a rounded tile of the theme's background, a little in from the edges;
 * `maskable`, the tile edge to edge with the mark in its middle, where any
 * crop keeps it. None when the theme's mark isn't a drawing.
 */
export async function iconPng(
  theme: Theme,
  size: number,
  purpose: "any" | "maskable" = "any",
): Promise<Uint8Array | undefined> {
  const mark = pictureOf(theme.logo?.mark);
  if (!mark || typeof mark === "string") return undefined;
  const drawing = mark as Drawing;
  const ink = rgbaOf(theme.light?.foreground ?? undefined) ?? [17, 24, 39, 255];
  const ground = rgbaOf(theme.light?.background ?? undefined) ?? [255, 255, 255, 255];
  const pixels = new Uint8Array(size * size * 4);
  const tile = purpose === "maskable"
    ? [[0, 0], [size, 0], [size, size], [0, size]] as Point[]
    : roundedSquare(size * 0.0625, size * 0.875, size * 0.875 * 0.225);
  paint(pixels, coverage([tile], size, size), ground);
  const [x, y, w, h] = drawing.viewBox.split(/[\s,]+/).map(Number);
  const room = size * (purpose === "maskable" ? 0.5 : 0.6);
  const scale = room / Math.max(w, h);
  const left = (size - w * scale) / 2 - x * scale;
  const top = (size - h * scale) / 2 - y * scale;
  const at = ([px, py]: Point): Point => [left + px * scale, top + py * scale];
  for (const path of drawing.paths) {
    const fill = !path.fill || path.fill.toLowerCase() === "currentcolor"
      ? ink
      : rgbaOf(path.fill) ?? ink;
    paint(pixels, coverage(outlines(path.d, at, 1.5), size, size), fill);
  }
  return await encodePng(pixels, size, size);
}
