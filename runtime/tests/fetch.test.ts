/**
 * `runtime.fetch`: plugins' routes and the order they're matched in, who a
 * request is (plugins' `who`, in order; anonymous when none says), the
 * cookies routes keep (names, attributes, renaming, one plugin's each), the
 * rule against requests from other sites, the front's host and the app's
 * base, and the runtime's own paths: `POST /connect` and its socket.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Plugin,
  type Route,
  setClientAddress,
} from "../mod.ts";
import { connect } from "../client.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { listen } from "../../hosts/web/node/serve.ts";
import { identity } from "../../plugins/access/identity/mod.ts";
import { devSignIn } from "../../plugins/access/dev/mod.ts";
import { runtime as which, test, testWho, ticketFor } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

/** A route that says what it was given. */
const echo = (name: string): Route => (request, { actor, params }) =>
  Response.json({ name, url: request.url, actor, params });

const runtimeWith = (plugins: Plugin[], options: Parameters<typeof createRuntime>[0] = {
  store: memoryStore(),
  plugins: [],
}) => createRuntime({ ...options, store: options.store ?? memoryStore(), plugins });

const get = async (rt: { fetch(r: Request): Promise<Response> }, url: string, init?: RequestInit) =>
  await rt.fetch(new Request(url, init));

test("routes match the more specific first, a catch-all last, whatever order they're declared", async () => {
  const rt = await runtimeWith([
    definePlugin({
      name: "a",
      routes: {
        "/*": echo("all"),
        "/api/*": echo("api"),
        "/mcp/*": echo("mcp-any"),
        "/mcp/:name": echo("mcp-one"),
      },
    }),
    definePlugin({ name: "b", routes: { "/api/views": echo("views"), "/google": echo("google") } }),
  ]);
  try {
    const name = async (path: string) =>
      (await (await get(rt, `http://localhost${path}`)).json()).name;
    assertEquals(await name("/api/views"), "views");
    assertEquals(await name("/api/actions/x"), "api");
    assertEquals(await name("/mcp/chatgpt"), "mcp-one");
    assertEquals(await name("/mcp/chatgpt/sse"), "mcp-any");
    assertEquals(await name("/google"), "google");
    assertEquals(await name("/anything/else"), "all");
    // A route's parameters, as the path has them.
    const said = await (await get(rt, "http://localhost/mcp/chat%20gpt")).json();
    assertEquals(said.params, { name: "chat%20gpt" });
  } finally {
    await rt.close();
  }
});

test("a later plugin's route replaces one of the same pattern, and null removes it", async () => {
  const rt = await runtimeWith([
    definePlugin({ name: "a", routes: { "/x": echo("a"), "/y": echo("a") } }),
    definePlugin({ name: "b", routes: { "/x": echo("b"), "/y": null } }),
  ]);
  try {
    assertEquals((await (await get(rt, "http://localhost/x")).json()).name, "b");
    const gone = await get(rt, "http://localhost/y");
    assertEquals(gone.status, 404);
    assertEquals(await gone.text(), "Not found");
    // Nothing takes it: a health check.
    assertEquals(await (await get(rt, "http://localhost/health")).text(), "ok");
  } finally {
    await rt.close();
  }
});

test("a route can't take the runtime's own paths, nor be anything but a pattern", async () => {
  await assertRejects(
    () => runtimeWith([definePlugin({ name: "a", routes: { "/connect": echo("x") } })]),
    Error,
    "the runtime's own path",
  );
  await assertRejects(
    () => runtimeWith([definePlugin({ name: "a", routes: { "hooks": echo("x") } })]),
    Error,
    "a pathname",
  );
});

test("a route by host takes every path there, before anything else", async () => {
  const rt = await runtimeWith([
    definePlugin({
      name: "previews",
      routes: { "*://*-preview.example.com/*": echo("preview"), "/*": echo("page") },
    }),
  ]);
  try {
    const at = async (url: string) => (await (await get(rt, url)).json()).name;
    assertEquals(await at("https://abc-preview.example.com/connect"), "preview");
    assertEquals(await at("https://abc-preview.example.com/"), "preview");
    assertEquals(await at("https://app.example.com/"), "page");
    // A POST from another site still reaches it: it isn't the app's site.
    const posted = await get(rt, "https://abc-preview.example.com/form", {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
    });
    assertEquals(posted.status, 200);
  } finally {
    await rt.close();
  }
});

