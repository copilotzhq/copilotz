/**
 * The web host's own files, which `webServer` serves under `/assets/copilotz/`
 * with no configuration (that prefix is the host's: an app's assets go
 * elsewhere under `/assets/`): the default theme's typefaces and their
 * stylesheet (Manrope and Space Grotesk, from Google Fonts, under the SIL
 * Open Font License 1.1: `OFL-*.txt`), Temml's font for math in messages
 * (MIT, as Temml is), Copilotz's PNG icon, and the page's SVG icon, drawn
 * from the app's own theme's mark (`icon.ts`), with the installed app's PNG
 * icons drawn from it too (192 and 512 px, and a maskable one: `png.ts`).
 *
 * They're data, not files on disk, so the server reads nothing and runs
 * wherever `Request` does; each is decoded on its first request. Only the
 * server imports this: the browser's code never carries them. Browsers keep
 * a font for a year, so a new version takes a new name (`-v23-`).
 */
import type { Asset } from "../../assets.ts";
import type { Theme } from "../default.ts";
import { iconSvg } from "../icon.ts";
import { iconPng } from "../png.ts";
import { FACES } from "./faces.ts";
import { ICON_PNG } from "./icon-png.ts";
import { MANROPE_LATIN } from "./manrope-v23-latin.ts";
import { MANROPE_LATIN_EXT } from "./manrope-v23-latin-ext.ts";
import { SPACE_GROTESK_LATIN } from "./space-grotesk-v22-latin.ts";
import { SPACE_GROTESK_LATIN_EXT } from "./space-grotesk-v22-latin-ext.ts";
import { TEMML_FONT } from "./temml-v0140.ts";

/** Where the host's own files are: no app's asset may be. */
export const HOST_ASSETS = "/assets/copilotz/";

/** Base64, as bytes, once asked for. */
const decoded = (base64: string) => () => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** The host's files, by the path each is served at; the SVG icon is the theme's mark, if it has one. */
export function hostFiles(theme?: Theme): Record<string, Asset> {
  const icon = theme ? iconSvg(theme) : undefined;
  return {
    [`${HOST_ASSETS}fonts.css`]: FACES,
    [`${HOST_ASSETS}manrope-v23-latin.woff2`]: decoded(MANROPE_LATIN),
    [`${HOST_ASSETS}manrope-v23-latin-ext.woff2`]: decoded(MANROPE_LATIN_EXT),
    [`${HOST_ASSETS}space-grotesk-v22-latin.woff2`]: decoded(SPACE_GROTESK_LATIN),
    [`${HOST_ASSETS}space-grotesk-v22-latin-ext.woff2`]: decoded(SPACE_GROTESK_LATIN_EXT),
    [`${HOST_ASSETS}temml-v0140.woff2`]: decoded(TEMML_FONT),
    [`${HOST_ASSETS}icon.png`]: decoded(ICON_PNG),
    ...(icon
      ? {
        [`${HOST_ASSETS}icon.svg`]: icon,
        // Drawn on their first request, from the same mark.
        [`${HOST_ASSETS}icon-192.png`]: async () => (await iconPng(theme!, 192))!,
        [`${HOST_ASSETS}icon-512.png`]: async () => (await iconPng(theme!, 512))!,
        [`${HOST_ASSETS}icon-maskable.png`]: async () => (await iconPng(theme!, 512, "maskable"))!,
      }
      : {}),
  };
}
