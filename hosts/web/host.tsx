/**
 * The web host, in the browser: it connects as whoever the browser is (a
 * ticket from the runtime's `/connect`, which trades the cookie the runtime
 * keeps: the signed-in person, or a site visitor, let in first when the page
 * asks, `arrive`: `POST /web/<name>`), observes the web shell for the address it's at (its path, where
 * the person works, `?in=`, and its other parameters), and draws it with
 * React, each part a component redrawn on its own. Where you are is the address: links are
 * followed without reloading, back and forward work, two tabs differ. The
 * connection is kept for `LazyView`, which observes a View on demand.
 *
 * The page takes the app's theme from the first (signing in included): the
 * front ends' `theme` resources merged over the defaults, as CSS variables
 * for light and dark, with the fonts it names (Google's, or the app's own)
 * and its logo, which the toolkit's `Logo` draws. What the server put in the
 * page for its first paint (`webPage`, from the `theme` resource) gives way to it. It
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
import { Part } from "./part.tsx";
import { session } from "./session.ts";
import { SignIn } from "./signin.tsx";
import { BASE } from "./style.ts";
import { ThemeContext } from "./theme/context.ts";
import { fontsOf, fromGoogle, preloadsOf, themeCss, themeOf } from "./theme/css.ts";
import { UpdateReady } from "./update.tsx";
import { say } from "./host-words.ts";
import { setWords, wordsOf } from "./words.ts";

export type WebOptions = {
  plugins: Plugins;
  root: Element;
  /** The runtime's socket (this page's origin, under the app's base, `/oxian`, by default). */
  url?: string;
  /**
   * Coming in as a visitor of one of the app's site chats (`web` resource
   * entries, by name), when the browser isn't anyone yet: the page posts to
   * `/web/<name>` first (with the answer to its challenge, when it has one),
   * which lets it in and sets its cookie. Someone signed in comes in as themselves.
   */
  arrive?: { name: string; challenge?: string };
  /**
   * The app's first steps once connected, as whoever the browser is (a
   * person, a contact); what it returns is where they work until the
   * address says otherwise (`?in=`).
   */
  start?(client: Client, actor: Who): Promise<{ space?: string } | void>;
};

/** Who the browser is: a person (their id), or a web line's visitor (`contact`). */
export type Who = { kind: string; id: string };

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
    /** Where the app is under its host, when not the root (an org's, `/o/<org>`). */
    base?: string;
  };

/** What the runtime answered, or the error it said. */
async function answered<T>(
  response: Response,
  what: "couldntComeIn" | "couldntConnect",
): Promise<T> {
  if (!response.ok) {
    const said = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(said?.error ?? `${say(what)}: ${response.statusText}`);
  }
  return await response.json() as T;
}

/**
 * Comes in as a visitor of a site chat (`POST <base>/web/<name>`), unless the
 * browser is someone already: its cookie is set on the way back.
 */
async function arriving(arrive: { name: string; challenge?: string }): Promise<void> {
  const response = await fetch(`${config().base ?? ""}/web/${encodeURIComponent(arrive.name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(arrive.challenge ? { challenge: arrive.challenge } : {}),
  });
  await answered(response, "couldntComeIn");
}

/**
 * A ticket for one connection, or nothing when the browser is nobody: from
 * the app the page is (its `base`).
 */
async function ticket(): Promise<{ ticket: string; actor: Who } | undefined> {
  const response = await fetch(`${config().base ?? ""}/connect`, { method: "POST" });
  if (response.status === 401) return undefined;
  return await answered(response, "couldntConnect");
}

/** What the person signed in is shown as: their name (identity's `/me`), else nothing. */
async function nameOf(): Promise<string | undefined> {
  const response = await fetch(`${config().base ?? ""}/me`).catch(() => undefined);
  if (!response?.ok) return undefined;
  const me = await response.json().catch(() => null) as { name?: unknown } | null;
  return typeof me?.name === "string" && me.name ? me.name : undefined;
}

/**
 * The ways to sign in the app has, by what its routes answer: Google's, with
 * its client id (`GET /google`), and dev sign-in, on this machine
 * (`GET /signin/dev`). One that isn't there answers 404.
 */
async function waysToSignIn(): Promise<{ google?: { clientId: string }; dev?: true }> {
  const asked = async (path: string) => {
    const response = await fetch(path, { headers: { accept: "application/json" } }).catch(() =>
      undefined
    );
    const json = response?.ok && response.headers.get("content-type")?.includes("json");
    return json ? await response!.json().catch(() => undefined) : undefined;
  };
  const [google, dev] = await Promise.all([asked("/google"), asked("/signin/dev")]);
  const clientId = (google as { clientId?: unknown } | undefined)?.clientId;
  return {
    ...(typeof clientId === "string" && clientId ? { google: { clientId } } : {}),
    ...(dev ? { dev: true as const } : {}),
  };
}

export async function web(options: WebOptions): Promise<Client | undefined> {
  const react = createRoot(options.root);
  // The app's words (its plugins' `words` resources) are what every front end says from the start.
  setWords(wordsOf(options.plugins));
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
  if (options.arrive) await arriving(options.arrive);
  // Their name, asked while the ticket is: a person's, as they signed in.
  const named = options.arrive ? Promise.resolve(undefined) : nameOf();
  const first = await ticket();
  if (!first) {
    draw(<SignIn signIn={await waysToSignIn()} />);
    return undefined;
  }
  const person = first.actor.kind === "person";
  const name = person ? await named : undefined;
  let fresh: string | undefined = first.ticket;
  const url = options.url ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${
      config().base ?? ""
    }/oxian`;
  const client = connect({
    transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
    // The first connection takes the ticket in hand; a new one asks again.
    ticket: async () => {
      const kept = fresh;
      fresh = undefined;
      const next = kept ?? (await ticket())?.ticket;
      if (!next) {
        location.reload();
        throw new Error(say("signedOut"));
      }
      return next;
    },
    plugins: options.plugins,
  });
  await client.ready;
  // Who they are (a person by their id; a contact as messages name it), and their name.
  const viewer = {
    kind: first.actor.kind,
    name: person ? first.actor.id : `${first.actor.kind}:${first.actor.id}`,
    ...(name ? { label: name } : {}),
  };
  session.client = client;
  session.viewer = viewer;
  let space = (await options.start?.(client, first.actor))?.space;

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
    const shell = client.observe("web.shell", where, {
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
