/**
 * A picture of the brand, one of its logo's forms, as data: a drawing, which
 * the page draws inline (so a part filled `currentColor` takes the text's
 * colour where it sits, and colours may be the theme's variables), or an
 * image file on the app's own origin (`/assets/brand/logo.png`).
 *
 * ```ts
 * { viewBox: "0 0 32 32", paths: [{ d: "M4 4h24v24H4z", fill: "currentColor" }] }
 * ```
 *
 * Only path data, colours and a plain path reach the page: `pictureOf`
 * keeps a picture whose every part is one of them, and drops anything else.
 * A colour is a word (`currentColor`, `teal`), a hex, or a colour function
 * (`rgb()`, `oklch()`, `light-dark()`, `color-mix()`, `var()`…) over plain
 * values: never `url()`, so drawing a logo fetches nothing.
 */
import { ownPath } from "./own-path.ts";

/** Paths in a box, each filled with a colour: the text's (`currentColor`) unless given. */
export type Drawing = { viewBox: string; paths: { d: string; fill?: string }[] };

/** A drawing, or the path of an image file. */
export type Picture = Drawing | string;

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const VIEWBOX = new RegExp(`^${NUMBER}(?:[\\s,]+${NUMBER}){3}$`);
/** SVG's path data: its commands and numbers, nothing else. */
const PATH = /^[MmZzLlHhVvCcSsQqTtAa\d\s,.eE+-]{1,40000}$/;
/** What a colour is written with, functions included. */
const COLOUR = /^[\w\s#.,%/()+-]{1,200}$/;
/** The functions a colour may use. */
const FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
  "var",
]);

/** Whether a value is a colour a drawing may fill with. */
function isColour(value: unknown): value is string {
  return typeof value === "string" && COLOUR.test(value) &&
    [...value.matchAll(/([\w-]+)\s*\(/g)].every(([, name]) => FUNCTIONS.has(name.toLowerCase()));
}

const kept = new WeakMap<object, Drawing | undefined>();

/** A drawing whose every part is safe, as it was given; otherwise undefined. */
function drawingOf(value: object): Drawing | undefined {
  if (kept.has(value)) return kept.get(value);
  const { viewBox, paths } = value as Partial<Drawing>;
  const drawing = typeof viewBox === "string" && VIEWBOX.test(viewBox.trim()) &&
      Array.isArray(paths) && paths.length > 0 && paths.length <= 200 &&
      paths.every((p) =>
        typeof p === "object" && p !== null && typeof p.d === "string" && PATH.test(p.d) &&
        (p.fill === undefined || isColour(p.fill))
      )
    ? { viewBox: viewBox.trim(), paths: paths.map(({ d, fill }) => ({ d, fill })) }
    : undefined;
  kept.set(value, drawing);
  return drawing;
}

/** A picture fit to show: a drawing of safe parts, or a plain path on the app's own origin. */
export function pictureOf(value: unknown): Picture | undefined {
  if (typeof value === "string") return ownPath(value);
  return typeof value === "object" && value !== null ? drawingOf(value) : undefined;
}

/** A drawing's width for its height, from its box. */
export const aspect = (drawing: Drawing): number => {
  const [, , width, height] = drawing.viewBox.split(/[\s,]+/).map(Number);
  return width > 0 && height > 0 ? width / height : 1;
};
