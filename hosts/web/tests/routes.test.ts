/**
 * Plugins' routes: a request becomes a call to their Action, as whoever its
 * session signs in or a visitor, and its answer becomes the response; a
 * `serve` route answers itself; the more specific path wins; the host's own
 * paths can't be taken; failures say only what they should.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, definePlugin, type Plugins } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets } from "../tickets.ts";
import { httpRequest, webServer } from "../server.ts";

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
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity, ...plugins] });
  try {
    const serve = webServer({
      runtime: rt,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response(null, { status: 299 }),
      dev: true,
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
    const signed = await serve(
      new Request("http://localhost/signin/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ana" }),
      }),
    );
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
