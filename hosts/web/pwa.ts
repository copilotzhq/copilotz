/**
 * The app, installable: its web app manifest, from the theme (its name, its
 * colours, its icons, drawn from its mark), and its service worker, which
 * keeps the app's code and look at hand without ever standing between the
 * person and what's live:
 *
 * - **The code** (`/app/<chunk>.js`, named by its content) and the host's
 *   own files (`/assets/copilotz/`: fonts, icons) come from the worker's
 *   cache once fetched, and the entry (`/app/<entry>`), the page and
 *   everything else from the network, so a reload always runs the latest;
 *   the cache answers only when the network can't (offline), and a page it
 *   can't reach says so, in the theme's colours, and retries when back.
 * - **Never in the way:** it handles only GET requests to the app's own
 *   origin for pages, `/app/` and `/assets/`; the socket, sign-in, files,
 *   orgs and plugins' routes go straight to the network.
 * - **A new version:** the worker carries the code's version, so a deploy
 *   changes it; the browser finds it (on load, and when the page asks), and
 *   the page offers "A new version is ready" (`install.ts`), which moves to
 *   it and reloads. Nothing is forced on an open page.
 */
import type { Theme } from "./theme/default.ts";
import { fontsOf, plainColour, preloadsOf } from "./theme/css.ts";
import { HOST_ASSETS } from "./theme/files/mod.ts";
import { ownPath } from "./theme/own-path.ts";
import { pictureOf } from "./theme/picture.ts";

/** Where the manifest and the worker are served: the worker at the root, so its scope is the app. */
export const MANIFEST = "/manifest.webmanifest";
export const WORKER = "/sw.js";

/** The icons drawn from the theme's mark, by size, and the maskable one. */
export const ICONS = {
  small: `${HOST_ASSETS}icon-192.png`,
  large: `${HOST_ASSETS}icon-512.png`,
  maskable: `${HOST_ASSETS}icon-maskable.png`,
};

