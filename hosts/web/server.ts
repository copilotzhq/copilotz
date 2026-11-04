/**
 * The web host's server half: one host for every app, whose parts are what
 * the app's plugins declare. It reaches the runtime by name only: the
 * resources below, and the queries and Actions they name.
 *
 * | Part | Comes from | Without it |
 * | --- | --- | --- |
 * | Routes: webhooks, APIs, sockets of their own | the `routes` resource | — |
 * | The page and its code | `code` (the app's front ends, its shell among them, bundled) | no page: the routes, and `/health` |
 * | Who a browser is | the `entrances` resource (identity's session; contacts' web lines) | nobody |
 * | Browsers connecting | `tickets`, for whoever an entrance says | no browser connects |
 * | Signing in | the `signIn` resource (Google sign-in, dev sign-in) | none |
 *
 * - `GET /app/<file>`: the browser's code (the web host, its shell, the front
 *   ends), as bundled with code splitting: the entry, which the page loads
 *   and browsers ask again for, and the chunks its dynamic imports load
 *   (math, a terminal) when first needed, each named by its content, so
 *   browsers keep them for a year.
 * - `POST /connect`: who the request is (see entrances.ts), traded for a
 *   one-time ticket: `{ ticket, actor, name? }`. Its cookies say, the first
 *   entrance's that's someone; with none, an entrance may let them in now
 *   (a visitor of a web line, from what the page asks: `{ line }`), setting
 *   its cookie. From the app's own page only (`Origin`); 401 for nobody, 429
 *   (with `retry-after`) past a limit: a web line's, or the tickets anyone
 *   may have in a minute (`createTickets`).
 * - `POST /signin/<name>` (a way the app's plugins declare; `local` ones
 *   from this machine, to this machine only: `fromHere`, by the socket's
 *   address and the host, with no proxy's headers): a session, set as an
 *   httpOnly cookie. `POST /signout`: ends it, ends the browsers connected
 *   as whoever it was, and clears every entrance's cookie. A cookie still
 *   held under its name from before it was the host's alone (`session`, now
 *   `__Host-session`) is ended and cleared on `/connect` and sign-out. What
 *   the host answers in JSON (these, `/connect`) is never cached (`no-store`).
 * - The socket (`/oxian`): Oxian's worker protocol, which the app hands over. The
 *   runtime takes browsers there once it declares it: `transports: [socket]`.
 * - `GET /assets/…`: the app's own files (`assets`: a brand's fonts and their
 *   stylesheet, images), by exact path, with their types and caching; anything
 *   else there is a 404 (see `assets.ts`). Under `/assets/copilotz/`, the host's
 *   own, with the page and no configuration: the default theme's fonts, its PNG
 *   icon, and the page's SVG icon, drawn from the theme's mark (`theme/files/`).
 * - `GET /files/<id>`: a file someone sent, as whoever the request is reaches
 *   it (chat's `file.content`), or by a link signed for it, with ranges for
 *   audio; `?download=1` saves it (see `files.ts`).
 * - Plugins' own paths, their `routes` resource: a webhook, an OAuth callback,
 *   an API, a download, a socket of their own (see `routes.ts`), called as
 *   whoever the request is, else a visitor. A request to a host a route takes
 *   (a preview's) is that route's alone, whatever its path: never the page,
 *   the code or the socket.
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
 *   and the host applies the fonts' stylesheet as it starts. Without a page,
 *   `GET /health` says it's up (unless a route takes it), and anything else
 *   is a 404.
 *
 * Something going wrong answers its code's status (`refusal`: 400, 403, 404,
 * 429, else 500, logged), and its words only when they're for anyone.
 *
 * It answers `Request`s with `Response`s and nothing else (no files, no
 * sockets of its own), so it runs on Deno, Node, Bun or a worker alike. A
 * listener of the app's own says where each request came from
 * (`setClientAddress`), as Copilotz's (`copilotz/web/node`) and Oxian's do.
 */
