/**
 * The web host's server half: signing in sets an httpOnly cookie the page's
 * code never sees; the cookie trades for a ticket that admits once; signing
 * out ends the session. Signing in by name is for this machine only. Given
 * the app's theme, the page carries it for its first paint, with its icons,
 * its colour and its fonts (fetched, not waited on). The app's own files are
 * served under /assets/ only, by exact path, typed and cached; the host's
 * own (Copilotz's fonts and icons) under /assets/copilotz/, with no
 * configuration, and nothing from Google.
 */
import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, identity } from "../../../plugins/access/mod.ts";
import { chat } from "../../../plugins/agents/chat/mod.ts";
import models from "../../../plugins/models/mod.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets, type Tickets } from "../tickets.ts";
import { socket, webServer, type WebServerOptions } from "../server.ts";
import { themeOf } from "../theme/css.ts";
import type { Theme } from "../theme/default.ts";

async function setup(
  fn: (
    serve: (request: Request) => Promise<Response>,
    tickets: Tickets,
    rt: Runtime,
  ) => Promise<void>,
  options: { dev?: boolean; theme?: Theme; assets?: WebServerOptions["assets"] } = {},
) {
  const tickets = createTickets();
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity] });
  const serve = webServer({
    runtime: rt,
    tickets,
    code: () => ({
      entry: "app.js",
      files: { "app.js": "import('./math-AB12.js')", "math-AB12.js": "export const m = 1;" },
    }),
    upgrade: () => new Response("upgraded", { status: 299 }),
    title: "Test",
    dev: options.dev ?? true,
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.assets ? { assets: options.assets } : {}),
  });
  try {
    await fn(serve, tickets, rt);
  } finally {
    await rt.close();
  }
}

const post = (url: string, body?: unknown, cookie?: string) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The cookie a response sets, as a browser sends it back. */
const sent = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];

test("a page, its code, and the socket", async () => {
  await setup(async (serve) => {
    const page = await serve(new Request("http://localhost:8790/thread/t1"));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await page.text();
    assertMatch(html, /<title>Test<\/title>/);
    assertMatch(html, /"dev":true/);
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
    assertEquals(
      (await serve(new Request(`http://localhost:8790${socket.config.path}`))).status,
      299,
    );
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
    // Traversal, as a server hands it over: never out of /assets/, never the code.
    await notFound(sentAs("http://localhost:8790/assets/../app/app.js"), "..");
    await notFound(sentAs("http://localhost:8790/assets/%2e%2e/app/app.js"), "%2e%2e");
    await notFound(sentAs("http://localhost:8790/assets/%2E%2E/app/app.js"), "%2E%2E");
    await notFound(sentAs("http://localhost:8790/assets/fonts/../fonts/brand.css"), "../ back in");
    await notFound(sentAs("http://localhost:8790/assets/./fonts/brand.css"), "./");
    await notFound(sentAs("http://localhost:8790/x/../assets/fonts/brand.css"), "into /assets/");
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
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity] });
  const serving = (path: string) => () =>
    webServer({
      runtime: rt,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response(),
      assets: { [path]: "x" },
    });
  try {
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
    ) assertThrows(serving(path), Error, "can't serve", path);
  } finally {
    await rt.close();
  }
});

test("signing in sets a session cookie, traded for a ticket that admits once", async () => {
  await setup(async (serve, tickets) => {
    assertEquals((await serve(post("http://localhost:8790/connect"))).status, 401);
    const signed = await serve(post("http://localhost:8790/signin/dev", { name: "Ana" }));
    assertEquals(await signed.json(), { person: "ana" });
    const cookie = signed.headers.get("set-cookie")!;
    assertMatch(cookie, /^session=ses_[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/);

    const connect = await serve(post("http://localhost:8790/connect", undefined, sent(signed)));
    const { ticket, person } = await connect.json();
    assertEquals(person, "ana");
    assertEquals(tickets.admit(ticket), { kind: "person", id: "ana" } satisfies Actor);
    assertEquals(tickets.admit(ticket), undefined);
  });
});

test("the cookie is Secure anywhere but this machine over http", async () => {
  await setup(async (serve) => {
    const secure = await serve(post("https://localhost:8790/signin/dev", { name: "ana" }));
    assertMatch(secure.headers.get("set-cookie")!, /; Secure$/);
  });
});

test("signing in by name: this machine only, when allowed, with a plain name", async () => {
  await setup(async (serve) => {
    assertEquals((await serve(post("http://app.example/signin/dev", { name: "ana" }))).status, 404);
    const bad = await serve(post("http://localhost:8790/signin/dev", { name: "ana; drop" }));
    assertEquals(bad.status, 400);
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
});

test("a file someone sent: theirs to fetch, in parts, inline or saved; nobody else's", async () => {
  const tickets = createTickets();
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {}, file: {} },
      agents: { lead: { instructions: "Hi.", model: "fake/echo", default: true } },
    },
  });
  const rt = await createRuntime({ store: memoryStore(), plugins: [models, chat, ...access, app] });
  const serve = webServer({
    runtime: rt,
    tickets,
    code: { entry: "app.js", files: { "app.js": "" } },
    upgrade: () => new Response(null, { status: 400 }),
    dev: true,
  });
  const signIn = async (name: string) =>
    sent(await serve(post("http://localhost:8790/signin/dev", { name })));
  const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
    serve(
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
      files: [
        { name: "a b.png", type: "image/png", data: btoa(String.fromCharCode(...bytes)) },
        { name: "page.html", type: "text/html", data: btoa("<script>alert(1)</script>") },
      ],
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
