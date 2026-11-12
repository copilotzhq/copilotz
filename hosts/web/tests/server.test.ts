/**
 * The web host's server half, through `runtime.fetch`: the page (the
 * `webPage` plugin, from the app's `page` and `theme` resources) and its
 * files; signing in sets an httpOnly cookie the page's code never sees; the
 * cookie trades for a ticket that admits once, so many a minute; signing out
 * ends the session; none of it is cached. Signing in by name is for this
 * machine only, by the socket's address and the host. What goes wrong says
 * only what's for anyone. Given the app's theme, the page carries it for its
 * first paint, with its icons, its colour and its fonts (fetched, not waited
 * on). The app's own files are served under /assets/ only, by exact path,
 * typed and cached; the host's own (Copilotz's fonts and icons) under
 * /assets/copilotz/, with no configuration, and nothing from Google.
 */
import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Plugin,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { createTickets } from "../../../runtime/tickets.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, devSignIn, identity } from "../../../plugins/access/mod.ts";
import { chat } from "../../../plugins/agents/chat/mod.ts";
import models from "../../../plugins/models/mod.ts";
import { test } from "../../../testing/mod.ts";
import { attached } from "../../../plugins/agents/tests/fixtures/files.ts";
import { type PageSettings, webPage } from "../server.ts";
import { themeOf } from "../theme/css.ts";
import type { Theme } from "../theme/default.ts";

const CODE = {
  entry: "app.js",
  files: { "app.js": "import('./math-AB12.js')", "math-AB12.js": "export const m = 1;" },
};

/** The app's settings: the page it serves, and its theme. */
const settings = (page: Partial<PageSettings> = {}, theme?: Theme): Plugin =>
  definePlugin({
    name: "settings",
    resources: { page: { code: CODE, title: "Test", ...page }, ...(theme ? { theme } : {}) },
  });

async function setup(
  fn: (serve: (request: Request) => Promise<Response>, rt: Runtime) => Promise<void>,
  options: { dev?: boolean; theme?: Theme; assets?: PageSettings["assets"] } = {},
) {
  // Signing in by name is a plugin's (dev sign-in), as any way to sign in is.
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      ...(options.dev ?? true ? [devSignIn] : []),
      webPage,
      settings(options.assets ? { assets: options.assets } : {}, options.theme),
    ],
  });
  try {
    await fn((request) => rt.fetch(request), rt);
  } finally {
    await rt.close();
  }
}

/** A POST from this machine (its socket's address: a listener's says so). */
const post = (url: string, body?: unknown, cookie?: string, address = "127.0.0.1") =>
  setClientAddress(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    address,
  );

/** The cookie a response sets, as a browser sends it back. */
const sent = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];