import type { Runtime } from "../../runtime/mod.ts";
import { clientAddress } from "./address.ts";
import { type Asset, assetServer } from "./assets.ts";
import {
  arriving,
  cookieOf,
  cookieSafe,
  fromHere,
  fromPage,
  jsonOf,
  recognise,
  refusal,
  retireAll,
  setCookie,
  signInPage,
  signInsOf,
  whomOf,
} from "./entrances.ts";
import { fileServer } from "./files.ts";
import { MANIFEST, manifestOf, precacheOf, versionOf, WORKER, workerOf } from "./pwa.ts";
import { BASE } from "./style.ts";
import { fontsOf, fromGoogle, plainColour, preloadsOf, themeCss } from "./theme/css.ts";
import type { Theme } from "./theme/default.ts";
import { HOST_ASSETS, hostFiles } from "./theme/files/mod.ts";
import { type Front, hostOf, routeServer } from "./routes.ts";
import { ownPath } from "./theme/own-path.ts";
import { pictureOf } from "./theme/picture.ts";
import type { Tickets } from "./tickets.ts";
import type { Widgets } from "./widgets.ts";

export type WebServerOptions = {
  runtime: Runtime;
  /**
   * What browsers connect with: one-time tickets, for whoever the app's
   * entrances say a request is (the runtime admits them: `admit:
   * tickets.admit`). Without it, no browser connects here.
   */
  tickets?: Tickets;
  /**
   * The browser's code, bundled (or a function that bundles it, once): the
   * app's front ends, its shell among them. Without it, there's no page: the
   * app's routes, and `/health`.
   */
  code?: Code | (() => Code | Promise<Code>);
  /**
   * Oxian's WebSocket upgrade, for `/oxian` (its Deno adapter's
   * `handler(runtime.hypervisor)`). Without it, no socket here.
   */
  upgrade?(request: Request): Response | Promise<Response>;
  title?: string;
  /** The page's language (`pt-BR`), for browsers, readers and translators: English unless said. */
  lang?: string;
  /**
   * The name each cookie an entrance declares goes by here (its own, unless
   * said), each then this host's alone (`__Host-` wherever it's Secure, as an
   * entrance's `hostOnly` makes it): a host serving many orgs keeps each
   * org's apart, and none that another host under its domain could set
   * (`hosts/orgs`).
   */
  cookie?: (name: string) => string;
  /**
   * Where people sign in, when not here: a host serving many orgs signs
   * them in once, at its directory, and serves that itself. Its orgs' pages
   * show the directory's ways to sign in (`at`), and nothing here signs in
   * or out.
   */
  signIn?: { at: Runtime };
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
  /**
   * The app's front (a Cloudflare worker before it): a request carrying its
   * secret (`x-copilotz-front`) is for the host it forwards
   * (`x-forwarded-host`), which routes by host and the page's origin go by.
   * Without it, or without the secret, forwarded headers are ignored.
   */
  front?: Front;
  /**
   * The app's widgets (`widgetsOf`): its web Views drawn inside an outside assistant (an MCP
   * Apps host such as ChatGPT), which the MCP interface's routes serve and snapshot. Without
   * them, MCP's lines offer tools with no widgets.
   */
  widgets?: Widgets;
};

export type { Asset };
export { type SnapshotOptions, type Widgets, widgetsOf, type WidgetsOptions } from "./widgets.ts";
export { clientAddress, setClientAddress } from "./address.ts";
export {
  type Arrived,
  cookieOf,
  type Door,
  type Entrance,
  hostCookie,
  setCookie,
  type SignIn,
  siteOf,
  type Whom,
  whomOf,
} from "./entrances.ts";
export {
  type Front,
  hostMatches,
  hostOf,
  type HttpAnswer,
  type HttpRequest,
  httpRequest,
  type Route,
  type RouteSocket,
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

/** How long a session a sign-in starts is kept in its cookie: 30 days. */
const SESSION = 30 * 86_400;

/** Where a host without a page says it's up. */
const HEALTH = "/health";

/** Where browsers connect: the runtime's transport for them, which `upgrade` serves. */
export const socket = { type: "websocket", config: { path: "/oxian" } } as const;

/** What the host answers in JSON is someone's (a ticket, a session's cookie): never kept. */
const json = (value: unknown, init: ResponseInit & { cookies?: string[] } = {}) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  for (const cookie of init.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(value), { status: init.status ?? 200, headers });
};

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * An error as the host answers it (see `refusal`), and past a limit, when to
 * try again (`retryAfter`, in seconds, when the error says; else a minute).
 */
