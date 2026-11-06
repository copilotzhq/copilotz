/**
 * Plugins' routes, through `runtime.fetch`: a route answers as whoever its
 * session signs in or an anonymous browser; the more specific path wins and
 * the page's `/*` is last; the runtime's own paths can't be taken; failures
 * say only what they should; a body past the most a route takes is refused as
 * soon as it's known, never read whole. Without the web page, routes are all
 * there is, and `/health`.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  bodyOf,
  createRuntime,
  definePlugin,
  failure,
  type Plugins,
  type Route,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { devSignIn, identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { webPage } from "../server.ts";

const MB = 1024 * 1024;

/** The request as a route sees it, and who it is. */
const echo: Route = async (request, { actor, params }) => {
  const url = new URL(request.url);
  const body = await bodyOf(request, 10 * MB);
  if (!body) return new Response("Too large", { status: 413 });
  const text = new TextDecoder().decode(body);
  const json = request.headers.get("content-type")?.includes("json");
  return Response.json({
    who: actor.kind,
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    params,
    body: json || !request.headers.get("content-type")?.includes("octet-stream")
      ? text
      : btoa(String.fromCharCode(...body)),
    signed: request.headers.get("x-sig"),
  }, { status: 201 });
};

const hooks = definePlugin({
  name: "hooks",
  routes: {
    "/hooks/echo": echo,
    "/hooks/:name": (_request, { params }) => new Response(`param ${params.name}`),
    "/hooks/*": () => new Response("ok"),
    "/hooks/back": () => Response.redirect("http://localhost/home", 302),
    "/download/*": (request) => new Response(`file ${new URL(request.url).pathname}`),
    "/people": (_request, { actor }) => {
      if (actor.kind !== "person") {
        throw failure("unauthorized", "Sign in first.", { public: true });
      }
      return Response.json({ person: actor.id });
    },
    "/broken": () => {
      throw new Error("secret internals");
    },
    // A refusal: coded, its words for anyone only when it says so.
    "/refuse": (request) => {
      const open = new URL(request.url).searchParams.has("open");
      throw failure(
        "forbidden",
        open ? "Sign the request first." : "key sk-live-123 is for org-ACME only",
        { public: open },
      );
    },
  },
});

const page = definePlugin({
  name: "settings",
  resources: { page: { code: { entry: "app.js", files: { "app.js": "" } } } },
});

async function setup(
  plugins: Plugins,
  fn: (serve: (r: Request) => Promise<Response>) => Promise<void>,
) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [identity, devSignIn, webPage, page, ...plugins],
  });
  try {
    await fn((request) => rt.fetch(request));
  } finally {
    await rt.close();
  }
}

test("a route answers the request, as anonymous when nobody's signed in", async () => {
  await setup([hooks], async (serve) => {
    const answered = await serve(
      new Request("http://localhost/hooks/echo?a=1&b=2", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sig": "abc", cookie: "other=1" },
        body: JSON.stringify({ hello: "there" }),
      }),
    );
    assertEquals(answered.status, 201);
    assertEquals(await answered.json(), {
      who: "anonymous",
      method: "POST",
      path: "/hooks/echo",
      query: { a: "1", b: "2" },
      params: {},
      body: '{"hello":"there"}',
      signed: "abc",
    });
    // Bytes are the route's to read as it likes.
    const bytes = await serve(
      new Request("http://localhost/hooks/echo", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 255, 7]),
      }),
    );
    assertEquals((await bytes.json()).body, btoa(String.fromCharCode(0, 255, 7)));
  });
});

test("the signed-in person calls; a route that won't take anonymous refuses them", async () => {
  await setup([hooks], async (serve) => {
    const refused = await serve(new Request("http://localhost/people"));
    assertEquals([refused.status, await refused.json()], [401, { error: "Sign in first." }]);
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
    const people = await serve(new Request("http://localhost/people", { headers: { cookie } }));
    assertEquals(await people.json(), { person: "ana" });
  });
});