test("the app's own hosts: any other is host routes' alone, and the app's own never are", async () => {
  const routes = {
    "/x": echo("x"),
    "*://*.sites.test:*/*": echo("site"),
    "*://*:*/*": echo("others"),
  };
  const rt = await runtimeWith([
    definePlugin({ name: "app", routes }),
    definePlugin({
      name: "settings",
      resources: { hosts: { own: ["app.test", "*.run.test", "own.sites.test"] } },
    }),
  ]);
  try {
    const at = async (url: string, init?: RequestInit) => {
      const answer = await get(rt, url, init);
      return answer.headers.get("content-type")?.includes("json")
        ? (await answer.json()).name
        : answer.status;
    };
    // The app's own: its paths, never a host route, whatever they'd match.
    assertEquals(await at("http://app.test/x"), "x");
    assertEquals(await at("https://api.run.test:8443/x"), "x");
    assertEquals(await at("https://own.sites.test/x"), "x");
    assertEquals(await at("http://a.b.run.test/x"), "others");
    // Any other: its host routes alone, the runtime's own paths too; one for every other host last.
    assertEquals(await at("https://shop.sites.test/x"), "site");
    assertEquals(await at("https://shop.sites.test/connect", { method: "POST" }), "site");
    assertEquals(await at("https://shop.sites.test/oxian"), "site");
    assertEquals(await at("https://elsewhere.test/health"), "others");
    // Behind the front, the host it says.
    const behind = await runtimeWith([
      definePlugin({ name: "app", routes: { "/x": echo("x") } }),
      definePlugin({
        name: "settings",
        resources: {
          hosts: { own: ["app.test"] },
          caller: { header: "cf-connecting-ip", front: "the-front-secret-0123" },
        },
      }),
    ]);
    try {
      const fronted = (host: string, secret?: string) =>
        get(behind, "http://10.0.0.5:8080/x", {
          headers: { "x-forwarded-host": host, ...(secret ? { "x-copilotz-front": secret } : {}) },
        });
      assertEquals((await fronted("app.test", "the-front-secret-0123")).status, 200);
      // Nobody's host: a 404, never the app's paths, nor its socket or `/connect`, nor /health.
      assertEquals((await fronted("evil.test", "the-front-secret-0123")).status, 404);
      for (const path of ["/connect", "/oxian", "/health"]) {
        const answer = await get(behind, `http://evil.test${path}`, {
          method: path === "/connect" ? "POST" : "GET",
        });
        assertEquals(answer.status, 404, path);
      }
      // Without the front's secret, its word is no one's: the host it came to (not one of the app's).
      assertEquals((await fronted("app.test")).status, 404);
    } finally {
      await behind.close();
    }
  } finally {
    await rt.close();
  }
});

test("without the app's own hosts named, every host is the app's: a route for every other takes none", async () => {
  const rt = await runtimeWith([
    definePlugin({
      name: "app",
      routes: {
        "/x": echo("x"),
        "*://*.sites.test:*/*": echo("site"),
        "*://*:*/*": echo("others"),
      },
    }),
  ]);
  try {
    const at = async (url: string) => (await (await get(rt, url)).json()).name;
    assertEquals(await at("http://app.test/x"), "x");
    assertEquals(await at("http://elsewhere.test/x"), "x");
    // A host route still takes the hosts it names.
    assertEquals(await at("http://shop.sites.test/x"), "site");
  } finally {
    await rt.close();
  }
  for (const own of [[], ["https://app.test"], ["app test"], "app.test"]) {
    await assertRejects(
      () => runtimeWith([definePlugin({ name: "s", resources: { hosts: { own } } })]),
      Error,
      "hosts.own",
    );
  }
});

