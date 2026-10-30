/**
 * The app's own files, as the web server serves them (`webServer({ assets })`):
 * a brand's fonts and their stylesheet, its images. The app says what they
 * are, by the path each is served at, and reads them as its platform does
 * (`Deno.readFile`, `fs.readFile`, a bundler's import): the server only
 * answers requests, so it runs wherever `Request` and `Response` do.
 *
 * ```ts
 * webServer({
 *   …,
 *   assets: {
 *     "/assets/fonts/brand.css": await Deno.readFile("fonts/brand.css"),
 *     "/assets/fonts/inter-v13-latin.woff2": () => Deno.readFile("fonts/inter-v13-latin.woff2"),
 *   },
 * });
 * ```
 *
 * - **Under `/assets/` only,** so they never stand in for the app's routes or
 *   pages; a path given anywhere else stops the server from starting.
 *   Anything under `/assets/` that isn't one of them is a 404, never the page.
 * - **Exact paths:** a request names one as given, or nothing. Paths are plain
 *   names (letters, digits, `.`, `_`, `-`; none starting with a dot) between
 *   slashes, so `..`, `.`, `//`, `%2e` and `%2f` match none. A request is
 *   matched as it was sent, before `..` is resolved (Deno's `Request.url` keeps
 *   it), so `/assets/../app/app.js` is a 404 rather than the code.
 * - **Known types only,** by extension: `.css`, `.woff2`, `.woff`, `.ttf`,
 *   `.otf`, `.svg`, `.png`; another stops the server from starting. Every
 *   answer says `X-Content-Type-Options: nosniff`, and a policy under which an
 *   SVG opened on its own runs nothing.
 * - **Cached:** fonts for a year, unchanged (`immutable`: a new version gets
 *   a new name, as `inter-v13-latin.woff2` says); stylesheets and images are
 *   asked about each time (`no-cache`) and come back `304` while their `ETag`
 *   holds. `HEAD` works too.
 * - **Read once:** a function is called on the first request, and what it
 *   gives is kept (a failure is tried again on the next).
 */

/** An asset's content (bytes, or text), or how to read it, once. */
export type Asset =
  | Uint8Array
  | string
  | (() => Uint8Array | string | Promise<Uint8Array | string>);

/** Where assets are served. */
export const ASSETS = "/assets/";

/** What each extension is served as, and whether it's kept for good. */
const TYPES = new Map<string, { type: string; immutable?: boolean }>([
  ["css", { type: "text/css; charset=utf-8" }],
  ["woff2", { type: "font/woff2", immutable: true }],
  ["woff", { type: "font/woff", immutable: true }],
  ["ttf", { type: "font/ttf", immutable: true }],
  ["otf", { type: "font/otf", immutable: true }],
  ["svg", { type: "image/svg+xml" }],
  ["png", { type: "image/png" }],
]);

/** A plain path under `/assets/`: names between slashes, none starting with a dot; its extension. */
const PATH = /^\/assets\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.([a-z\d]+)$/;

/** Every answer's, found or not. */
const SAFE = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
};

/** The path as the request sent it: before `.` and `..` are resolved, still encoded. */
const sentPath = (url: string) =>
  url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, "").replace(/[?#][\s\S]*$/, "") || "/";

const under = (path: string) => path === ASSETS.slice(0, -1) || path.startsWith(ASSETS);

/** A quoted tag for some bytes: the start of their SHA-256, base64. */
async function tagOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return `"${btoa(String.fromCharCode(...digest.subarray(0, 12)))}"`;
}

/** Whether `If-None-Match` names the tag (or any: `*`). */
const fresh = (header: string | null, tag: string) =>
  header !== null &&
  (header.trim() === "*" || header.split(",").some((t) => t.trim().replace(/^W\//, "") === tag));

const missing = () =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...SAFE },
  });

/**
 * Serves `assets`: a request under `/assets/` gets its answer (the file, or a
 * 404); any other gets undefined, for the app's own routes.
 */
export function assetServer(
  assets: Record<string, Asset> = {},
): (request: Request) => Promise<Response> | undefined {
  const files = new Map(
    Object.entries(assets).map(([path, content]) => {
      const kind = TYPES.get(PATH.exec(path)?.[1] ?? "");
      if (!kind) {
        throw new Error(
          `webServer: can't serve "${path}": an asset's path is under ${ASSETS}, plain names ` +
            `between slashes, ending .${[...TYPES.keys()].join(", .")}`,
        );
      }
      let loaded: Promise<{ bytes: Uint8Array; tag: string }> | undefined;
      const load = () =>
        loaded ??= (async () => {
          const value = typeof content === "function" ? await content() : content;
          const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
          return { bytes, tag: await tagOf(bytes) };
        })().catch((error) => {
          loaded = undefined;
          throw error;
        });
      return [path, { kind, load }] as const;
    }),
  );

  return (request) => {
    const sent = sentPath(request.url);
    if (!under(sent) && !under(new URL(request.url).pathname)) return undefined;
    const file = files.get(sent);
    if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
      return Promise.resolve(missing());
    }
    return file.load().then(
      ({ bytes, tag }) => {
        const headers = {
          "cache-control": file.kind.immutable ? "public, max-age=31536000, immutable" : "no-cache",
          etag: tag,
          ...SAFE,
        };
        if (fresh(request.headers.get("if-none-match"), tag)) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(request.method === "HEAD" ? null : bytes as BodyInit, {
          headers: {
            "content-type": file.kind.type,
            "content-length": String(bytes.byteLength),
            ...headers,
          },
        });
      },
      (error) => {
        console.error(`webServer: couldn't read ${sent}:`, error);
        return new Response("Couldn't read this file", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8", ...SAFE },
        });
      },
    );
  };
}
