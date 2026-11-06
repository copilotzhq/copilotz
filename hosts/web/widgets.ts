/**
 * Widgets, the server's half: an app's web Views drawn inside an outside assistant's
 * conversation (an MCP Apps host: ChatGPT, Claude…), where the MCP interface's lines show a
 * tool's call through a View of the app's (`plugins/interfaces/mcp`). The browser's half is
 * `widget.tsx`, which this bundles for: the template the assistant loads, and the reads the
 * View makes, answered here first, so a widget draws at once.
 *
 * - **The template** (`page(origin)`): one HTML page with the widget host and the app's widget
 *   front ends inlined as one module (bundled without split chunks: the assistant's sandbox
 *   loads nothing else of the app's code), in the app's theme (its variables, light and dark,
 *   dark also by the host's word: `data-theme`), its fonts from the app's own origin (`origin`:
 *   the stylesheet's address made whole, which the line's CSP lets in). Its `version` is a hash
 *   of the page: a new deploy is a new template.
 * - **A snapshot** (`snapshot(runtime, …)`): the View the tool's call is shown through, run
 *   here as the conversation's contact with the same front ends, its reads answered by the
 *   runtime as that contact (queries only, each its `allow`, under the rules, without private
 *   fields: exactly what the widget could read itself), and what it read, by the client's keys,
 *   kept: the widget is seeded with it, so its first paint asks nothing. Past `limit` bytes
 *   (256 KiB), nothing is kept: the widget reads it all itself.
 *
 * A widget reads only through queries (named reads with an `allow`): a direct read of a
 * collection is refused here and in the widget's own reads (MCP's `copilotz_read`).
 *
 * ```ts
 * const widgets = widgetsOf({
 *   code: await bundle(new URL("./widgets.tsx", import.meta.url), { split: false }),
 *   plugins: [brandTheme, bookingWeb],
 * });
 * await serve({ runtime, widgets, port: 8080 });
 * ```
 */
import { answeredAs } from "../../runtime/browsers.ts";
import { connect, type Known } from "../../runtime/client.ts";
import { invalid } from "../../runtime/errors.ts";
import type { Actor, Plugins, Runtime, Viewer } from "../../runtime/mod.ts";
import { BASE } from "./style.ts";
import { fontsOf, preloadsOf, themeCss, themeOf } from "./theme/css.ts";

/** Bundled code, as `bundle` makes it (one file, for a widget: `split: false`). */
type Code = { entry: string; files: Record<string, string | Uint8Array> };

export type WidgetsOptions = {
  /**
   * The widget host and the app's widget front ends, bundled as one file
   * (`bundle(entry, { split: false })`), or a function that bundles it, once.
   * Its entry calls `widget({ plugins, root })` (`copilotz/web/widget`).
   */
  code: Code | (() => Code | Promise<Code>);
  /** The same front ends, here: the Views a snapshot runs, and the theme the page is in. */
  plugins: Plugins;
  /** The page's language (`pt-BR`), English unless said. */
  lang?: string;
};

export type SnapshotOptions = {
  /** Whose reads: the conversation's contact. */
  actor: Actor;
  viewer: Viewer;
  /** The View, its item and hints, as the widget will observe them first. */
  view: string;
  item: unknown;
  hints: Record<string, unknown>;
  /** The most bytes kept (256 KiB): past it, none. */
  limit?: number;
  /** How long it waits for the View's reads (5 s): past it, what it has. */
  wait?: number;
};

export type Widgets = {
  /** The template, for the app at `origin` (its fonts come from there), and its version. */
  page(origin: string): Promise<{ html: string; version: string }>;
  /** What the View reads, answered as the actor, by the client's keys. */
  snapshot(runtime: Pick<Runtime, "query">, options: SnapshotOptions): Promise<Known>;
};

const LIMIT = 256 * 1024;
const WAIT = 5_000;

/** Text that can't end the attribute it goes in. */
const quoted = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const sha = async (text: string) =>
  [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");

export function widgetsOf(options: WidgetsOptions): Widgets {
  let bundled: Promise<string> | undefined;
  const code = () =>
    bundled ??= Promise.resolve(typeof options.code === "function" ? options.code() : options.code)
      .then((made) => {
        const names = Object.keys(made.files);
        if (names.length !== 1 || !(made.entry in made.files)) {
          throw new Error(
            "widgets: the code is one file (bundle it with { split: false }), with its entry",
          );
        }
        const file = made.files[made.entry];
        return typeof file === "string" ? file : new TextDecoder().decode(file);
      });
  const theme = themeOf(options.plugins);
  const pages = new Map<string, Promise<{ html: string; version: string }>>();

  const page = (origin: string) => {
    const at = new URL(origin).origin;
    let made = pages.get(at);
    if (!made) {
      made = code().then(async (script) => {
        const fonts = fontsOf(theme);
        const whole = (path: string) => path.startsWith("/") ? `${at}${path}` : path;
        const css = `${themeCss(theme)}\n${BASE}`.replaceAll("<", "\\3c ");
        const html = `<!doctype html>
<html lang="${quoted(options.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${
          preloadsOf(theme).map(({ href, type }) =>
            `<link rel="preload" href="${
              quoted(whole(href))
            }" as="font" type="${type}" crossorigin>\n`
          ).join("")
        }${
          fonts ? `<link rel="stylesheet" href="${quoted(whole(fonts))}" crossorigin>\n` : ""
        }<style id="copilotz-first-paint">${css}</style>
<script id="copilotz-config" type="application/json">${
          JSON.stringify({ origin: at }).replaceAll("<", "\\u003c")
        }</script>
</head>
<body>
<div id="app"></div>
<script type="module">${
          // Nothing in the code may end its element, in any case, or open a comment there.
          script.replace(/<\/(script)/gi, "<\\/$1").replaceAll("<!--", "<\\!--")}</script>
</body>
</html>`;
        return { html, version: (await sha(html)).slice(0, 12) };
      });
      made.catch(() => pages.delete(at));
      pages.set(at, made);
    }
    return made;
  };

  const snapshot = async (
    runtime: Pick<Runtime, "query">,
    asked: SnapshotOptions,
  ): Promise<Known> => {
    const { actor } = asked;
    const client = connect({
      plugins: options.plugins,
      link: {
        read: (reads) =>
          Promise.all(reads.map(({ key, read }) => answeredAs(runtime, actor, key, read))),
        call: () => Promise.reject(invalid("A snapshot calls nothing")),
      },
    });
    const seen = client.observe(asked.view, asked.item, {
      viewer: asked.viewer,
      hints: asked.hints,
      part: () => null,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        seen.ready.then(() => client.idle()),
        new Promise((resolve) => timer = setTimeout(resolve, asked.wait ?? WAIT)),
      ]);
      const known = client.known();
      return JSON.stringify(known).length <= (asked.limit ?? LIMIT) ? known : [];
    } finally {
      clearTimeout(timer);
      seen.close();
      await client.close();
    }
  };

  return { page, snapshot };
}