test("who: the first plugin that answers, in plugin order; anonymous when none does", async () => {
  const asked: string[] = [];
  const header = (name: string, kind: string): Plugin =>
    definePlugin({
      name,
      who: (request) => {
        asked.push(name);
        const id = request.headers.get(`x-${name}`);
        return id ? { kind, id } : null;
      },
    });
  const rt = await runtimeWith([
    header("first", "person"),
    header("second", "contact"),
    definePlugin({ name: "app", routes: { "/me": echo("me") } }),
  ]);
  try {
    const actor = async (headers: Record<string, string>) =>
      (await (await get(rt, "http://localhost/me", { headers })).json()).actor;
    assertEquals(await actor({ "x-first": "ana", "x-second": "c1" }), {
      kind: "person",
      id: "ana",
    });
    assertEquals(await actor({ "x-second": "c1" }), { kind: "contact", id: "c1" });
    asked.length = 0;
    assertEquals(await actor({}), { kind: "anonymous", id: "" });
    assertEquals(asked, ["first", "second"]);
  } finally {
    await rt.close();
  }
});

test("who's queries are kept a moment, and dropped when the actor is disconnected", async () => {
  let runs = 0;
  const rt = await runtimeWith([
    definePlugin({
      name: "keys",
      collections: {
        keyring: {
          schema: { type: "object" },
          queries: {
            actor: (_c, params: { secret: string }) => {
              runs++;
              return params.secret === "s3cr3t-s3cr3t-s3cr3t" ? ana : null;
            },
          },
        },
      },
      who: (request, { query }) => {
        const secret = request.headers.get("x-key");
        return secret ? query<Actor | null>("keyring.actor", { secret }) : null;
      },
      routes: { "/me": echo("me") },
    }),
  ]);
  try {
    const me = () =>
      get(rt, "http://localhost/me", { headers: { "x-key": "s3cr3t-s3cr3t-s3cr3t" } });
    for (let i = 0; i < 3; i++) assertEquals((await (await me()).json()).actor, ana);
    assertEquals(runs, 1);
    // A request with no credential asks nothing.
    await get(rt, "http://localhost/me");
    assertEquals(runs, 1);
    rt.disconnect(ana);
    await me();
    assertEquals(runs, 2);
  } finally {
    await rt.close();
  }
});

/** A plugin whose routes set, clear and read a cookie. */
const jar = (name: string, cookie = "session"): Plugin =>
  definePlugin({
    name,
    routes: {
      [`/${name}/set`]: (request, { cookies }) => {
        const sameSite = new URL(request.url).searchParams.get("strict") ? "strict" : undefined;
        cookies.set(cookie, "a-secret-of-sixteen", sameSite ? { sameSite, days: 1 } : {});
        return Response.json({}, { headers: { "cache-control": "public, max-age=60" } });
      },
      [`/${name}/clear`]: (_r, { cookies }) => {
        cookies.clear(cookie);
        return new Response(null, { status: 204 });
      },
      [`/${name}/bad`]: (_r, { cookies }) => {
        cookies.set(cookie, "not; a value");
        return new Response("never");
      },
      [`/${name}/get`]: (_r, { cookies }) => Response.json({ held: cookies.get(cookie) ?? null }),
    },
  });

