/**
 * A theme as the page's CSS variables: its tokens for a light screen, those
 * for a dark one under `prefers-color-scheme: dark`, the radii that scale
 * from `radius`, and the fonts. `themeOf` is the app's theme: the defaults,
 * with the front ends' `theme` resources merged over them in order, as every
 * resource merges, except that `font` and `logo` are each given whole. A
 * theme without `dark` is light only.
 */
import { definePlugin, type Plugins } from "../../../runtime/mod.ts";
import { merge } from "../../../runtime/registry.ts";
import { DEFAULT_THEME, SYSTEM_MONO, SYSTEM_SANS, type Theme } from "./default.ts";
import { ownPath } from "./own-path.ts";

/** The defaults, as the first `theme` resource: the app's patch them as any later plugin's would. */
const defaults = definePlugin({
  name: "web-theme",
  resources: { theme: DEFAULT_THEME as Record<string, unknown> },
});

/** The toolkit's radii, from the theme's one. */
const RADII = {
  "radius-xs": "calc(var(--radius) * .5)",
  "radius-sm": "calc(var(--radius) * 2 / 3)",
  "radius-md": "calc(var(--radius) * 5 / 6)",
  "radius-lg": "var(--radius)",
  "radius-xl": "calc(var(--radius) * 7 / 6)",
  "radius-2xl": "calc(var(--radius) * 1.5)",
  "radius-3xl": "calc(var(--radius) * 2)",
  "radius-full": "9999px",
};

const NAME = /^[a-z][a-z0-9-]*$/;
/** A value can't end its declaration or the stylesheet. */
const SAFE = /^[^;{}<>\\]{1,400}$/;

/** Google Fonts' stylesheets, where a theme's fonts may load from (or the app's own `/assets/`). */
export const GOOGLE_FONTS = "https://fonts.googleapis.com/";

/** What's given whole: a theme's fonts go with the stylesheet that loads them, a logo's forms together. */
const WHOLE = ["font", "logo"] as const;

/**
 * The app's theme: the defaults, with the plugins' `theme` resources merged
 * over them in order. Tokens patch one by one (`null` takes one out); `font`
 * and `logo` are each the last one given, whole (`null`: none).
 */
export function themeOf(plugins: Plugins): Theme {
  const theme = merge([defaults, ...plugins], { elsewhere: true }).resources.theme as Theme;
  const given = [defaults, ...(plugins as unknown[]).flat(Infinity) as typeof defaults[]]
    .map((plugin) => plugin.resources?.theme as Record<string, unknown> | undefined);
  for (const piece of WHOLE) {
    const last = given.findLast((t) => t !== null && typeof t === "object" && piece in t);
    if (last?.[piece] === null || last?.[piece] === undefined) delete theme[piece];
    else Object.assign(theme, { [piece]: last[piece] });
  }
  return theme;
}

/**
 * A theme's font stylesheet, when it names one where fonts may load from:
 * Google Fonts (`https://fonts.googleapis.com/…`), or a path on the app's own
 * origin (`/assets/fonts/brand.css`, served by `webServer({ assets })`; see
 * `ownPath`). Nothing in it can end the attribute it goes in.
 */
export function fontsOf(theme: Theme): string | undefined {
  const url = theme.font?.url;
  if (typeof url !== "string" || /[\s"'<>\\]/.test(url)) return undefined;
  return url.startsWith(GOOGLE_FONTS) ? url : ownPath(url);
}

/** Whether a font stylesheet is Google's: its fonts come from fonts.gstatic.com, worth a preconnect. */
export const fromGoogle = (url: string): boolean => url.startsWith(GOOGLE_FONTS);

/** The font files a theme preloads: plain paths on the app's own origin, to font files only. */
export function preloadsOf(theme: Theme): { href: string; type: string }[] {
  const files = Array.isArray(theme.font?.preload) ? theme.font.preload : [];
  return files.flatMap((file) => {
    const href = ownPath(file);
    const format = href?.match(/\.(woff2|woff|ttf|otf)(?:[?#]|$)/)?.[1];
    return href && format ? [{ href, type: `font/${format}` }] : [];
  });
}

/** A colour as a browser's own parts take it (a hex, a word, a colour function of numbers): no variables. */
export function plainColour(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const colour = value.trim();
  return /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([\d\s.,%/+-]*(?:deg|turn|rad)?[\d\s.,%/+-]*\))$/i
      .test(colour)
    ? colour
    : undefined;
}

/** The declarations for some tokens, skipping (and saying so) any that can't be one. */
function declarations(tokens: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(tokens ?? {}).flatMap(([key, value]) => {
    const name = key.replace(/^--/, "");
    if (value === null || value === undefined) return [];
    if (!NAME.test(name) || typeof value !== "string" || !SAFE.test(value.trim())) {
      console.warn(`theme: skipping "${key}": not a token name and CSS value`);
      return [];
    }
    return [`  --${name}: ${value.trim()};`];
  });
}

export function themeCss(theme: Theme): string {
  const dark = declarations(theme.dark);
  const root = declarations({
    radius: theme.radius,
    ...RADII,
    "font-sans": theme.font?.sans ?? SYSTEM_SANS,
    "font-display": theme.font?.display ?? "var(--font-sans)",
    "font-mono": theme.font?.mono ?? SYSTEM_MONO,
    ...theme.light,
  });
  return [
    `:root {\n  color-scheme: ${dark.length ? "light dark" : "light"};\n${root.join("\n")}\n}`,
    ...(dark.length
      ? [`@media (prefers-color-scheme: dark) {\n:root {\n${dark.join("\n")}\n}\n}`]
      : []),
  ].join("\n");
}