test("the most specific path wins, the page's /* is last, and redirects, text and files answer", async () => {
  await setup([hooks], async (serve) => {
    // A literal before a parameter before a wildcard.
    assertEquals(
      await (await serve(new Request("http://localhost/hooks/other"))).text(),
      "param other",
    );
    assertEquals(await (await serve(new Request("http://localhost/hooks/a/b"))).text(), "ok");
    const echoed = await serve(new Request("http://localhost/hooks/echo", { method: "POST" }));
    assertEquals((await echoed.json()).path, "/hooks/echo");
    const back = await serve(new Request("http://localhost/hooks/back"));
    assertEquals([back.status, back.headers.get("location")], [302, "http://localhost/home"]);
    assertEquals(
      await (await serve(new Request("http://localhost/download/a.zip"))).text(),
      "file /download/a.zip",
    );
    // Not a route: the page, as before.
    const thread = await serve(new Request("http://localhost/thread/t1"));
    assertEquals(thread.headers.get("content-type"), "text/html; charset=utf-8");
    await thread.body?.cancel();
  });
});

test("a failure says its code's status, and nothing of its internals", async () => {
  const logged = console.error;
  console.error = () => {};
  try {
    await setup([hooks], async (serve) => {
      const broken = await serve(new Request("http://localhost/broken"));
      assertEquals([broken.status, await broken.json()], [500, { error: "Something went wrong" }]);
      // A refusal answers its code's status, and its own words only when they're for anyone.
      const refused = await serve(new Request("http://localhost/refuse"));
      assertEquals([refused.status, await refused.json()], [403, {
        error: "Something went wrong",
      }]);
      const told = await serve(new Request("http://localhost/refuse?open=1"));
      assertEquals([told.status, await told.json()], [403, { error: "Sign the request first." }]);
    });
  } finally {
    console.error = logged;
  }
});

test("a body past 10 MB is refused as soon as it's known, and no more of it is read", async () => {
  await setup([hooks], async (serve) => {
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

test("the runtime's own paths can't be taken", async () => {
  for (const path of ["/connect", "/oxian"]) {
    const taken = definePlugin({ name: "taken", routes: { [path]: () => new Response("") } });
    await assertRejects(
      () => setup([taken], () => Promise.resolve()),
      Error,
      "the runtime's own path",
    );
  }
});

test("without the web page: the routes, /health unless a route takes it, and 404", async () => {
  const preview = definePlugin({
    name: "preview",
    routes: { "*://*-preview.example.com/*": () => new Response("the preview") },
  });
  const health = definePlugin({
    name: "health",
    routes: { "/health": () => new Response("mine") },
  });
  const rt = await createRuntime({ store: memoryStore(), plugins: [hooks, preview] });
  const own = await createRuntime({ store: memoryStore(), plugins: [health] });
  try {
    const text = async (url: string, init?: RequestInit) => {
      const answered = await rt.fetch(new Request(url, init));
      return [answered.status, await answered.text()];
    };
    const echoed = await rt.fetch(new Request("http://localhost/hooks/echo", { method: "POST" }));
    assertEquals([echoed.status, (await echoed.json()).who], [201, "anonymous"]);
    assertEquals(await text("http://localhost/download/a.zip"), [200, "file /download/a.zip"]);
    assertEquals(await text("http://localhost/health"), [200, "ok"]);
    assertEquals(await text("http://localhost/health", { method: "POST" }), [404, "Not found"]);
    assertEquals(await text("http://localhost/"), [404, "Not found"]);
    assertEquals(await text("http://localhost/app/app.js"), [404, "Not found"]);
    // A host a route takes is all its own, /health too.
    assertEquals(await text("http://ab1-preview.example.com/health"), [200, "the preview"]);
    assertEquals(
      await (await own.fetch(new Request("http://localhost/health"))).text(),
      "mine",
    );
  } finally {
    await rt.close();
    await own.close();
  }
});