const refused = (error: unknown, fallback: string, cookies: string[] = []) => {
  const { status, error: said } = refusal(error, fallback);
  const wait = (error as { retryAfter?: unknown } | null)?.retryAfter;
  return json({ error: said }, {
    status,
    cookies,
    ...(status === 429
      ? { headers: { "retry-after": String(typeof wait === "number" ? wait : 60) } }
      : {}),
  });
};

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

/**
 * The page: on phones, an app's. It spans the whole screen (`viewport-fit=cover`:
 * the shell keeps its content clear of the notch and the home bar with the
 * safe-area insets), and the keyboard resizes it rather than covering it
 * (`interactive-widget`, where browsers take it). Zoom stays: nothing caps
 * the scale, so people can still pinch to read.
 */
const page = (
  options: WebServerOptions,
  entry: string,
  signIn: Record<string, Record<string, unknown>>,
) =>
  `<!doctype html>
<html lang="${quoted(options.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
${look(options.theme)}${installable(options)}<title>${quoted(options.title ?? "Copilotz")}</title>
<script id="copilotz-config" type="application/json">${
    // Escaped, so nothing in it can end the script.
    JSON.stringify({
      signIn,
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
  const { runtime, tickets, front } = options;
  const here = !options.signIn;
  const taken = Object.keys(options.assets ?? {}).find((path) => path.startsWith(HOST_ASSETS));
  if (taken) {
    throw new Error(
      `webServer: can't serve "${taken}": ${HOST_ASSETS} is the web host's own; use another path`,
    );
  }
  const paged = options.code !== undefined;
  const assets = assetServer({ ...(paged ? hostFiles(options.theme) : {}), ...options.assets });
  let bundled: Promise<Code> | undefined;
  /** The code, bundled once; its files' names are plain, so they go in the page as they are. */
  const code = () =>
    bundled ??= Promise.resolve(typeof options.code === "function" ? options.code() : options.code!)
      .then((made) => {
        const bad = [made.entry, ...Object.keys(made.files)].find((name) =>
          !/^[\w.-]+\.js$/.test(name)
        );
        if (bad || !(made.entry in made.files)) {
          throw new Error(`webServer: code has no entry "${made.entry}", or a file "${bad}"`);
        }
        return made;
      });

  // Who a request is, by the app's entrances (checked now: a bad declaration stops the start).
  const whom = whomOf(runtime, {
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(front ? { front } : {}),
  });
  const signIns = here ? signInsOf(runtime, whom.entrances) : new Map();
  /** Whether browsers connect here: someone to be, and tickets to connect with. */
  const connecting = !!tickets && whom.entrances.length > 0;
  /** What the page shows of the ways to sign in: here, or where the host signs people in. */
  let shown: Record<string, Record<string, unknown>> | undefined;
  const signInShown = () => shown ??= signInPage(options.signIn?.at ?? runtime);

  const files = fileServer(runtime, whom);
  const routes = routeServer(runtime, whom, {
    ...(front ? { front } : {}),
    ...(options.widgets ? { widgets: options.widgets } : {}),
  });

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

  const notFound = () =>
    paged ? json({ error: "Not found" }, { status: 404 }) : plain(404, "Not found");
  const elsewhere = () => json({ error: "Not from this app's page" }, { status: 403 });

  /** `POST /connect`: who the request is, or someone let in now, traded for a ticket. */
  const connect = async (request: Request): Promise<Response> => {
    if (!fromPage(request, front)) return elsewhere();
    if (!connecting) return json({ error: "Not signed in" }, { status: 401 });
    const asked = await jsonOf(request);
    if (!asked) return json({ error: "Send a JSON object, of 16 KiB at most" }, { status: 400 });
    let came: Awaited<ReturnType<typeof arriving>>;
    try {
      const address = clientAddress(request);
      came = await arriving(runtime, whom, request, {
        runtime,
        asked,
        host: hostOf(request, front),
        ...(address ? { address } : {}),
      });
    } catch (error) {
      return refused(error, "Couldn't connect");
    }
    // What it held under a cookie's name from before it was the host's alone ends, and goes.
    const cookies = [...came.cookies, ...await retireAll(runtime, whom, request)];
    const { actor } = came;
    if (!actor) return json({ error: "Not signed in" }, { status: 401, cookies });
    let ticket: string;
    try {
      ticket = tickets!.issue(actor);
    } catch (error) {
      return refused(error, "Couldn't connect", cookies);
    }
    // What the page shows them as: a person's name as they signed in, else their email.
    const profile = actor.kind === "person"
      ? await runtime.query<{ name?: string; email?: string } | null>("person.profile", {
        person: actor.id,
      }).catch(() => null)
      : null;
    const name = profile?.name ?? profile?.email;
    return json({
      ticket,
      actor: { kind: actor.kind, id: actor.id },
      ...(name ? { name } : {}),
    }, { cookies });
  };

  /** `POST /signin/<name>`: a way the app declares, its session kept in its entrance's cookie. */
  const signIn = async (request: Request, name: string): Promise<Response> => {
    const method = signIns.get(name);
    if (!method || (method.local && !fromHere(request, front))) return notFound();
    if (!fromPage(request, front)) return elsewhere();
    const asked = await jsonOf(request);
    if (!asked) return json({ error: "Send a JSON object, of 16 KiB at most" }, { status: 400 });
    let answered: { person?: unknown; session?: unknown };
    try {
      answered = await runtime.call(method.action, asked);
    } catch (error) {
      return refused(error, "Couldn't sign in");
    }
    const { person, session } = answered;
    if (typeof person !== "string" || !person || !cookieSafe(session)) {
      throw new Error(`signIn.${name}: ${method.action} answered no person, or no session`);
    }
    const entrance = whom.entrances.find((e) => e.name === method.entrance)!;
    const site = whom.site(request);
    return json({ person }, {
      cookies: [
        setCookie(site, session, SESSION, whom.named(entrance, site), entrance.sameSite),
      ],
    });
  };

  /**
   * `POST /signout`: what each entrance's cookie is ends, the browsers
   * connected as them go (`runtime.disconnect`: one comes back only with a
   * cookie that's still someone), so do tickets handed out to them not yet
   * used (`tickets.end`), and every cookie goes, those under a name
   * from before it was the host's alone too (`retireAll`).
   */
  const signOut = async (request: Request): Promise<Response> => {
    if (!fromPage(request, front)) return elsewhere();
    const site = whom.site(request);
    const cookies: string[] = [];
    for (const entrance of whom.entrances) {
      const name = whom.named(entrance, site);
      const secret = cookieOf(request, name);
      if (secret === undefined) continue;
      const actor = await recognise(runtime, entrance, secret).catch(() => null);
      if (actor && entrance.end) {
        await runtime.call(entrance.end, { secret }, { actor }).catch(() => {});
      }
      if (actor) {
        runtime.disconnect(actor);
        options.tickets?.end?.(actor);
      }
      cookies.push(setCookie(site, "", 0, name, entrance.sameSite));
    }
    cookies.push(...await retireAll(runtime, whom, request));
    return json({}, { cookies });
  };

  return async (request) => {
    // Routes first: a host a route takes is all its own (the host's paths are never routes').
    const routed = routes(request);
    if (routed) return await routed;
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (
      !paged && (request.method === "GET" || request.method === "HEAD") && url.pathname === HEALTH
    ) {
      return plain(200, "ok");
    }
    const served = assets(request) ?? files(request);
    if (served) return await served;
    try {
      if (paged && request.method === "GET" && url.pathname.startsWith(CODE)) {
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
      if (paged && route === `GET ${MANIFEST}`) {
        return new Response(JSON.stringify(manifestOf(options.theme, options.title)), {
          headers: {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "no-cache",
          },
        });
      }
      if (paged && route === `GET ${WORKER}`) {
        return new Response(await serviceWorker(), {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
            "service-worker-allowed": "/",
          },
        });
      }
      if (route === "POST /connect" && (paged || connecting)) return await connect(request);
      if (here && connecting && request.method === "POST") {
        if (url.pathname.startsWith("/signin/")) {
          return await signIn(request, url.pathname.slice("/signin/".length));
        }
        if (url.pathname === "/signout") return await signOut(request);
      }
      if (url.pathname === socket.config.path) {
        return options.upgrade ? await options.upgrade(request) : notFound();
      }
      if (paged && request.method === "GET" && !url.pathname.startsWith("/signin")) {
        return new Response(page(options, (await code()).entry, signInShown()), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return notFound();
    } catch (error) {
      return refused(error, "Something went wrong");
    }
  };
}
