/**
 * The web host, in the browser: it connects as the signed-in person (a
 * ticket from `/connect`, which trades the session cookie), observes the web
 * shell for the address it's at (its path, where the person works, `?in=`,
 * and its other parameters), and draws it with React, each part a
 * component redrawn on its own. Where you are is the address: links are
 * followed without reloading, back and forward work, two tabs differ. The
 * connection is kept for `LazyView`, which observes a View on demand.
 *
 * The page takes the app's theme from the first (signing in included): the
 * front ends' `theme` resources merged over the defaults, as CSS variables
 * for light and dark, with the fonts it names (Google's, or the app's own)
 * and its logo, which the toolkit's `Logo` draws. What the server put in the
 * page for its first paint (`webServer({ theme })`) gives way to it. It
 * registers the app's service worker, and offers a new version once one is
 * ready (`install.ts`).
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb], root: document.getElementById("app")! });
 * ```
 */
import { type ReactNode, useLayoutEffect } from "react";
import { preconnect, preinit, preload } from "react-dom";
import { createRoot } from "react-dom/client";
import { type Client, connect } from "../../runtime/client.ts";
import type { Observation, Plugins } from "../../runtime/mod.ts";
import { registerWorker } from "./install.ts";
import { loadOrgs, reenter } from "./orgs.ts";
import { Part } from "./part.tsx";
import { session } from "./session.ts";
import { SignIn } from "./signin.tsx";
import { BASE } from "./style.ts";
import { ThemeContext } from "./theme/context.ts";
import { fontsOf, fromGoogle, preloadsOf, themeCss, themeOf } from "./theme/css.ts";
import { UpdateReady } from "./update.tsx";

export type WebOptions = {
  plugins: Plugins;
  root: Element;
  /** The owner's socket (this page's origin, `/oxian`, by default). */
  url?: string;
  /**
   * The app's first steps once connected, as the person; what it returns
   * is where they work until the address says otherwise (`?in=`).
   */
  start?(client: Client, person: string): Promise<{ space?: string } | void>;
};

/**
 * What the shell is shown: the address, where the person works, and the
 * address's other parameters (`?tab=files`: `{ tab: "files" }`).
 */
export type Where = { path: string; space?: string; query?: Record<string, string> };

/** An address's parameters, but `in` (where the person works, which `Where` says apart). */
export function queryOf(search: string): Record<string, string> | undefined {
  const params = [...new URLSearchParams(search)].filter(([name]) => name !== "in");
  return params.length ? Object.fromEntries(params) : undefined;
}

let follow: ((path: string) => void) | undefined;

/** Once the host's own look is in the page, the server's first-paint copy goes. */
function Painted(): null {
  useLayoutEffect(() => document.getElementById("copilotz-first-paint")?.remove(), []);
  return null;
}

/** Goes to `path` without reloading (a handler moving on, as a link does). */
export function go(path: string): void {
  if (follow) follow(path);
  else location.assign(path);
}

/** Signs the person out (their session ends, its cookie goes) and starts over. */
export async function signOut(): Promise<void> {
  await fetch("/signout", { method: "POST" }).catch(() => {});
  location.assign("/");
}

const config = () =>
  JSON.parse(document.getElementById("copilotz-config")?.textContent ?? "{}") as {
    google: { clientId: string } | null;
    dev: boolean;
    /** Where the socket connects, when not `/oxian` (see `WebServerOptions.socket`). */
    socket?: string;
  };

/** A ticket for one connection, or nothing when nobody is signed in. */
async function ticket(): Promise<{ ticket: string; person: string; name?: string } | undefined> {
  const response = await fetch("/connect", { method: "POST" });
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error(`Couldn't connect: ${response.statusText}`);
  return await response.json();
}

export async function web(options: WebOptions): Promise<Client | undefined> {
  const react = createRoot(options.root);
  // The app's look goes with everything drawn, from the start: its theme, then the page's base.
  const theme = themeOf(options.plugins);
  const css = themeCss(theme);
  const fonts = fontsOf(theme);
  for (const { href, type } of preloadsOf(theme)) {
    preload(href, { as: "font", type, crossOrigin: "anonymous" });
  }
  if (fonts) {
    if (fromGoogle(fonts)) preconnect("https://fonts.gstatic.com", { crossOrigin: "anonymous" });
    preinit(fonts, { as: "style", precedence: "copilotz-fonts" });
  }
  const draw = (root: ReactNode) =>
    react.render(
      <ThemeContext value={theme}>
        <style href="copilotz-theme" precedence="copilotz">{css}</style>
        <style href="copilotz-base" precedence="copilotz">{BASE}</style>
        <Painted />
        {root}
        <UpdateReady />
      </ThemeContext>,
    );
  draw(null);
  // Installable, and told when a new version is ready (see pwa.ts).
  registerWorker();
  const first = await ticket();
  if (!first) {
    // Still signed in, but no longer in this org (with many): into another of theirs.
    if (await reenter()) return undefined;
    draw(<SignIn config={config()} />);
    return undefined;
  }
  // The person's orgs (when the server serves many), asked while the connection is made.
  void loadOrgs();
  let fresh: string | undefined = first.ticket;
  const url = options.url ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${
      config().socket ?? "/oxian"
    }`;
  const client = connect({
    transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
    // The first connection takes the ticket in hand; a new one asks again.
    ticket: async () => {
      const kept = fresh;
      fresh = undefined;
      const next = kept ?? (await ticket())?.ticket;
      if (!next) {
        location.reload();
        throw new Error("Signed out");
      }
      return next;
    },
    plugins: options.plugins,
  });
  await client.ready;
  // Who they are (their id), and what they're shown as (their name).
  const viewer = {
    kind: "person",
    name: first.person,
    ...(first.name ? { label: first.name } : {}),
  };
  session.client = client;
  session.viewer = viewer;
  let space = (await options.start?.(client, first.person))?.space;

  let shown: Observation | undefined;
  const show = () => {
    const asked = new URLSearchParams(location.search).get("in");
    if (asked) space = asked;
    const query = queryOf(location.search);
    const where: Where = {
      path: location.pathname,
      ...(space ? { space } : {}),
      ...(query ? { query } : {}),
    };
    const shell = client.observe("web", "shell", where, {
      viewer,
      part: (part, key) => <Part key={key} part={part} />,
    });
    draw(<Part part={shell} />);
    // The old screen closes once the new one reads what it needs: what both read stays watched.
    const old = shown;
    shown = shell;
    void shell.ready.then(() => old?.close());
  };

  follow = (path) => {
    history.pushState(null, "", path);
    show();
  };
  addEventListener("popstate", show);
  // Links within the app are followed here, without reloading.
  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a");
    if (
      !link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || link.target || link.hasAttribute("download") ||
      link.origin !== location.origin
    ) return;
    event.preventDefault();
    go(link.pathname + link.search);
  });
  show();
  return client;
}
