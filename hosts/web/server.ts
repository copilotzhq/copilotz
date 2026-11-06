/**
 * The web host's server half: the page, as a plain plugin (`webPage`). Its
 * routes read the app's `page` resource and its `theme`:
 *
 * ```ts
 * plugins: [...features, webPage, definePlugin({ name: "settings", resources: {
 *   page: { title: "Mobizap", lang: "pt-BR", code: () => bundle("./web.tsx"), assets: brandAssets },
 *   theme: themeOf([brand]),
 * } })]
 * ```
 *
 * - `GET /app/<file>`: the browser's code (the web host, its shell, the front
 *   ends), as bundled with code splitting: the entry, which the page loads
 *   and browsers ask again for, and the chunks its dynamic imports load
 *   (math, a terminal) when first needed, each named by its content, so
 *   browsers keep them for a year.
 * - `GET /assets/…`: the app's own files (`assets`: a brand's fonts and their
 *   stylesheet, images), by exact path, with their types and caching; anything
 *   else there is a 404 (see `assets.ts`). Under `/assets/copilotz/`, the host's
 *   own: the default theme's fonts, its PNG icon, and the page's SVG icon,
 *   drawn from the theme's mark (`theme/files/`).
 * - `GET /manifest.webmanifest` and `GET /sw.js`: the app, installable: its
 *   manifest (name, colours, icons drawn from the theme's mark) and its
 *   service worker, which keeps the code at hand and offers new versions
 *   (see `pwa.ts`).
 * - Any other GET a browser navigates to (`/*`, matched last of all routes):
 *   the page, which loads the entry. It carries the theme (its variables and
 *   the page's base), so the first paint is in it, dark included, before the
 *   code loads; the host takes over. Its head also has the theme's icon (the
 *   mark, and its PNG), the browser's colour around the page (`theme-color`:
 *   each scheme's `background`), and its fonts, fetched at once but not
 *   waited for: the colours paint first, and the host applies the fonts'
 *   stylesheet as it starts. Anything else there is a 404.
 *
 * Where the app is under its host (`page.base`, an org's `/o/<org>`), the page
 * says to its code (`appBase()`), and its `/connect` and socket follow it.
 * The code is bundled once, on its first request (`code` may be a function):
 * remote executors never hold it.
 */
import { definePlugin, type Plugin, type Resources } from "../../runtime/mod.ts";
import { type Asset, assetServer } from "./assets.ts";
import { MANIFEST, manifestOf, precacheOf, versionOf, WORKER, workerOf } from "./pwa.ts";
import { BASE } from "./style.ts";
import { fontsOf, fromGoogle, plainColour, preloadsOf, themeCss } from "./theme/css.ts";
import type { Theme } from "./theme/default.ts";
import { HOST_ASSETS, hostFiles } from "./theme/files/mod.ts";
import { ownPath } from "./theme/own-path.ts";
import { pictureOf } from "./theme/picture.ts";

export type { Asset };
export { type SnapshotOptions, type Widgets, widgetsOf, type WidgetsOptions } from "./widgets.ts";

/**
 * Bundled code: its files by name (`deno bundle --code-splitting --outdir`'s),
 * the entry and the chunks it imports by relative path, and which one the
 * page loads.
 */
export type Code = { entry: string; files: Record<string, string | Uint8Array> };

/** The page, as the app's `page` resource says it. */
export type PageSettings = {
  /** The browser's code, bundled (or a function that bundles it, once): the app's front ends. */
  code: Code | (() => Code | Promise<Code>);
  title?: string;
  /** The page's language (`pt-BR`), for browsers, readers and translators: English unless said. */
  lang?: string;
  /**
   * The app's own files, by the path each is served at, under `/assets/`
   * (`{ "/assets/fonts/brand.css": bytes }`): content, or a function that
   * reads it, once. Fonts, stylesheets, SVG and PNG; see `assets.ts`. Not
   * under `/assets/copilotz/`, which is the host's own.
   */
  assets?: Record<string, Asset>;
  /**
   * Where the app is under its host, when it isn't the root (an org's
   * `/o/<org>`): the runtime answers there too, and the page tells its code
   * (`appBase()`), so its `/connect`, its socket and the addresses it shows work.
   */
  base?: string;
};

/** Where the code is served. */
const CODE = "/app/";

