/**
 * Plugins' routes: a request becomes a call to their Action, as whoever its
 * session signs in or a visitor, and its answer becomes the response; a
 * `serve` route answers itself; the more specific path wins; the host's own
 * paths can't be taken; failures say only what they should; a body past the
 * most a route takes is refused as soon as it's known, never read whole.
 * Without the web app (no page's code), routes are all there is, and
 * `/health`.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, definePlugin, type Plugins } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { devSignIn, identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets } from "../tickets.ts";
import { httpRequest, setClientAddress, webServer } from "../server.ts";

const hooks = definePlugin({
  name: "hooks",
  actions: {
    "hooks.echo": defineAction({
      input: httpRequest,
      allow: () => true,
      run: (ctx, input) => ({
        status: 201,
        headers: { "x-who": ctx.actor?.kind ?? "system" },
        body: {
          method: input.method,
          path: input.path,
          query: input.query,
          body: input.body,
          base64: input.base64 ?? false,
          cookie: "cookie" in input.headers,
          signed: input.headers["x-sig"],
        },
      }),
    }),
    "hooks.back": defineAction({
      input: httpRequest,
      allow: () => true,
      run: () => ({ redirect: "/home" }),
    }),
    "hooks.text": defineAction({
      input: httpRequest,
      allow: () => true,
      run: () => ({ body: "ok" }),
    }),
    "hooks.people": defineAction({
      input: httpRequest,
      allow: (actor) => actor.kind === "person",
      run: (ctx) => ({ body: { person: ctx.actor?.id } }),
    }),
    "hooks.broken": defineAction({
      input: httpRequest,
      allow: () => true,
      run: () => {
        throw new Error("secret internals");
      },
    }),
  },
  resources: {
    routes: {
      echo: { path: "/hooks/echo", action: "hooks.echo" },
      under: { path: "/hooks/", action: "hooks.text" },
      back: { path: "/hooks/back", action: "hooks.back", methods: ["GET"] },
      people: { path: "/me", action: "hooks.people" },
      broken: { path: "/broken", action: "hooks.broken" },
      download: {
        path: "/download/",
        serve: (request: Request) => new Response(`file ${new URL(request.url).pathname}`),
      },
    },
  },
});

async function setup(
  plugins: Plugins,
  fn: (serve: (r: Request) => Promise<Response>) => Promise<void>,
) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [identity, devSignIn, ...plugins],
  });
  try {
    const serve = webServer({
      runtime: rt,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response(null, { status: 299 }),
    });
    await fn(serve);
  } finally {
    await rt.close();
  }
}

test("a route's Action answers the request, as a visitor when nobody's signed in", async () => {
  await setup([hooks], async (serve) => {
    const answered = await serve(
      new Request("http://localhost/hooks/echo?a=1&b=2", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sig": "abc", cookie: "other=1" },
        body: JSON.stringify({ hello: "there" }),
      }),
    );
    assertEquals(answered.status, 201);
    assertEquals(answered.headers.get("x-who"), "visitor");
    assertEquals(await answered.json(), {
      method: "POST",
      path: "/hooks/echo",
      query: { a: "1", b: "2" },
      body: '{"hello":"there"}',
      base64: false,
      // The cookie never reaches the Action; who it signs in does.
      cookie: false,
      signed: "abc",
    });
    // Bytes come as base64.
    const bytes = await serve(
      new Request("http://localhost/hooks/echo", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 255, 7]),
      }),
    );
    const sent = await bytes.json();
    assertEquals([sent.body, sent.base64], [btoa(String.fromCharCode(0, 255, 7)), true]);
  });
});

test("the signed-in person calls; an Action that won't take visitors refuses them", async () => {
  await setup([hooks], async (serve) => {
    assertEquals((await serve(new Request("http://localhost/me"))).status, 403);
    // From this machine (a listener says so).
    const signed = await serve(setClientAddress(
      new Request("http://localhost/signin/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ana" }),
      }),
      "127.0.0.1",
    ));
    const cookie = signed.headers.get("set-cookie")!.split(";")[0];
    const me = await serve(new Request("http://localhost/me", { headers: { cookie } }));
    assertEquals(await me.json(), { person: "ana" });
  });
});

test("the longest path wins; methods, redirects, text and files", async () => {
  await setup([hooks], async (serve) => {
    assertEquals(await (await serve(new Request("http://localhost/hooks/other"))).text(), "ok");
    const back = await serve(new Request("http://localhost/hooks/back"));
    assertEquals([back.status, back.headers.get("location")], [302, "/home"]);
    // A POST isn't the redirect's: the prefix route takes it.
    const posted = await serve(new Request("http://localhost/hooks/back", { method: "POST" }));
    assertEquals(await posted.text(), "ok");
    assertEquals(
      await (await serve(new Request("http://localhost/download/a.zip"))).text(),
      "file /download/a.zip",
    );
    // Not a route: the page, as before.
    const page = await serve(new Request("http://localhost/thread/t1"));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
  });
});

test("a failure says its code's status, and nothing of its internals", async () => {
  await setup([hooks], async (serve) => {
    const broken = await serve(new Request("http://localhost/broken"));
    assertEquals([broken.status, await broken.text()], [500, "Something went wrong"]);
  });
});

test("a body past 10 MB is refused as soon as it's known, and no more of it is read", async () => {
  await setup([hooks], async (serve) => {
    const MB = 1024 * 1024;
    // Its length says so: nothing of it is read.
    let pulled = 0;
    const said = await serve(
      new Request("http://localhost/hooks/echo", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(11 * MB) },
        body: new ReadableStream({
          pull: (c) => void (++pulled > 11 ? c.close() : c.enqueue(new Uint8Array(MB))),
        }),
        duplex: "half",
      } as RequestInit),
    );
    assertEquals([said.status, await said.text()], [413, "Too large"]);
    assertEquals(pulled <= 1, true, `read ${pulled} chunks`);
    // Streamed without a length: read up to the most, then let go.
    let sent = 0;
    let cancelled = false;
    const streamed = await serve(
      new Request("http://localhost/hooks/echo", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new ReadableStream({
          pull: (c) => void (++sent > 20 ? c.close() : c.enqueue(new Uint8Array(MB))),
          cancel: () => void (cancelled = true),
        }),
        duplex: "half",
      } as RequestInit),
    );
    assertEquals([streamed.status, await streamed.text()], [413, "Too large"]);
    assertEquals(cancelled, true);
    assertEquals(sent <= 12, true, `read ${sent} chunks of a 20 MB body`);
  });
});

test("the host's own paths can't be taken", async () => {
  const taken = definePlugin({
    name: "taken",
    resources: { routes: { mine: { path: "/files/", serve: () => new Response("") } } },
  });
  await assertRejects(
    () => setup([taken], () => Promise.resolve()),
    Error,
    "is the web host's own",
  );
});

test("without the web app: the routes, /health unless a route takes it, and 404", async () => {
  const preview = definePlugin({
    name: "preview",
    resources: {
      routes: {
        preview: { host: "*-preview.example.com", serve: () => new Response("the preview") },
      },
    },
  });
  const health = definePlugin({
    name: "health",
    resources: { routes: { health: { path: "/health", serve: () => new Response("mine") } } },
  });
  const rt = await createRuntime({ store: memoryStore(), plugins: [hooks, preview] });
  const own = await createRuntime({ store: memoryStore(), plugins: [health] });
  try {
    const serve = webServer({ runtime: rt });
    const text = async (url: string, init?: RequestInit) => {
      const answered = await serve(new Request(url, init));
      return [answered.status, await answered.text()];
    };
    const echoed = await serve(new Request("http://localhost/hooks/echo", { method: "POST" }));
    assertEquals([echoed.status, echoed.headers.get("x-who")], [201, "visitor"]);
    await echoed.body?.cancel();
    assertEquals(await text("http://localhost/download/a.zip"), [200, "file /download/a.zip"]);
    assertEquals(await text("http://localhost/health"), [200, "ok"]);
    assertEquals(await text("http://localhost/health", { method: "POST" }), [404, "Not found"]);
    assertEquals(await text("http://localhost/"), [404, "Not found"]);
    assertEquals(await text("http://localhost/app/app.js"), [404, "Not found"]);
    // A host a route takes is all its own, /health too.
    assertEquals(await text("http://ab1-preview.example.com/health"), [200, "the preview"]);
    assertEquals(
      await (await webServer({ runtime: own })(new Request("http://localhost/health"))).text(),
      "mine",
    );
  } finally {
    await rt.close();
    await own.close();
  }
});