test("cookies: __Host- wherever they're Secure, the plain name over http nearby", async () => {
  const rt = await runtimeWith([jar("a")]);
  try {
    const set = async (url: string) => (await get(rt, url)).headers.get("set-cookie");
    assertEquals(
      await set("https://app.example.com/a/set"),
      "__Host-session=a-secret-of-sixteen; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure",
    );
    // Plain http somewhere public is still Secure: the browser asked over https, or drops it.
    assertMatch((await set("http://app.example.com/a/set"))!, /^__Host-session=.*; Secure$/);
    assertEquals(
      await set("http://localhost:8080/a/set"),
      "session=a-secret-of-sixteen; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
    );
    assertMatch((await set("http://192.168.1.20/a/set"))!, /^session=[^;]+; HttpOnly; .*\d$/);
    assertMatch(
      (await set("http://localhost/a/set?strict=1"))!,
      /SameSite=Strict; Path=\/; Max-Age=86400$/,
    );
    // Never kept, whatever the route said.
    const response = await get(rt, "https://app.example.com/a/set");
    assertEquals(response.headers.get("cache-control"), "no-store");
    // Cleared by the same name and attributes.
    assertEquals(
      (await get(rt, "https://app.example.com/a/clear")).headers.get("set-cookie"),
      "__Host-session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure",
    );
    // Read by its name here; one unfit for a cookie is none.
    const held = async (url: string, cookie: string) =>
      (await (await get(rt, url, { headers: { cookie } })).json()).held;
    assertEquals(
      await held("https://app.example.com/a/get", "session=x; __Host-session=a-secret-of-sixteen"),
      "a-secret-of-sixteen",
    );
    assertEquals(
      await held("http://localhost/a/get", "session=a-secret-of-sixteen"),
      "a-secret-of-sixteen",
    );
    // A short value is one (which org a browser is in); one with what a cookie can't hold, none.
    assertEquals(await held("http://localhost/a/get", "session=p-1a2b"), "p-1a2b");
    assertEquals(await held("http://localhost/a/get", "session=bad,value"), null);
    // A value unfit for a cookie is the route's mistake: refused, and nothing set.
    const bad = await get(rt, "http://localhost/a/bad");
    assertEquals(bad.status, 500);
    assertEquals(bad.headers.get("set-cookie"), null);
  } finally {
    await rt.close();
  }
});

test("cookies: renamed as the app says, and one plugin's each (or one built on it)", async () => {
  const rt = await runtimeWith([
    jar("a"),
    jar("b", "visitor"),
    jar("c"),
    { ...jar("d"), requires: ["a"] },
    definePlugin({
      name: "settings",
      resources: { cookies: { names: { session: "s_acme" }, suffix: "_acme" } },
    }),
  ]);
  try {
    const name = async (url: string) =>
      (await get(rt, url)).headers.get("set-cookie")?.split("=")[0];
    assertEquals(await name("https://app.example.com/a/set"), "__Host-s_acme");
    assertEquals(await name("https://app.example.com/b/set"), "__Host-visitor_acme");
    assertEquals(await name("http://localhost/b/set"), "visitor_acme");
    // Another plugin setting `session`, which "a" sets: refused, unless it builds on "a".
    const taken = await get(rt, "http://localhost/c/set");
    assertEquals(taken.status, 500);
    assertEquals(taken.headers.get("set-cookie"), null);
    assertEquals(await name("https://app.example.com/d/set"), "__Host-s_acme");
  } finally {
    await rt.close();
  }
});

test("cookies: two plugins built on the same one share its cookie, whichever sets it first", async () => {
  const rt = await runtimeWith([
    definePlugin({ name: "base" }),
    { ...jar("google"), requires: ["base"] },
    { ...jar("dev"), requires: ["base"] },
    jar("other"),
  ]);
  try {
    assertEquals((await get(rt, "http://localhost/dev/set")).status, 200);
    assertEquals((await get(rt, "http://localhost/google/set")).status, 200);
    assertEquals((await get(rt, "http://localhost/google/clear")).status, 204);
    const taken = await get(rt, "http://localhost/other/set");
    assertEquals([taken.status, taken.headers.get("set-cookie")], [500, null]);
  } finally {
    await rt.close();
  }
});

test("a request from another site that may change something is refused, unless it says who it is", async () => {
  const rt = await runtimeWith([definePlugin({ name: "app", routes: { "/do": echo("do") } })]);
  try {
    const post = (headers: Record<string, string>, method = "POST") =>
      get(rt, "https://app.example.com/do", { method, headers });
    assertEquals((await post({})).status, 200, "no Origin: not a browser's (a webhook)");
    assertEquals((await post({ origin: "https://app.example.com" })).status, 200);
    assertEquals((await post({ origin: "https://evil.example" })).status, 403);
    assertEquals((await post({ origin: "https://other.example.com" })).status, 403, "a sibling");
    assertEquals((await post({ origin: "http://app.example.com" })).status, 403, "not https");
    assertEquals((await post({ origin: "null" })).status, 403);
    assertEquals((await post({ "sec-fetch-site": "same-site" })).status, 403);
    assertEquals((await post({ "sec-fetch-site": "cross-site" })).status, 403);
    assertEquals((await post({ "sec-fetch-site": "same-origin" })).status, 200);
    assertEquals((await post({ "sec-fetch-site": "none" })).status, 200);
    assertEquals((await post({ origin: "https://evil.example" }, "DELETE")).status, 403);
    assertEquals((await post({ origin: "https://evil.example" }, "GET")).status, 200);
    assertEquals((await post({ origin: "https://evil.example" }, "OPTIONS")).status, 200);
    assertEquals(
      (await post({ origin: "https://evil.example", authorization: "Bearer k" })).status,
      200,
    );
    // Over http, only this machine or its network is anyone's own.
    const local = await get(rt, "http://localhost:8080/do", {
      method: "POST",
      headers: { origin: "http://localhost:8080" },
    });
    assertEquals(local.status, 200);
    const refused = await post({ origin: "https://evil.example" });
    assertEquals(await refused.json(), { error: "Not from this app's page" });
  } finally {
    await rt.close();
  }
});

