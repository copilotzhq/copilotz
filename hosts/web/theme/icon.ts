/**
 * The page's icon, from the theme's logo: its mark, drawn as an SVG file of
 * its own (centred in a square), with what's filled `currentColor` in the
 * theme's text colour, dark on a light tab and light on a dark one. Only a
 * drawing's own colours work there (no variables: the file has no page's).
 * A mark that's an image file is the icon as it is.
 */
import { plainColour } from "./css.ts";
import type { Theme } from "./default.ts";
import { pictureOf } from "./picture.ts";

/** Text that can't end the attribute it goes in. */
const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** The mark as an SVG file, or undefined when it's a file already (or there's none). */
export function iconSvg(theme: Theme): string | undefined {
  const mark = pictureOf(theme.logo?.mark);
  if (!mark || typeof mark === "string") return undefined;
  const [x, y, width, height] = mark.viewBox.split(/[\s,]+/).map(Number);
  const side = Math.max(width, height);
  const box = [x - (side - width) / 2, y - (side - height) / 2, side, side].join(" ");
  const ink = plainColour(theme.light?.foreground) ?? "#000";
  const night = plainColour(theme.dark?.foreground);
  const style = `svg{color:${ink}}` +
    (night ? `@media (prefers-color-scheme:dark){svg{color:${night}}}` : "");
  const paths = mark.paths.map(({ d, fill }) =>
    `<path d="${attribute(d)}" fill="${attribute(fill ?? "currentColor")}"/>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><style>${style}</style>${
    paths.join("")
  }</svg>`;
}