test("a page, its code, and what is not a page", async () => {
  await setup(async (serve) => {
    const page = await serve(new Request("http://localhost:8790/thread/t1"));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await page.text();
    assertMatch(html, /<title>Test<\/title>/);
    // Nothing in its config but where the app is, when it isn't the root.
    assertMatch(html, /<script id="copilotz-config" type="application\/json">\{\}<\/script>/);
    assertMatch(html, /<script type="module" src="\/app\/app\.js">/);
    // The entry is asked for again each time; a chunk, named by its content, is kept.
    const entry = await serve(new Request("http://localhost:8790/app/app.js"));
    assertEquals(await entry.text(), "import('./math-AB12.js')");
    assertEquals(entry.headers.get("cache-control"), "no-cache");
    const chunk = await serve(new Request("http://localhost:8790/app/math-AB12.js"));
    assertEquals(await chunk.text(), "export const m = 1;");
    assertEquals(chunk.headers.get("content-type"), "text/javascript; charset=utf-8");
    assertEquals(chunk.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assertEquals((await serve(new Request("http://localhost:8790/app/other.js"))).status, 404);
    assertEquals((await serve(new Request("http://localhost:8790/app/toString"))).status, 404);
    // The page is for a browser navigating; a script's fetch, a POST, or another file is a 404.
    const json = await serve(
      new Request("http://localhost:8790/thread/t1", { headers: { accept: "application/json" } }),
    );
    assertEquals([json.status, await json.json()], [404, { error: "Not found" }]);
    const fetched = await serve(
      new Request("http://localhost:8790/thread/t1", {
        headers: { "sec-fetch-mode": "cors", accept: "text/html" },
      }),
    );
    assertEquals(fetched.status, 404);
    await fetched.body?.cancel();
    const navigated = await serve(
      new Request("http://localhost:8790/thread/t1", {
        headers: { "sec-fetch-mode": "navigate", accept: "text/html,*/*;q=0.8" },
      }),
    );
    assertEquals(navigated.headers.get("content-type"), "text/html; charset=utf-8");
    await navigated.body?.cancel();
    // The same, passed on by the service worker (Firefox says `same-origin`): still the page.
    const passed = await serve(
      new Request("http://localhost:8790/thread/t1", {
        headers: {
          "sec-fetch-mode": "same-origin",
          "sec-fetch-dest": "document",
          accept: "text/html",
        },
      }),
    );
    assertEquals(passed.headers.get("content-type"), "text/html; charset=utf-8");
    await passed.body?.cancel();
    const scripted = await serve(
      new Request("http://localhost:8790/thread/t1", {
        headers: { "sec-fetch-mode": "same-origin", "sec-fetch-dest": "empty", accept: "*/*" },
      }),
    );
    assertEquals(scripted.status, 404);
    await scripted.body?.cancel();
    const posted = await serve(new Request("http://localhost:8790/thread/t1", { method: "POST" }));
    assertEquals(posted.status, 404);
    await posted.body?.cancel();
    // Machine discovery paths under /.well-known/ are never the HTML page.
    const wellKnown = await serve(
      new Request("http://localhost:8790/.well-known/oauth-protected-resource"),
    );
    assertEquals([wellKnown.status, await wellKnown.json()], [404, { error: "Not found" }]);
    const manifest = await serve(new Request("http://localhost:8790/manifest.webmanifest"));
    assertEquals(manifest.headers.get("content-type"), "application/manifest+json; charset=utf-8");
    assertEquals((await manifest.json()).name, "Test");
    const worker = await serve(new Request("http://localhost:8790/sw.js"));
    assertEquals(worker.headers.get("service-worker-allowed"), "/");
    await worker.body?.cancel();
  });
});

test("an app under a base: the page tells its code, and answers there", async () => {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [webPage, settings({ base: "/o/acme" })],
  });
  try {
    const page = await rt.fetch(new Request("http://localhost:8790/o/acme/thread/t1"));
    assertMatch(
      await page.text(),
      /<script id="copilotz-config" type="application\/json">\{"base":"\/o\/acme"\}<\/script>/,
    );
    const entry = await rt.fetch(new Request("http://localhost:8790/o/acme/app/app.js"));
    assertEquals(await entry.text(), "import('./math-AB12.js')");
  } finally {
    await rt.close();
  }
});

test("a page needs code of its own, and files of a known name, or the server won't start", async () => {
  const starting = (page: Record<string, unknown> | undefined, message: string) =>
    assertRejects(
      async () => {
        const rt = await createRuntime({
          store: memoryStore(),
          plugins: [
            webPage,
            definePlugin({ name: "settings", ...(page ? { resources: { page } } : {}) }),
          ],
        });
        await rt.close();
      },
      Error,
      message,
    );
  await starting(undefined, "set page.code");
  await starting({ title: "x" }, "set page.code");
  await starting({ code: "app.js" }, "bundled code");
  await starting(
    { code: CODE, assets: { "/assets/copilotz/x.css": "a {}" } },
    "the web host's own",
  );
});

test("on phones the page is an app's: it spans the screen, and pinching still zooms", async () => {
  await setup(async (serve) => {
    const html = await (await serve(new Request("http://localhost:8790/"))).text();
    const viewport = html.match(/<meta name="viewport" content="([^"]*)">/)?.[1] ?? "";
    assertMatch(viewport, /width=device-width, initial-scale=1/);
    assertMatch(viewport, /viewport-fit=cover/);
    assertMatch(viewport, /interactive-widget=resizes-content/);
    // Nothing caps the zoom: people who need larger text pinch.
    assert(!/maximum-scale|user-scalable/.test(viewport), viewport);
  });
});