test("the front's host is believed only with its secret, and the app's base is stripped", async () => {
  const secret = "front-secret-0123456789";
  const rt = await runtimeWith([
    definePlugin({ name: "app", routes: { "/x": echo("x") } }),
    definePlugin({
      name: "settings",
      resources: {
        caller: { header: "cf-connecting-ip", front: secret },
        page: { base: "/o/acme" },
      },
    }),
  ]);
  try {
    const url = async (path: string, headers: Record<string, string>) =>
      (await (await get(rt, `http://10.0.0.5:8080${path}`, { headers })).json()).url;
    const forwarded = { "x-forwarded-host": "acme.example.com" };
    assertEquals(
      await url("/x", { ...forwarded, "x-copilotz-front": secret }),
      "http://acme.example.com/x",
    );
    assertEquals(await url("/x", forwarded), "http://10.0.0.5:8080/x");
    assertEquals(
      await url("/x", { ...forwarded, "x-copilotz-front": "wrong" }),
      "http://10.0.0.5:8080/x",
    );
    // Under the base, the path within it.
    assertEquals(await url("/o/acme/x?q=1", {}), "http://10.0.0.5:8080/x?q=1");
    // The front's host is the site another site's request is told apart from.
    const posted = await get(rt, "http://10.0.0.5:8080/x", {
      method: "POST",
      headers: { ...forwarded, "x-copilotz-front": secret, origin: "https://acme.example.com" },
    });
    assertEquals(posted.status, 200);
  } finally {
    await rt.close();
  }
});

test("/connect trades who a request is for a one-time ticket, within each actor's minute", async () => {
  const rt = await runtimeWith([testWho], {
    store: memoryStore(),
    plugins: [],
    browsers: { tickets: 2 },
  });
  try {
    const connectAs = (actor?: Actor, method = "POST") =>
      get(rt, "http://localhost/connect", {
        method,
        headers: actor ? { "x-test-actor": JSON.stringify(actor) } : {},
      });
    assertEquals((await connectAs(ana, "GET")).status, 405);
    const nobody = await connectAs();
    assertEquals([nobody.status, await nobody.json()], [401, { error: "Not signed in" }]);
    const first = await connectAs(ana);
    assertEquals(first.headers.get("cache-control"), "no-store");
    const answer = await first.json();
    assertEquals(answer.actor, ana);
    assertMatch(answer.ticket, /^[0-9a-f]{64}$/);
    await connectAs(ana);
    const third = await connectAs(ana);
    assertEquals(third.status, 429);
    assert(Number(third.headers.get("retry-after")) > 0);
    // Someone else has their own minute.
    assertEquals((await connectAs({ kind: "person", id: "bob" })).status, 200);
    // From another site, refused before anyone is asked.
    const elsewhere = await get(rt, "http://localhost/connect", {
      method: "POST",
      headers: { "x-test-actor": JSON.stringify(ana), origin: "https://evil.example" },
    });
    assertEquals(elsewhere.status, 403);
  } finally {
    await rt.close();
  }
});

const echoes = definePlugin({
  name: "echoes",
  actions: { "who.ami": { allow: () => true, run: (ctx) => ({ actor: ctx.actor }) } },
});

