/**
 * A page a route makes on the server, in the app's look: a sign-in form of
 * the app's own, a printable receipt, a link's landing page. Its head is the
 * app's page's (the theme's variables and the page's base, its icons, its
 * colour and fonts: see head.ts), and its body is React, made with the
 * toolkit (`Button`, `Input`, `Card`…), whose pieces bring their own styles,
 * and said in the app's words (its `words` resource).
 *
 * It's HTML only: no script runs in it, so what works is what HTML does by
 * itself, links and forms that post. The route decides its status and
 * headers; the page is never kept (`no-store`) unless they say otherwise.
 *
 * ```tsx
 * routes: {
 *   "/login": (request, { runtime }) =>
 *     routePage(runtime, {
 *       title: "Sign in",
 *       body: (
 *         <form method="post" action="/login">
 *           <Input name="username" aria-label="Username" />
 *           <Button type="submit" variant="primary">Go</Button>
 *         </form>
 *       ),
 *     }),
 * }
 * ```
 */
import { createElement, Fragment, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { definePlugin, type Resources } from "../../runtime/mod.ts";
import { look, quoted } from "./head.ts";
import { fontsOf, themeOf } from "./theme/css.ts";
import type { Theme } from "./theme/default.ts";
import { setWords, wordsOf } from "./words.ts";

/** What a route's page is. */
export type RoutePageOptions = {
  /** The page's title (the browser's tab). */
  title: string;
  /** What it shows: React, the toolkit's pieces among it. */
  body: ReactNode;
  /** Its status: 200 unless said (a refused sign-in may say 401). */
  status?: number;
  /** Its language, the app's page's (`page.lang`) unless said. */
  lang?: string;
  /** Headers of its own, over the page's. */
  headers?: HeadersInit;
};

/** The runtime a route is handed: what it describes is the app's resources. */
type Described = { describe(): { resources: Resources } };

/** The app's words, as the browser's page has them. */
const wordsFrom = (resources: Resources) =>
  wordsOf([
    definePlugin({ name: "route-page-words", resources: { words: resources.words ?? {} } }),
  ]);

/** The page's HTML, for an app's resources. */
export function routePageHtml(resources: Resources, options: RoutePageOptions): string {
  const theme = (resources.theme as Theme | undefined) ?? themeOf([]);
  const page = resources.page as { lang?: string } | undefined;
  const lang = options.lang ?? page?.lang ?? "en";
  const fonts = fontsOf(theme);
  // The app's words while it's drawn: the render is synchronous, so no other page sees them.
  const restore = setWords(wordsFrom(resources));
  let markup: string;
  try {
    markup = renderToString(createElement(Fragment, null, options.body));
  } finally {
    restore();
  }
  // The toolkit's styles (React writes each once, ahead of what uses it) go in the head.
  const styles: string[] = [];
  const body = markup.replace(/<style data-precedence="[^"]*"[^>]*>[\s\S]*?<\/style>/g, (style) => {
    styles.push(style);
    return "";
  });
  return `<!doctype html>
<html lang="${quoted(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${look(theme)}${fonts ? `<link rel="stylesheet" href="${fonts}">\n` : ""}${
    styles.map((style) => `${style}\n`).join("")
  }<title>${quoted(options.title)}</title>
</head>
<body>
${body}
</body>
</html>`;
}

/** The page as a route's answer. */
export function routePage(runtime: Described, options: RoutePageOptions): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
  return new Response(routePageHtml(runtime.describe().resources, options), {
    status: options.status ?? 200,
    headers,
  });
}