test("given the app's theme, the page carries it for its first paint", async () => {
  const brand = definePlugin({
    name: "brand",
    resources: {
      theme: {
        light: { primary: "#0f766e" },
        font: { url: "https://fonts.googleapis.com/css2?family=Inter&display=swap" },
      },
    },
  });
  await setup(async (serve) => {
    const html = await (await serve(new Request("http://localhost:8790/"))).text();
    assertMatch(html, /<meta name="color-scheme" content="light dark">/);
    assertMatch(
      html,
      /<style id="copilotz-first-paint">[^<]*--primary: #0f766e;[^<]*@layer copilotz-base/,
    );
    assertMatch(
      html,
      /<link rel="preload" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter&display=swap" as="style">/,
    );
    assertMatch(html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
    assert(!html.includes('rel="stylesheet"'), "the first paint waits on no stylesheet");
  }, { theme: themeOf([brand]) });
  const own = definePlugin({
    name: "own",
    resources: { theme: { font: { url: "/assets/fonts/brand.css" } } },
  });
  await setup(async (serve) => {
    const html = await (await serve(new Request("http://localhost:8790/"))).text();
    assertMatch(html, /<link rel="preload" href="\/assets\/fonts\/brand\.css" as="style">/);
    assert(!html.includes("fonts.gstatic.com"), "the app's own fonts need no connection to Google");
    assert(!html.includes("googleapis"));
  }, { theme: themeOf([own]) });
  await setup(async (serve) => {
    const html = await (await serve(new Request("http://localhost:8790/"))).text();
    assert(!html.includes("copilotz-first-paint"), "without a theme, the page has none");
  });
});

test("Copilotz by default: its icons, its colour and its fonts, from the host, none from Google", async () => {
  await setup(async (serve) => {
    const html = await (await serve(new Request("http://localhost:8790/"))).text();
    assertMatch(
      html,
      /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/,
    );
    assertMatch(
      html,
      /<meta name="theme-color" content="#0c101d" media="\(prefers-color-scheme: dark\)">/,
    );
    assertMatch(
      html,
      /<link rel="icon" href="\/assets\/copilotz\/icon\.png" type="image\/png" sizes="180x180">/,
    );
    assertMatch(
      html,
      /<link rel="icon" href="\/assets\/copilotz\/icon\.svg" type="image\/svg\+xml">/,
    );
    assertMatch(html, /<link rel="apple-touch-icon" href="\/assets\/copilotz\/icon\.png">/);
    assertMatch(html, /<link rel="preload" href="\/assets\/copilotz\/fonts\.css" as="style">/);
    assertMatch(
      html,
      /<link rel="preload" href="\/assets\/copilotz\/manrope-v23-latin\.woff2" as="font" type="font\/woff2" crossorigin>/,
    );
    assertMatch(html, /--font-display: "Space Grotesk"/);
    assert(!/googleapis|gstatic/.test(html), "nothing from Google");

    const css = await serve(new Request("http://localhost:8790/assets/copilotz/fonts.css"));
    assertEquals(css.headers.get("content-type"), "text/css; charset=utf-8");
    const faces = await css.text();
    assertMatch(faces, /font-family: "Manrope";[^}]*src: url\(manrope-v23-latin\.woff2\)/);
    assertMatch(faces, /font-family: "Space Grotesk";/);
    assert(!faces.includes("//"), "its files are beside it, not elsewhere");
    for (const file of faces.matchAll(/url\(([^)]+)\)/g)) {
      const font = await serve(new Request(`http://localhost:8790/assets/copilotz/${file[1]}`));
      assertEquals(font.headers.get("content-type"), "font/woff2", file[1]);
      assertEquals(font.headers.get("cache-control"), "public, max-age=31536000, immutable");
      const bytes = new Uint8Array(await font.arrayBuffer());
      assertEquals(new TextDecoder().decode(bytes.subarray(0, 4)), "wOF2", file[1]);
    }
    const svg = await serve(new Request("http://localhost:8790/assets/copilotz/icon.svg"));
    assertEquals(svg.headers.get("content-type"), "image/svg+xml");
    assertMatch(await svg.text(), /^<svg [^>]*viewBox="100 184 400 400">/);
    const png = await serve(new Request("http://localhost:8790/assets/copilotz/icon.png"));
    assertEquals(png.headers.get("content-type"), "image/png");
    assertEquals([...new Uint8Array(await png.arrayBuffer()).subarray(0, 4)], [137, 80, 78, 71]);
  }, { theme: themeOf([]) });
  // Another brand's mark is its icon; with no PNG of its own, none.
  const harbor = definePlugin({
    name: "harbor",
    resources: {
      theme: {
        logo: { mark: { viewBox: "0 0 32 32", paths: [{ d: "M0 0h32v32H0z", fill: "#0f766e" }] } },
        light: { background: "#fafaf9" },
      },
    },
  });
  await setup(async (serve) => {
    const html = await (await serve(new Request("http://localhost:8790/"))).text();
    assertMatch(html, /<meta name="theme-color" content="#fafaf9" media=/);
    assertMatch(
      html,
      /<link rel="icon" href="\/assets\/copilotz\/icon\.svg" type="image\/svg\+xml">/,
    );
    assert(!html.includes("icon.png"));
    const svg = await (await serve(new Request("http://localhost:8790/assets/copilotz/icon.svg")))
      .text();
    assertMatch(
      svg,
      /viewBox="0 0 32 32"><style>[^<]*<\/style><path d="M0 0h32v32H0z" fill="#0f766e"\/>/,
    );
  }, { theme: themeOf([harbor]) });
  // With no theme for the page, the host's fonts are still there for the browser's.
  await setup(async (serve) => {
    const css = await serve(new Request("http://localhost:8790/assets/copilotz/fonts.css"));
    assertEquals(css.status, 200);
    await css.body?.cancel();
    const svg = await serve(new Request("http://localhost:8790/assets/copilotz/icon.svg"));
    assertEquals(svg.status, 404);
    await svg.body?.cancel();
  });
});