/** The code's version: the start of a hash of its files, so any change makes a new one. */
export async function versionOf(files: Record<string, string | Uint8Array>): Promise<string> {
  const encoder = new TextEncoder();
  const parts = Object.keys(files).sort().flatMap((name) => {
    const content = files[name];
    return [
      encoder.encode(`${name}\n`),
      typeof content === "string" ? encoder.encode(content) : content,
    ];
  });
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The host's own files every page shows (its fonts, its icon), kept with the code. */
export function precacheOf(theme: Theme | undefined): string[] {
  if (!theme) return [];
  const mark = pictureOf(theme.logo?.mark);
  const own = (href: string | undefined) => href?.startsWith(HOST_ASSETS) ? [href] : [];
  return [
    ...own(fontsOf(theme)),
    ...preloadsOf(theme).flatMap(({ href }) => own(href)),
    ...(mark && typeof mark !== "string" ? [`${HOST_ASSETS}icon.svg`, ICONS.small] : []),
  ];
}

/** The app's web app manifest: its name, colours and icons, from the theme. */
export function manifestOf(theme: Theme | undefined, title = "Copilotz") {
  const mark = theme ? pictureOf(theme.logo?.mark) : undefined;
  const png = theme ? ownPath(theme.logo?.icon) : undefined;
  const background = plainColour(theme?.light?.background) ?? "#ffffff";
  const icons = mark && typeof mark !== "string"
    ? [
      { src: ICONS.small, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: ICONS.large, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: ICONS.maskable, sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: `${HOST_ASSETS}icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
    ]
    : [
      ...(typeof mark === "string" ? [{ src: mark, sizes: "any", purpose: "any" }] : []),
      ...(png ? [{ src: png, sizes: "180x180", type: "image/png", purpose: "any" }] : []),
    ];
  return {
    name: title,
    short_name: title.length > 12 ? title.split(/\s+/)[0].slice(0, 12) : title,
    description: `${title}: your agents, with you and your team.`,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: background,
    theme_color: background,
    icons,
  };
}

/** A small page for when the network can't be reached, in the theme's colours. */
function offlinePage(theme: Theme | undefined, title: string) {
  const light = {
    bg: plainColour(theme?.light?.background) ?? "#ffffff",
    fg: plainColour(theme?.light?.foreground) ?? "#111827",
    muted: plainColour(theme?.light?.["muted-foreground"]) ?? "#6b7280",
    button: plainColour(theme?.light?.primary) ?? "#111827",
    on: plainColour(theme?.light?.["primary-foreground"]) ?? "#ffffff",
  };
  const dark = {
    bg: plainColour(theme?.dark?.background),
    fg: plainColour(theme?.dark?.foreground),
    muted: plainColour(theme?.dark?.["muted-foreground"]),
    button: plainColour(theme?.dark?.primary),
    on: plainColour(theme?.dark?.["primary-foreground"]),
  };
  const safe = (text: string) => text.replace(/[<>&"]/g, "");
  const night = dark.bg && dark.fg
    ? `@media (prefers-color-scheme: dark){body{background:${dark.bg};color:${dark.fg}}p{color:${
      dark.muted ?? dark.fg
    }}button{background:${dark.button ?? dark.fg};color:${dark.on ?? dark.bg}}}`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` +
    `<title>${safe(title)}: offline</title><style>` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;` +
    `background:${light.bg};color:${light.fg}}main{max-width:360px;padding:24px;text-align:center}` +
    `h1{margin:0 0 6px;font-size:22px;letter-spacing:-.02em}p{margin:0 0 20px;color:${light.muted}}` +
    `button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;cursor:pointer;` +
    `background:${light.button};color:${light.on}}${night}</style></head><body><main>` +
    `<h1>You're offline</h1><p>${
      safe(title)
    } will be back as soon as the connection is. Nothing you did is lost.</p>` +
    `<button onclick="location.reload()">Try again</button></main>` +
    `<script>addEventListener("online",()=>location.reload())</script></body></html>`;
}

/**
 * The service worker's script, for this version of the code: what it keeps
 * (`precache`: the entry, its chunks and the host's files the page always
 * loads), the code's directory, and the offline page.
 */
export function workerOf(
  { version, code, entry, precache, theme, title = "Copilotz" }: {
    version: string;
    /** Where the code is served (`/app/`). */
    code: string;
    entry: string;
    precache: string[];
    theme?: Theme;
    title?: string;
  },
): string {
  const config = JSON.stringify({
    version,
    code,
    entry: `${code}${entry}`,
    precache,
    assets: HOST_ASSETS,
    offline: offlinePage(theme, title),
  }).replaceAll("<", "\\u003c");
  return `// The app's service worker (version ${
    version.replace(/[^\w.-]/g, "")
  }): see hosts/web/pwa.ts.
const CONFIG = ${config};
const CACHE = "copilotz-" + CONFIG.version;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CONFIG.precache)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("copilotz-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// The page moves to a new version when the person says so.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "copilotz:update") self.skipWaiting();
});

/** From the network, kept for when it can't be reached; the cache answers then. */
async function fresh(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const kept = await caches.match(request);
    if (kept) return kept;
    throw error;
  }
}

/** From the cache when it's there (named by its content, it never changes), else the network. */
async function kept(request) {
  const found = await caches.match(request);
  if (found) return found;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Pages are always the network's (sessions, orgs, sign-in decide them); offline, a word.
    event.respondWith(fetch(request).catch(() =>
      new Response(CONFIG.offline, { headers: { "content-type": "text/html; charset=utf-8" } })
    ));
    return;
  }
  if (url.pathname === CONFIG.entry) return event.respondWith(fresh(request));
  if (url.pathname.startsWith(CONFIG.code) && !url.search) return event.respondWith(kept(request));
  if (url.pathname.startsWith(CONFIG.assets) && !url.search) {
    return event.respondWith(fresh(request));
  }
});
`;
}
