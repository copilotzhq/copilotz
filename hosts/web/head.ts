/**
 * The head of a page the server makes: the app's theme in it (its
 * variables and the page's base, its icons and colour, its fonts), shared by
 * the app's page (`webPage`, server.ts) and a route's own (route-page.ts).
 */
import { BASE } from "./style.ts";
import { fontsOf, fromGoogle, plainColour, preloadsOf, themeCss } from "./theme/css.ts";
import type { Theme } from "./theme/default.ts";
import { HOST_ASSETS } from "./theme/files/mod.ts";
import { ownPath } from "./theme/own-path.ts";
import { pictureOf } from "./theme/picture.ts";

/** The page's icons: the mark (as the host draws it, or the image it is) and the theme's PNG. */
const icons = (theme: Theme) => {
  const mark = pictureOf(theme.logo?.mark);
  const png = ownPath(theme.logo?.icon);
  return [
    ...(png ? [`<link rel="icon" href="${png}" type="image/png" sizes="180x180">`] : []),
    ...(typeof mark === "string"
      ? [`<link rel="icon" href="${mark}">`]
      : mark
      ? [`<link rel="icon" href="${HOST_ASSETS}icon.svg" type="image/svg+xml">`]
      : []),
    ...(png ? [`<link rel="apple-touch-icon" href="${png}">`] : []),
  ];
};

/** The browser's colour around the page: each scheme's background, when it's a plain colour. */
const colours = (theme: Theme, dark: boolean) => {
  const light = plainColour(theme.light?.background);
  const night = dark ? plainColour(theme.dark?.background) : undefined;
  if (!night) return light ? [`<meta name="theme-color" content="${light}">`] : [];
  return [
    ...(light
      ? [`<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">`]
      : []),
    `<meta name="theme-color" content="${night}" media="(prefers-color-scheme: dark)">`,
  ];
};

/**
 * The theme in the page's head: its variables and the page's base (the host
 * replaces them), its icons and colour, and its fonts: the stylesheet and
 * the files it preloads, fetched now (Google's connected to early) and
 * applied by the host, so the first paint never waits on them.
 */
export const look = (theme: Theme | undefined) => {
  if (!theme) return "";
  const fonts = fontsOf(theme);
  const css = `${themeCss(theme)}\n${BASE}`.replaceAll("<", "\\3c ");
  const dark = Object.values(theme.dark ?? {}).some((value) => value !== null);
  return [
    `<meta name="color-scheme" content="${dark ? "light dark" : "light"}">`,
    ...colours(theme, dark),
    ...icons(theme),
    `<style id="copilotz-first-paint">${css}</style>`,
    ...(fonts && fromGoogle(fonts)
      ? ['<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>']
      : []),
    ...(fonts ? [`<link rel="preload" href="${fonts}" as="style">`] : []),
    ...preloadsOf(theme).map(({ href, type }) =>
      `<link rel="preload" href="${href}" as="font" type="${type}" crossorigin>`
    ),
    "",
  ].join("\n");
};

/** Text that can't end the attribute it goes in. */
export const quoted = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