/** Bytes that stand for a font file. */
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
const CSS = '@font-face { font-family: "Brand"; src: url(brand-v1.woff2) format("woff2"); }';
const ASSETS = {
  "/assets/fonts/brand.css": CSS,
  "/assets/fonts/brand-v1.woff2": () => Promise.resolve(FONT),
  "/assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
  "/assets/mark.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

/**
 * A request as a server hands it over, its path as sent: Deno.serve keeps
 * `..` and `%2e%2e` in `request.url`, which `new Request` would resolve.
 */
const sentAs = (url: string, init?: RequestInit) =>
  Object.defineProperty(new Request("http://localhost:8790/", init), "url", { value: url });

test("the app's files: served under /assets/ with their types, nosniff, and caching", async () => {
  await setup(async (serve) => {
    const css = await serve(new Request("http://localhost:8790/assets/fonts/brand.css"));
    assertEquals(css.status, 200);
    assertEquals(css.headers.get("content-type"), "text/css; charset=utf-8");
    assertEquals(css.headers.get("cache-control"), "no-cache");
    assertEquals(css.headers.get("x-content-type-options"), "nosniff");
    assertEquals(await css.text(), CSS);

    const font = await serve(new Request("http://localhost:8790/assets/fonts/brand-v1.woff2"));
    assertEquals(font.headers.get("content-type"), "font/woff2");
    assertEquals(font.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assertEquals(font.headers.get("x-content-type-options"), "nosniff");
    assertEquals(new Uint8Array(await font.arrayBuffer()), FONT);

    const svg = await serve(new Request("http://localhost:8790/assets/logo.svg"));
    assertEquals(svg.headers.get("content-type"), "image/svg+xml");
    assertMatch(svg.headers.get("content-security-policy")!, /default-src 'none'/);
    await svg.body?.cancel();
    const png = await serve(new Request("http://localhost:8790/assets/mark.png?v=2"));
    assertEquals(png.headers.get("content-type"), "image/png");
    await png.body?.cancel();

    // Asked again with its tag: unchanged, nothing sent.
    const tag = css.headers.get("etag")!;
    assertMatch(tag, /^"[^"]+"$/);
    const again = await serve(
      new Request("http://localhost:8790/assets/fonts/brand.css", {
        headers: { "if-none-match": `W/"other", ${tag}` },
      }),
    );
    assertEquals(again.status, 304);
    assertEquals(again.headers.get("etag"), tag);
    assertEquals(again.headers.get("x-content-type-options"), "nosniff");
    assertEquals(await again.text(), "");
    // HEAD: the headers alone.
    const head = await serve(
      new Request("http://localhost:8790/assets/fonts/brand-v1.woff2", { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(head.headers.get("content-length"), String(FONT.byteLength));
    assertEquals(await head.text(), "");
  }, { assets: ASSETS });
});

test("under /assets/, what isn't one of the app's files is a 404, never the page", async () => {
  await setup(async (serve) => {
    const notFound = async (request: Request, why: string) => {
      const response = await serve(request);
      assertEquals(response.status, 404, why);
      assertEquals(response.headers.get("x-content-type-options"), "nosniff", why);
      assert(!(await response.text()).includes("<html"), why);
    };
    await notFound(new Request("http://localhost:8790/assets/fonts/other.css"), "unknown");
    await notFound(new Request("http://localhost:8790/assets/"), "the folder");
    await notFound(new Request("http://localhost:8790/assets"), "the prefix itself");
    await notFound(new Request("http://localhost:8790/assets/fonts/brand.css/"), "a slash after");
    await notFound(new Request("http://localhost:8790/assets/fonts%2fbrand.css"), "%2f");
    await notFound(new Request("http://localhost:8790/assets/fonts%2Fbrand.css"), "%2F");
    await notFound(new Request("http://localhost:8790/assets//fonts/brand.css"), "//");
    await notFound(
      new Request("http://localhost:8790/assets/fonts/brand.css", { method: "POST" }),
      "not a GET",
    );
    // Traversal, as a server hands it over: never read as a file under /assets/. (Where
    // `..` takes the path out of /assets/, the URL itself is another path: the code's.)
    await notFound(sentAs("http://localhost:8790/assets/fonts/../fonts/brand.css"), "../ back in");
    await notFound(sentAs("http://localhost:8790/assets/./fonts/brand.css"), "./");
    await notFound(sentAs("http://localhost:8790/x/../assets/fonts/brand.css"), "into /assets/");
    for (const out of ["/assets/../app/app.js", "/assets/%2e%2e/app/app.js"]) {
      const code = await serve(sentAs(`http://localhost:8790${out}`));
      assertEquals(await code.text(), "import('./math-AB12.js')", out);
    }
    // Outside /assets/, the app as ever.
    assertEquals(
      await (await serve(new Request("http://localhost:8790/app/app.js"))).text(),
      "import('./math-AB12.js')",
    );
    const page = await serve(new Request("http://localhost:8790/assetsy/thread"));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    await page.body?.cancel();
  }, { assets: ASSETS });
  // With no assets, /assets/ is still the app's own: a 404.
  await setup(async (serve) => {
    const response = await serve(new Request("http://localhost:8790/assets/fonts/brand.css"));
    assertEquals(response.status, 404);
    await response.body?.cancel();
  });
});

test("assets are read once, on first request; a failure is tried again", async () => {
  let reads = 0;
  let fail = true;
  const error = console.error;
  console.error = () => {};
  try {
    await setup(async (serve) => {
      const get = () => serve(new Request("http://localhost:8790/assets/a.css"));
      assertEquals(reads, 0);
      const failed = await get();
      assertEquals(failed.status, 500);
      assert(!(await failed.text()).includes("disk"), "the failure isn't told");
      fail = false;
      assertEquals(await (await get()).text(), "a {}");
      assertEquals(await (await get()).text(), "a {}");
      assertEquals(reads, 2);
    }, {
      assets: {
        "/assets/a.css": () => {
          reads++;
          if (fail) throw new Error("disk on fire");
          return "a {}";
        },
      },
    });
  } finally {
    console.error = error;
  }
});

test("an asset is a plain path under /assets/ of a known type, or the server won't start", async () => {
  const serving = (path: string) => async () => {
    const rt = await createRuntime({
      store: memoryStore(),
      plugins: [webPage, settings({ assets: { [path]: "x" } })],
    });
    await rt.close();
  };
  for (
    const path of [
      "/app.js",
      "/fonts/brand.css",
      "/assets/../app.css",
      "/assets/./brand.css",
      "/assets//brand.css",
      "/assets/.hidden.css",
      "/assets/fonts%2fbrand.css",
      "/assets/brand.css/",
      "assets/brand.css",
      "/assets/page.html",
      "/assets/app.js",
      "/assets/brand",
      "/assets/BRAND.CSS",
      "/assets/copilotz/fonts.css",
      "/assets/copilotz/brand.css",
    ]
  ) await assertRejects(serving(path), Error, "", path);
});

test("signing in sets a session cookie, traded for a ticket that admits once", async () => {
  await setup(async (serve) => {
    assertEquals((await serve(post("http://localhost:8790/connect"))).status, 401);
    const signed = await serve(post("http://localhost:8790/signin/dev", { name: "Ana" }));
    assertEquals(await signed.json(), { person: "ana" });
    const cookie = signed.headers.get("set-cookie")!;
    assertMatch(cookie, /^session=ses_[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);

    assertEquals(signed.headers.get("cache-control"), "no-store");
    const connect = await serve(post("http://localhost:8790/connect", undefined, sent(signed)));
    assertEquals(connect.headers.get("cache-control"), "no-store");
    // The ticket and who it is for; the name is identity's `GET /me`.
    const answered = await connect.json();
    assertEquals(Object.keys(answered).sort(), ["actor", "ticket"]);
    assertEquals(answered.actor, { kind: "person", id: "ana" });
    assertMatch(answered.ticket, /^[0-9a-f]{64}$/);
    const me = await serve(
      new Request("http://localhost:8790/me", { headers: { cookie: sent(signed) } }),
    );
    assertEquals((await me.json()).person, "ana");
    assertEquals((await serve(new Request("http://localhost:8790/me"))).status, 401);
  });
});

test("the cookie is Secure, and the host's alone, anywhere but this machine over http", async () => {
  await setup(async (serve) => {
    const secure = await serve(post("https://localhost:8790/signin/dev", { name: "ana" }));
    assertMatch(secure.headers.get("set-cookie")!, /^__Host-session=ses_[^;]+; .*; Secure$/);
  });
});

test("signing in by name: this machine only, when allowed, with a plain name", async () => {
  await setup(async (serve) => {
    const status = async (request: Request) => (await serve(request)).status;
    // A host that isn't this machine's, from this machine.
    assertEquals(await status(post("http://app.example/signin/dev", { name: "ana" })), 404);
    // `Host: localhost` says nothing of where it came from: another machine's socket, or none.
    assertEquals(
      await status(post("http://localhost:8790/signin/dev", { name: "ana" }, "", "192.168.1.20")),
      404,
    );
    const nowhere = new Request("http://localhost:8790/signin/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ana" }),
    });
    assertEquals(await status(nowhere), 404);
    // This machine's socket, to a host whose name points here (a page rebinding it): no.
    assertEquals(await status(post("http://evil.example/signin/dev", { name: "ana" })), 404);
    // This machine's, to this machine.
    assertEquals(await status(post("http://localhost:8790/signin/dev", { name: "ana" })), 200);
    assertEquals(
      await status(post("http://[::1]:8790/signin/dev", { name: "ana" }, "", "::1")),
      200,
    );
    // A name it won't take says why.
    const bad = await serve(post("http://localhost:8790/signin/dev", { name: "ana; drop" }));
    assertEquals([bad.status, (await bad.json()).error], [
      400,
      "A name (letters, digits, . _ -) or an email",
    ]);
  });
  await setup(async (serve) => {
    assertEquals(
      (await serve(post("http://localhost:8790/signin/dev", { name: "ana" }))).status,
      404,
    );
  }, { dev: false });
});

test("signing out ends the session and clears the cookie", async () => {
  await setup(async (serve) => {
    const signed = await serve(post("http://localhost:8790/signin/dev", { name: "ana" }));
    const out = await serve(post("http://localhost:8790/signout", undefined, sent(signed)));
    assertMatch(out.headers.get("set-cookie")!, /^session=; .*Max-Age=0/);
    assertEquals(out.headers.get("cache-control"), "no-store");
    const connect = await serve(post("http://localhost:8790/connect", undefined, sent(signed)));
    assertEquals(connect.status, 401);
  });
});

test("a ticket works once, and not after its minute", async () => {
  const tickets = createTickets({ ms: 20 });
  const ana: Actor = { kind: "person", id: "ana" };
  const first = tickets.issue(ana);
  const second = tickets.issue(ana);
  assert(first !== second);
  assertEquals(tickets.admit(first), ana);
  assertEquals(tickets.admit(first), undefined);
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(tickets.admit(second), undefined);
  assertEquals(tickets.admit("forged"), undefined);
  tickets.close();
});

test("a person's key has its own tickets: counted and ended apart from its person's", () => {
  const tickets = createTickets({ perMinute: 1 });
  const ana: Actor = { kind: "person", id: "ana" };
  const key: Actor = { ...ana, key: "k1", scope: { call: ["note.add"] } };
  const hers = tickets.issue(ana);
  // Her minute's ticket taken, the key still has its own.
  const its = tickets.issue(key);
  assertThrows(() => tickets.issue(ana), Error, "Too many");
  // Revoking the key ends its tickets, not hers.
  tickets.end(key);
  assertEquals(tickets.admit(its), undefined);
  assertEquals(tickets.admit(hers), ana);
  // Signing her out ends hers, not a key's.
  const other = tickets.issue({ ...ana, key: "k2" });
  tickets.end(ana);
  assertEquals(tickets.admit(other), { ...ana, key: "k2" });
  tickets.close();
});

test("a file someone sent: theirs to fetch, in parts, inline or saved; nobody else's", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {}, file: {} },
      agents: { lead: { instructions: "Hi.", model: "fake/echo", default: true } },
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, devSignIn, app],
  });
  const signIn = async (name: string) =>
    sent(await rt.fetch(post("http://localhost:8790/signin/dev", { name })));
  const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
    rt.fetch(
      new Request(`http://localhost:8790${path}`, {
        headers: { ...(cookie ? { cookie } : {}), ...headers },
      }),
    );
  try {
    const ana = await signIn("ana");
    const bob = await signIn("bob");
    const as = { actor: { kind: "person", id: "ana" } };
    const { space } = await rt.call<{ space: string }>("space.personal", {}, as);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]);
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "look",
      in: space,
      files: await attached(rt, [
        { name: "a b.png", type: "image/png", data: btoa(String.fromCharCode(...bytes)) },
        { name: "page.html", type: "text/html", data: btoa("<script>alert(1)</script>") },
      ], as),
    }, as);
    const [message] = await rt.query<{ files: { id: string }[] }[]>(
      "message.history",
      { thread },
      as,
    );
    const [png, html] = message.files.map((f) => `/files/${encodeURIComponent(f.id)}`);

    const whole = await get(png, ana);
    assertEquals(whole.status, 200);
    assertEquals(new Uint8Array(await whole.arrayBuffer()), bytes);
    assertEquals(whole.headers.get("content-type"), "image/png");
    assertEquals(whole.headers.get("content-disposition"), "inline; filename*=UTF-8''a%20b.png");
    assertEquals(whole.headers.get("x-content-type-options"), "nosniff");
    assertMatch(whole.headers.get("content-security-policy")!, /sandbox/);

    // A part, as Safari asks for audio; and one it can't have.
    const part = await get(png, ana, { range: "bytes=2-5" });
    assertEquals(part.status, 206);
    assertEquals(part.headers.get("content-range"), "bytes 2-5/10");
    assertEquals(new Uint8Array(await part.arrayBuffer()), bytes.subarray(2, 6));
    assertEquals((await get(png, ana, { range: "bytes=40-" })).status, 416);

    // Saved, not shown: when asked, and anything but media.
    assertMatch(
      (await get(`${png}?download=1`, ana)).headers.get("content-disposition")!,
      /^attachment/,
    );
    assertMatch((await get(html, ana)).headers.get("content-disposition")!, /^attachment/);

    // Nobody signed in, someone the file isn't shared with, no such file: alike.
    assertEquals((await get(png)).status, 404);
    assertEquals((await get(png, bob)).status, 404);
    assertEquals((await get("/files/nope", ana)).status, 404);
    assertEquals((await get("/files/%E0%A4%A", ana)).status, 404);
  } finally {
    await rt.close();
  }
});