/** What the page answers in JSON (a 404) is never kept. */
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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
const look = (theme: Theme | undefined) => {
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
const quoted = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");

/** The app as an installed one: its manifest, and its name and bar on phones' home screens. */
const installable = (title: string) =>
  [
    `<link rel="manifest" href="${MANIFEST}">`,
    `<meta name="application-name" content="${title}">`,
    `<meta name="apple-mobile-web-app-title" content="${title}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    "",
  ].join("\n");

/**
 * The page: on phones, an app's. It spans the whole screen (`viewport-fit=cover`:
 * the shell keeps its content clear of the notch and the home bar with the
 * safe-area insets), and the keyboard resizes it rather than covering it
 * (`interactive-widget`, where browsers take it). Zoom stays: nothing caps
 * the scale, so people can still pinch to read.
 */
const html = (page: PageSettings, theme: Theme | undefined, entry: string) => {
  const title = quoted(page.title ?? "Copilotz");
  return `<!doctype html>
<html lang="${quoted(page.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
${look(theme)}${installable(title)}<title>${title}</title>
<script id="copilotz-config" type="application/json">${
    // Escaped, so nothing in it can end the script.
    JSON.stringify(page.base ? { base: page.base } : {}).replaceAll("<", "\\u003c")}</script>
</head>
<body>
<div id="app"></div>
<script type="module" src="${CODE}${entry}"></script>
</body>
</html>`;
};

/**
 * Whether a GET is a browser navigating (`Sec-Fetch-Mode: navigate`), or,
 * from one that doesn't say, one asking for a page (`Accept` with HTML, or
 * anything, or none): the page is for them; a script's `fetch` gets a 404.
 */
const navigating = (request: Request) => {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  const accept = request.headers.get("accept");
  return accept === null || accept.includes("text/html") || accept.includes("*/*");
};

/** What a runtime's page serves, made once from its resources. */
type Served = {
  page: PageSettings;
  theme: Theme | undefined;
  code(): Promise<Code>;
  assets(request: Request): Promise<Response> | undefined;
  worker(): Promise<string>;
};

/** Each runtime's page, by its resources (one registry each). */
const made = new WeakMap<Resources, Served>();

/** The page's settings, checked: what's wrong, if anything. */
function pageProblem(resources: Resources): string | undefined {
  const page = resources.page as Partial<PageSettings> | undefined;
  if (!page || page.code === undefined) return "webPage serves the page's code: set page.code";
  if (typeof page.code !== "function" && (typeof page.code !== "object" || !page.code.files)) {
    return "page.code is bundled code ({ entry, files }), or a function that bundles it";
  }
  const taken = Object.keys(page.assets ?? {}).find((path) => path.startsWith(HOST_ASSETS));
  if (taken) return `page.assets: "${taken}" is under ${HOST_ASSETS}, the web host's own`;
  try {
    // Each asset's path and type, checked now: a bad one stops the start.
    assetServer(page.assets);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

function servedOf(resources: Resources): Served {
  let served = made.get(resources);
  if (served) return served;
  const page = resources.page as unknown as PageSettings;
  const theme = resources.theme as Theme | undefined;
  const assets = assetServer({ ...hostFiles(theme), ...page.assets });
  let bundled: Promise<Code> | undefined;
  /** The code, bundled once; its files' names are plain, so they go in the page as they are. */
  const code = () =>
    bundled ??= Promise.resolve(typeof page.code === "function" ? page.code() : page.code)
      .then((made) => {
        const bad = [made.entry, ...Object.keys(made.files)].find((name) =>
          !/^[\w.-]+\.js$/.test(name)
        );
        if (bad || !(made.entry in made.files)) {
          throw new Error(`webPage: code has no entry "${made.entry}", or a file "${bad}"`);
        }
        return made;
      });
  /** The service worker, for this version of the code: its version is the code's own. */
  let worker: Promise<string> | undefined;
  const serviceWorker = () =>
    worker ??= code().then(async (made) =>
      workerOf({
        version: await versionOf(made.files),
        code: CODE,
        entry: made.entry,
        precache: [`${CODE}${made.entry}`, ...precacheOf(theme)],
        ...(theme ? { theme } : {}),
        ...(page.title ? { title: page.title } : {}),
      })
    );
  served = { page, theme, code, assets, worker: serviceWorker };
  made.set(resources, served);
  return served;
}

/** The page's own resources, as the runtime describes them. */
const of = (runtime: { describe(): { resources: Resources } }) =>
  servedOf(runtime.describe().resources);

/** The page: the app's code, its files, its manifest and worker, and the page itself. */
export const webPage: Plugin = definePlugin({
  name: "web-page",
  check(merged) {
    const problem = pageProblem(merged.resources);
    if (problem) throw new Error(problem);
  },
  routes: {
    "/app/*": async (request, { runtime }) => {
      if (request.method !== "GET") return json({ error: "Not found" }, 404);
      const { entry, files } = await of(runtime).code();
      const name = new URL(request.url).pathname.slice(CODE.length);
      if (!Object.hasOwn(files, name)) return json({ error: "Not found" }, 404);
      return new Response(files[name] as BodyInit, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": name === entry ? "no-cache" : "public, max-age=31536000, immutable",
        },
      });
    },
    // `/assets` itself too: nothing there is ever the page.
    "/assets{/*}?": async (request, { runtime }) =>
      await of(runtime).assets(request) ?? json({ error: "Not found" }, 404),
    [MANIFEST]: (request, { runtime }) => {
      if (request.method !== "GET") return json({ error: "Not found" }, 404);
      const { theme, page } = of(runtime);
      return new Response(JSON.stringify(manifestOf(theme, page.title)), {
        headers: {
          "content-type": "application/manifest+json; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    },
    [WORKER]: async (request, { runtime }) => {
      if (request.method !== "GET") return json({ error: "Not found" }, 404);
      return new Response(await of(runtime).worker(), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
          "service-worker-allowed": "/",
        },
      });
    },
    "/*": async (request, { runtime }) => {
      if (request.method !== "GET" || !navigating(request)) {
        return json({ error: "Not found" }, 404);
      }
      const served = of(runtime);
      return new Response(html(served.page, served.theme, (await served.code()).entry), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
});
