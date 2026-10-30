/**
 * The web host's server half: what a browser loads, how a person signs in,
 * and how a signed-in browser connects. It reaches the runtime by name only:
 * the identity plugin's `credential.actor` query and `session.start`/`end`
 * Actions, and Google sign-in's `google.sign-in`.
 *
 * - `GET /app/<file>`: the browser's code (the web host, its shell, the front
 *   ends), as bundled with code splitting: the entry, which the page loads
 *   and browsers ask again for, and the chunks its dynamic imports load
 *   (math, a terminal) when first needed, each named by its content, so
 *   browsers keep them for a year.
 * - `POST /signin/google` `{ idToken }`, or `POST /signin/dev` `{ name }` (loopback
 *   only, when `dev`): a session, set as an httpOnly cookie. By name, an
 *   email is a person too, with that email (to receive invitations).
 * - `POST /connect`: the cookie's person, traded for a one-time ticket.
 * - `POST /signout`: ends the session.
 * - The socket (`/oxian`): Oxian's worker protocol, which the app hands over. The
 *   runtime takes browsers there once it declares it: `transports: [socket]`.
 * - `GET /assets/…`: the app's own files (`assets`: a brand's fonts and their
 *   stylesheet, images), by exact path, with their types and caching; anything
 *   else there is a 404 (see `assets.ts`). Under `/assets/copilotz/`, the host's
 *   own, with no configuration: the default theme's fonts, its PNG icon, and
 *   the page's SVG icon, drawn from the theme's mark (`theme/files/`).
 * - `GET /files/<id>`: a file someone sent, as the signed-in person reaches it
 *   (chat's `file.content`), with ranges for audio; `?download=1` saves it
 *   (see `files.ts`).
 * - Plugins' own paths, their `routes` resource: a webhook, an OAuth callback,
 *   an API, a download (see `routes.ts`).
 * - `GET /manifest.webmanifest` and `GET /sw.js`: the app, installable: its
 *   manifest (name, colours, icons drawn from the theme's mark) and its
 *   service worker, which keeps the code at hand and offers new versions
 *   (see `pwa.ts`).
 * - Anything else: the page, which loads the entry. Given the app's `theme`, the
 *   page carries it (its variables and the page's base), so the first paint
 *   is in it, dark included, before the code loads; the host takes over. Its
 *   head also has the theme's icon (the mark, and its PNG), the browser's
 *   colour around the page (`theme-color`: each scheme's `background`), and
 *   its fonts, fetched at once but not waited for: the colours paint first,
 *   and the host applies the fonts' stylesheet as it starts.
 *
 * It answers `Request`s with `Response`s and nothing else (no files, no
 * sockets of its own), so it runs on Deno, Node, Bun or a worker alike.
 */
import type { Actor, Runtime } from "../../runtime/mod.ts";
import { type Asset, assetServer } from "./assets.ts";
import { fileServer } from "./files.ts";
import { MANIFEST, manifestOf, precacheOf, versionOf, WORKER, workerOf } from "./pwa.ts";
import { BASE } from "./style.ts";
import { fontsOf, fromGoogle, plainColour, preloadsOf, themeCss } from "./theme/css.ts";
import type { Theme } from "./theme/default.ts";
import { HOST_ASSETS, hostFiles } from "./theme/files/mod.ts";
import { routeServer } from "./routes.ts";
import { ownPath } from "./theme/own-path.ts";
import { pictureOf } from "./theme/picture.ts";
import type { Tickets } from "./tickets.ts";