test("a person has 30 tickets a minute; past them, /connect says when to come back", async () => {
  await setup(async (serve, rt) => {
    const ana = sent(await serve(post("http://localhost:8790/signin/dev", { name: "ana" })));
    const connect = (cookie: string) =>
      serve(post("http://localhost:8790/connect", undefined, cookie));
    for (let i = 0; i < 30; i++) assertEquals((await connect(ana)).status, 200, `ticket ${i}`);
    const refused = await connect(ana);
    assertEquals(refused.status, 429);
    assertEquals(refused.headers.get("cache-control"), "no-store");
    const wait = Number(refused.headers.get("retry-after"));
    assert(wait >= 1 && wait <= 60, `retry-after ${wait}`);
    assertEquals(await refused.json(), {
      error: "Too many connections at once: try again in a minute",
    });
    // Anyone else still connects.
    const { session } = await rt.call<{ session: string }>("session.start", { person: "bob" });
    assertEquals((await connect(`session=${session}`)).status, 200);
  });
});

test("tickets are counted per actor and minute, and dropped as they pass, unswept", async () => {
  const tickets = createTickets({ ms: 20, perMinute: 2 });
  const ana: Actor = { kind: "person", id: "ana" };
  const kept = [tickets.issue(ana), tickets.issue(ana)];
  const refused = (() => {
    try {
      tickets.issue(ana);
    } catch (error) {
      return error as { code?: string; public?: boolean; retryAfter?: number };
    }
  })();
  assertEquals([refused?.code, refused?.public], ["too_many", true]);
  assert(refused!.retryAfter! >= 1 && refused!.retryAfter! <= 60);
  // Someone else's are their own.
  assert(tickets.admit(tickets.issue({ kind: "person", id: "bob" })));
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(kept.map((t) => tickets.admit(t)), [undefined, undefined]);
  tickets.close();
});

