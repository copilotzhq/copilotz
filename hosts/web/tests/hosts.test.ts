/**
 * Routes by host: a request to a host a route takes is that route's, every
 * path of it (the app's page, code and socket aren't there); patterns take
 * one first label; the host is the front's word for it only when the front
 * vouches with its secret; a route's host may come from the app's settings.
 */
import { assert, assertEquals } from "@std/assert";
import {
  createRuntime,
  defineAction,
  definePlugin,
  type Plugins,
  type Resources,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets } from "../tickets.ts";
import { hostMatches, hostOf, httpRequest, type Served, webServer } from "../server.ts";

const said = (name: string) => (request: Request, served: Served) =>
  Response.json({ route: name, host: served.host, path: new URL(request.url).pathname });

const sites = definePlugin({
  name: "sites",
  actions: {
    "sites.echo": defineAction({
      input: httpRequest,
      allow: () => true,
      run: (_ctx, input) => ({ body: { path: input.path, headers: input.headers } }),
    }),
  },
  resources: {
    sites: { domain: "preview.test" },
    routes: {
      docs: { host: "docs.example.test", serve: said("docs") },
      previews: {
        // From the app's settings: a pattern, or no route at all.
        host: (resources: Resources) => `*-preview.${resources.sites.domain}`,
        serve: said("previews"),
      },
      none: { host: () => undefined, serve: said("none") },
      local: { host: "*.localhost:8000", serve: said("local") },
      api: { host: "api.example.test", action: "sites.echo" },
      hook: { path: "/hook", action: "sites.echo" },
    },
  },
});

async function setup(
  plugins: Plugins,
  fn: (serve: (r: Request) => Promise<Response>) => Promise<void>,
  front?: { secret: string },
) {
  const rt = await createRuntime({ store: memoryStore(), plugins: [identity, ...plugins] });
  try {
    await fn(webServer({
      runtime: rt,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "// the app" } },
      upgrade: () => new Response("the app's socket", { status: 299 }),
      ...(front ? { front } : {}),
    }));
  } finally {
    await rt.close();
  }
}

test("hosts match exactly, or by a pattern's one first label; ports only when the pattern says", () => {
  assert(hostMatches("docs.example.test", "docs.example.test"));
  assert(hostMatches("docs.example.test", "docs.example.test:8443"));
  assert(!hostMatches("docs.example.test", "x.docs.example.test"));
  assert(hostMatches("*-preview.copilotz.app", "abc123-preview.copilotz.app"));
  assert(!hostMatches("*-preview.copilotz.app", "a.b-preview.copilotz.app"));
  assert(!hostMatches("*-preview.copilotz.app", "-preview.copilotz.app"));
  assert(!hostMatches("*-preview.copilotz.app", "abc-preview.copilotz.app.evil.test"));
  assert(hostMatches("*.localhost:8000", "a.localhost:8000"));
  assert(!hostMatches("*.localhost:8000", "a.localhost:9000"));
  assertEquals(hostOf(new Request("http://Docs.Example.test/x")), "docs.example.test");
});

test("a host's route takes every path there, never the app's page, code, files or socket", async () => {
  await setup([sites], async (serve) => {
    for (const path of ["/", "/app/app.js", "/oxian", "/assets/copilotz/icon.svg", "/files/f1"]) {
      const answered = await serve(new Request(`http://abc123-preview.preview.test${path}`));
      assertEquals(await answered.json(), {
        route: "previews",
        host: "abc123-preview.preview.test",
        path,
      });
    }
    const docs = await serve(new Request("http://docs.example.test/signin", { method: "POST" }));
    assertEquals((await docs.json()).route, "docs");
    assertEquals(
      (await (await serve(new Request("http://x.localhost:8000/")).then((r) => r.json()))).route,
      "local",
    );
    // An Action by host, as an Action by path is.
    const api = await serve(new Request("http://api.example.test/v1/things"));
    assertEquals((await api.json()).path, "/v1/things");
    // Other hosts are the app's, by path as ever: the page, and plugins' paths.
    const page = await serve(new Request("http://a.b-preview.preview.test/"));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    assertEquals((await serve(new Request("http://localhost/oxian"))).status, 299);
    assertEquals((await serve(new Request("http://x.localhost:9000/oxian"))).status, 299);
    assertEquals((await (await serve(new Request("http://localhost/hook"))).json()).path, "/hook");
  });
});

test("the front's forwarded host counts only with its secret, and its secret reaches no plugin", async () => {
  const front = { secret: "front-secret" };
  const forwarded = (headers: Record<string, string>, path = "/a") =>
    new Request(`https://app-xyz.run.test${path}`, {
      headers: { "x-forwarded-host": "abc123-preview.preview.test", ...headers },
    });
  await setup([sites], async (serve) => {
    const vouched = await serve(forwarded({ "x-copilotz-front": "front-secret" }));
    assertEquals(await vouched.json(), {
      route: "previews",
      host: "abc123-preview.preview.test",
      path: "/a",
    });
    // Without the secret (or with another), forwarded headers are anyone's: ignored.
    for (const headers of [{}, { "x-copilotz-front": "guess" }] as Record<string, string>[]) {
      const page = await serve(forwarded(headers));
      assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    }
    // An Action never sees the front's secret.
    const hook = await serve(
      new Request("https://app-xyz.run.test/hook", {
        headers: { "x-copilotz-front": "front-secret", "x-forwarded-host": "app.test" },
      }),
    );
    const { headers } = await hook.json();
    assertEquals([headers["x-copilotz-front"], headers["x-forwarded-host"]], [
      undefined,
      "app.test",
    ]);
  }, front);
  // A web host with no front trusts no forwarded host, whatever it carries.
  await setup([sites], async (serve) => {
    const page = await serve(forwarded({ "x-copilotz-front": "front-secret" }));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
  });
});

test("a route by host must name a host or a pattern", async () => {
  const bad = definePlugin({
    name: "bad",
    resources: { routes: { wild: { host: "*", serve: said("wild") } } },
  });
  let refused = "";
  await setup([bad], () => Promise.resolve()).catch((error) => refused = error.message);
  assert(refused.includes("isn't a host"), refused);
});