export type WebServerOptions = {
  runtime: Runtime;
  tickets: Tickets;
  /** The browser's code, bundled (or a function that bundles it, once). */
  code: Code | (() => Code | Promise<Code>);
  /** Oxian's WebSocket upgrade, for `/oxian` (its Deno adapter's `handler(runtime.hypervisor)`). */
  upgrade(request: Request): Response | Promise<Response>;
  title?: string;
  /** Google sign-in: your OAuth client's id (the google resource's, again for the page). */
  google?: { clientId: string };
  /** Sign in by name, from this machine only: for trying things out. */
  dev?: boolean;
  /**
   * The session cookie's name ("session" by default): one per org, when a
   * host serves many (`hosts/orgs`).
   */
  cookie?: string;
  /**
   * Whether people sign in and out here (true by default). A host serving
   * many orgs signs people in once, at its directory, and says false.
   */
  signIn?: boolean;
  /**
   * Where this app is under its host, when it isn't the root: a host serving
   * many orgs serves each also under `/o/<org>` (`hosts/orgs`), for what
   * reaches it without a browser's session (a key, a webhook, a computer).
   * The page tells its code (`appBase()`), so the addresses it shows work.
   */
  base?: string;
  /**
   * Where the page's socket connects, when it isn't the runtime's own
   * `/oxian`: a host serving many orgs gives each org its address there
   * (`/o/<org>/oxian`), so the socket finds it without cookies, which Safari
   * doesn't send with a socket.
   */
  socket?: string;
  /**
   * The app's theme, as its front ends give it (`themeOf(plugins)`, of those
   * with a `theme` resource): the page carries it for its first paint.
   */
  theme?: Theme;
  /**
   * The app's own files, by the path each is served at, under `/assets/`
   * (`{ "/assets/fonts/brand.css": bytes }`): content, or a function that
   * reads it, once. Fonts, stylesheets, SVG and PNG; see `assets.ts`. Not
   * under `/assets/copilotz/`, which is the host's own.
   */
  assets?: Record<string, Asset>;
};

export type { Asset };
export {
  type HttpAnswer,
  type HttpRequest,
  httpRequest,
  type Route,
  type Served,
  VISITOR,
} from "./routes.ts";

/**
 * Bundled code: its files by name (`deno bundle --code-splitting --outdir`'s),
 * the entry and the chunks it imports by relative path, and which one the
 * page loads.
 */
export type Code = { entry: string; files: Record<string, string | Uint8Array> };

/** Where the code is served. */
const CODE = "/app/";

const COOKIE = "session";

/** Where browsers connect: the runtime's transport for them, which `upgrade` serves. */
export const socket = { type: "websocket", config: { path: "/oxian" } } as const;

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

/** A cookie a request carries, by name. */
export const cookieOf = (request: Request, name: string = COOKIE): string | undefined =>
  request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const loopback = (url: URL): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/** A session, as an httpOnly cookie: Secure unless this is the machine itself, over http. */