test("what goes wrong says only what's for anyone: its status by its code", async () => {
  const logged = console.error;
  console.error = () => {};
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      devSignIn,
      webPage,
      definePlugin({
        name: "settings",
        resources: {
          page: {
            code: () => {
              throw new Error("the bundler's path: /home/app/secret");
            },
          },
        },
      }),
    ],
  });
  try {
    const page = await rt.fetch(new Request("http://localhost:8790/"));
    assertEquals([page.status, await page.json()], [500, { error: "Something went wrong" }]);
    assertEquals(page.headers.get("cache-control"), "no-store");
  } finally {
    console.error = logged;
    await rt.close();
  }
});

test("a session cookie another host under the domain set isn't anyone, on https", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity] });
  try {
    const { session } = await rt.call<{ session: string }>("session.start", { person: "mallory" });
    const connect = async (cookie: string) => {
      const answer = await rt.fetch(post("https://app.example/connect", undefined, cookie));
      return answer.status === 200 ? (await answer.json()).actor : answer.status;
    };
    // A preview's page script sets `session=…; domain=example` in the browser: the plain name
    // isn't read where cookies are `__Host-`.
    assertEquals(await connect(`session=${session}`), 401);
    // The host's own cookie, which only it can set, is who it says.
    assertEquals(await connect(`__Host-session=${session}`), { kind: "person", id: "mallory" });
    // Over plain http to this machine, the plain name is the host's.
    const here = await rt.fetch(
      post("http://localhost:8790/connect", undefined, `session=${session}`),
    );
    assertEquals((await here.json()).actor, { kind: "person", id: "mallory" });
  } finally {
    await rt.close();
  }
});

test("the page says its language: English unless the app says (lang)", async () => {
  const pageIn = async (lang?: string) => {
    const rt = await createRuntime({
      store: memoryStore(),
      plugins: [webPage, settings(lang ? { lang } : {})],
    });
    try {
      return await (await rt.fetch(new Request("http://localhost/"))).text();
    } finally {
      await rt.close();
    }
  };
  assert((await pageIn()).includes('<html lang="en">'));
  assert((await pageIn("pt-BR")).includes('<html lang="pt-BR">'));
});