test("the socket, through runtime.fetch: a ticket admits its actor once, and under the base too", async () => {
  const rt = await runtimeWith([
    echoes,
    testWho,
    definePlugin({ name: "settings", resources: { page: { base: "/o/acme" } } }),
  ]);
  const listener = await listen(rt.fetch);
  const clients: ReturnType<typeof connect>[] = [];
  try {
    for (const path of ["/oxian", "/o/acme/oxian"]) {
      const client = connect({
        transport: {
          type: "websocket",
          config: { url: `ws://127.0.0.1:${listener.port}${path}`, allowInsecureLoopback: true },
        },
        ticket: () => ticketFor(rt, ana),
        plugins: [],
      });
      clients.push(client);
      await client.ready;
      assertEquals(await client.call("who.ami", {}), { actor: ana });
    }
    // A ticket used, or ended with its actor, lets nobody in.
    const once = await ticketFor(rt, ana);
    const used = connect({
      transport: {
        type: "websocket",
        config: { url: `ws://127.0.0.1:${listener.port}/oxian`, allowInsecureLoopback: true },
      },
      ticket: (() => {
        let given = false;
        return () => {
          if (given) return Promise.reject(new Error("no more"));
          given = true;
          return Promise.resolve(once);
        };
      })(),
      plugins: [],
    });
    clients.push(used);
    await used.ready;
    const ended = await ticketFor(rt, ana);
    rt.disconnect(ana);
    const late = connect({
      transport: {
        type: "websocket",
        config: { url: `ws://127.0.0.1:${listener.port}/oxian`, allowInsecureLoopback: true },
      },
      ticket: (() => {
        let given = false;
        return () => {
          if (given) return Promise.reject(new Error("no more"));
          given = true;
          return Promise.resolve(ended);
        };
      })(),
      plugins: [],
    });
    clients.push(late);
    await assertRejects(() => late.ready);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await listener.shutdown();
    await rt.close();
  }
});

test({
  name: "Deno.serve(runtime.fetch) takes the socket itself",
  ignore: which !== "deno",
  fn: async () => {
    const rt = await runtimeWith([echoes, testWho]);
    // deno-lint-ignore no-explicit-any
    const deno = (globalThis as any).Deno;
    const server = deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, rt.fetch);
    const client = connect({
      transport: {
        type: "websocket",
        config: { url: `ws://127.0.0.1:${server.addr.port}/oxian`, allowInsecureLoopback: true },
      },
      ticket: () => ticketFor(rt, ana),
      plugins: [],
    });
    try {
      await client.ready;
      assertEquals(await client.call("who.ami", {}), { actor: ana });
    } finally {
      await client.close();
      await server.shutdown();
      await rt.close();
    }
  },
});

test("signing in by name on this machine, being someone, and signing out", async () => {
  const rt = await runtimeWith([identity, devSignIn]);
  try {
    const here = (path: string, init: RequestInit = {}) =>
      rt.fetch(setClientAddress(new Request(`http://localhost${path}`, init), "127.0.0.1"));
    // From elsewhere, dev sign-in isn't there at all.
    assertEquals((await get(rt, "http://localhost/signin/dev")).status, 404);
    assertEquals((await here("/signin/dev")).status, 200);
    const signed = await here("/signin/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ana" }),
    });
    assertEquals(await signed.json(), { person: "ana" });
    const cookie = signed.headers.get("set-cookie")!;
    assertMatch(cookie, /^session=[^;]{16,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    const session = cookie.split(";")[0];
    const me = await get(rt, "http://localhost/me", { headers: { cookie: session } });
    assertEquals(await me.json(), { person: "ana", name: "ana" });
    const ticket = await get(rt, "http://localhost/connect", {
      method: "POST",
      headers: { cookie: session },
    });
    assertEquals((await ticket.json()).actor, ana);
    const out = await get(rt, "http://localhost/signout", {
      method: "POST",
      headers: { cookie: session },
    });
    assertEquals(
      out.headers.get("set-cookie"),
      "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    // The session ended: its cookie is no one now.
    const after = await get(rt, "http://localhost/connect", {
      method: "POST",
      headers: { cookie: session },
    });
    assertEquals(after.status, 401);
  } finally {
    await rt.close();
  }
});