export const setCookie = (
  url: URL,
  value: string,
  maxAge: number,
  name: string = COOKIE,
): string =>
  `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${
    url.protocol === "https:" || !loopback(url) ? "; Secure" : ""
  }`;

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
const installable = (options: WebServerOptions) => {
  const title = quoted(options.title ?? "Copilotz");
  return [
    `<link rel="manifest" href="${MANIFEST}">`,
    `<meta name="application-name" content="${title}">`,
    `<meta name="apple-mobile-web-app-title" content="${title}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    "",
  ].join("\n");
};

const page = (options: WebServerOptions, entry: string) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${look(options.theme)}${installable(options)}<title>${options.title ?? "Copilotz"}</title>
<script id="copilotz-config" type="application/json">${
    // Escaped, so nothing in it can end the script.
    JSON.stringify({
      google: options.google ?? null,
      dev: options.dev ?? false,
      ...(options.base ? { base: options.base } : {}),
      ...(options.socket ? { socket: options.socket } : {}),
    })
      .replaceAll("<", "\\u003c")}</script>
</head>
<body>
<div id="app"></div>
<script type="module" src="${CODE}${entry}"></script>
</body>
</html>`;

export function webServer(options: WebServerOptions): (request: Request) => Promise<Response> {
  const { runtime, tickets } = options;
  const name = options.cookie ?? COOKIE;
  const signIn = options.signIn ?? true;
  const taken = Object.keys(options.assets ?? {}).find((path) => path.startsWith(HOST_ASSETS));
  if (taken) {
    throw new Error(
      `webServer: can't serve "${taken}": ${HOST_ASSETS} is the web host's own; use another path`,
    );
  }
  const assets = assetServer({ ...hostFiles(options.theme), ...options.assets });
  let bundled: Promise<Code> | undefined;
  /** The code, bundled once; its files' names are plain, so they go in the page as they are. */
  const code = () =>
    bundled ??= Promise.resolve(typeof options.code === "function" ? options.code() : options.code)
      .then((made) => {
        const bad = [made.entry, ...Object.keys(made.files)].find((name) =>
          !/^[\w.-]+\.js$/.test(name)
        );
        if (bad || !(made.entry in made.files)) {
          throw new Error(`webServer: code has no entry "${made.entry}", or a file "${bad}"`);
        }
        return made;
      });

  /** Who the session cookie says is signed in, if anyone. */
  const whom = async (request: Request): Promise<Actor | null> => {
    const secret = cookieOf(request, name);
    return secret ? await runtime.query<Actor | null>("credential.actor", { secret }) : null;
  };
  const files = fileServer(runtime, whom);
  const routes = routeServer(runtime, whom);

  /** The service worker, for this version of the code: its version is the code's own. */
  let worker: Promise<string> | undefined;
  const serviceWorker = () =>
    worker ??= code().then(async (made) =>
      workerOf({
        version: await versionOf(made.files),
        code: CODE,
        entry: made.entry,
        precache: [`${CODE}${made.entry}`, ...precacheOf(options.theme)],
        ...(options.theme ? { theme: options.theme } : {}),
        ...(options.title ? { title: options.title } : {}),
      })
    );

  const signedIn = (url: URL, session: string, person: string) =>
    json({ person }, {
      headers: { "set-cookie": setCookie(url, session, 30 * 86_400, name) },
    });

  return async (request) => {
    const asset = assets(request) ?? files(request) ?? routes(request);
    if (asset) return await asset;
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (request.method === "GET" && url.pathname.startsWith(CODE)) {
        const { entry, files } = await code();
        const name = url.pathname.slice(CODE.length);
        if (!Object.hasOwn(files, name)) return json({ error: "Not found" }, { status: 404 });
        return new Response(files[name] as BodyInit, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": name === entry ? "no-cache" : "public, max-age=31536000, immutable",
          },
        });
      }
      switch (route) {
        case `GET ${MANIFEST}`:
          return new Response(JSON.stringify(manifestOf(options.theme, options.title)), {
            headers: {
              "content-type": "application/manifest+json; charset=utf-8",
              "cache-control": "no-cache",
            },
          });
        case `GET ${WORKER}`:
          return new Response(await serviceWorker(), {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              "service-worker-allowed": "/",
            },
          });
        case "POST /connect": {
          const actor = await whom(request);
          if (!actor) return json({ error: "Not signed in" }, { status: 401 });
          return json({ ticket: tickets.issue(actor), person: actor.id });
        }
        case "POST /signin/google": {
          if (!options.google || !signIn) break;
          const { idToken } = await request.json() as { idToken: string };
          const { session, person } = await runtime.call<{ session: string; person: string }>(
            "google.sign-in",
            { idToken },
          );
          return signedIn(url, session, person);
        }
        case "POST /signin/dev": {
          if (!options.dev || !signIn || !loopback(url)) break;
          const { name } = await request.json() as { name: string };
          const person = String(name ?? "").trim().toLowerCase();
          const email = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,64}$/.test(person);
          if (!email && !/^[a-z0-9._-]{1,40}$/.test(person)) {
            return json({ error: "A name (letters, digits, . _ -) or an email" }, { status: 400 });
          }
          if (email) await runtime.call("person.set", { person, email: person });
          const { session } = await runtime.call<{ session: string }>("session.start", { person });
          return signedIn(url, session, person);
        }
        case "POST /signout": {
          if (!signIn) break;
          const secret = cookieOf(request, name);
          if (secret) {
            const actor = await runtime.query<{ kind: string; id: string } | null>(
              "credential.actor",
              { secret },
            );
            if (actor) {
              await runtime.call("session.end", { session: secret }, { actor }).catch(() => {});
            }
          }
          return json({}, { headers: { "set-cookie": setCookie(url, "", 0, name) } });
        }
      }
      if (url.pathname === socket.config.path) return await options.upgrade(request);
      if (request.method === "GET" && !url.pathname.startsWith("/signin")) {
        return new Response(page(options, (await code()).entry), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, {
        status: 400,
      });
    }
  };
}
