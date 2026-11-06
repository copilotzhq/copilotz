/**
 * Routes by host, through `runtime.fetch`: a request to a host a route takes
 * is that route's, every path of it (the app's page, code and socket aren't
 * there); a pattern's named label takes one label, a wildcard any; the host
 * is the front's word for it only when the front vouches with its secret.
 */
import { assert, assertEquals } from "@std/assert";
import { createRuntime, definePlugin, type Plugins, type Route } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { webPage } from "../server.ts";

const FRONT = "front-secret-0123456789abcdef";

/** Says which route answered, for which host and path. */
const said = (name: string): Route => (request, { params }) => {
  const url = new URL(request.url);
  return Response.json({ route: name, host: url.host, path: url.pathname, label: params.label });
};

const sites = definePlugin({
  name: "sites",
  routes: {
    "*://docs.example.test/*": said("docs"),
    // One label before `-preview`; the wildcard takes any number.
    "*://:label-preview.preview.test/*": said("previews"),
    "*://*.localhost:8000/*": said("local"),
    "*://api.example.test/*": (request) =>
      Response.json({
        path: new URL(request.url).pathname,
        forwarded: request.headers.get("x-forwarded-host"),
      }),
    "/hook": said("hook"),
    "/headers": (request) => Response.json([...request.headers.keys()]),
  },
});

const app = definePlugin({
  name: "settings",
  resources: {
    page: { code: { entry: "app.js", files: { "app.js": "// the app" } } },
    caller: { front: FRONT },
  },
});

async function setup(
  plugins: Plugins,
  fn: (serve: (r: Request) => Promise<Response>) => Promise<void>,
  options: { front?: boolean } = {},
) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      webPage,
      options.front === false
        ? definePlugin({
          name: "settings",
          resources: { page: { code: { entry: "app.js", files: { "app.js": "" } } } },
        })
        : app,
      ...plugins,
    ],
  });
  try {
    await fn((request) => rt.fetch(request));
  } finally {
    await rt.close();
  }
}

test("a host's route takes every path there, never the app's page, code, files or socket", async () => {
  await setup([sites], async (serve) => {
    for (const path of ["/", "/app/app.js", "/oxian", "/assets/copilotz/icon.svg", "/files/f1"]) {
      const answered = await serve(new Request(`http://abc123-preview.preview.test${path}`));
      assertEquals(await answered.json(), {
        route: "previews",
        host: "abc123-preview.preview.test",
        path,
        label: "abc123",
      });
    }
    const docs = await serve(new Request("http://docs.example.test/signin", { method: "POST" }));
    assertEquals((await docs.json()).route, "docs");
    // Ports, only when the pattern says.
    assertEquals(
      (await (await serve(new Request("http://x.localhost:8000/"))).json()).route,
      "local",
    );
    const other = await serve(new Request("http://x.localhost:9000/"));
    assertEquals(other.headers.get("content-type"), "text/html; charset=utf-8");
    await other.body?.cancel();
    // A pattern's named label is one label.
    const deeper = await serve(new Request("http://a.b-preview.preview.test/"));
    assertEquals(deeper.headers.get("content-type"), "text/html; charset=utf-8");
    await deeper.body?.cancel();
    const bare = await serve(new Request("http://-preview.preview.test/"));
    assertEquals(bare.headers.get("content-type"), "text/html; charset=utf-8");
    await bare.body?.cancel();
    // An exact host is only that host.
    const sub = await serve(new Request("http://x.docs.example.test/"));
    assertEquals(sub.headers.get("content-type"), "text/html; charset=utf-8");
    await sub.body?.cancel();
    // Other hosts are the app's, by path as ever: the page, and plugins' paths.
    assertEquals((await (await serve(new Request("http://localhost/hook"))).json()).path, "/hook");
    const socket = await serve(new Request("http://localhost/oxian"));
    assert(socket.status !== 200 || !(await socket.text()).includes('"route"'));
  });
});

test("the front's forwarded host counts only with its secret", async () => {
  const forwarded = (headers: Record<string, string>, path = "/a") =>
    new Request(`https://app-xyz.run.test${path}`, {
      headers: { "x-forwarded-host": "abc123-preview.preview.test", ...headers },
    });
  await setup([sites], async (serve) => {
    const vouched = await serve(forwarded({ "x-copilotz-front": FRONT }));
    assertEquals(await vouched.json(), {
      route: "previews",
      host: "abc123-preview.preview.test",
      path: "/a",
      label: "abc123",
    });
    // A route sees the request as the front sent it, its header too: what plugins that count
    // callers by address go by (`callerFrom`). One passing a request on drops it (previews).
    const seen = await serve(
      new Request("https://app-xyz.run.test/headers", {
        headers: { "x-copilotz-front": FRONT, "x-forwarded-host": "app.test" },
      }),
    );
    const names = await seen.json();
    assertEquals([names.includes("x-copilotz-front"), names.includes("x-forwarded-host")], [
      true,
      true,
    ]);
    // Without the secret (or with another), forwarded headers are anyone's: ignored.
    for (const headers of [{}, { "x-copilotz-front": "guess" }] as Record<string, string>[]) {
      const page = await serve(forwarded(headers));
      assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
      await page.body?.cancel();
    }
  });
  // An app with no front trusts no forwarded host, whatever it carries.
  await setup([sites], async (serve) => {
    const page = await serve(forwarded({ "x-copilotz-front": FRONT }));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    await page.body?.cancel();
  }, { front: false });
});

test("a route by host must be a whole URL pattern, or the start fails", async () => {
  const bad = definePlugin({ name: "bad", routes: { "docs.example.test": said("bad") } });
  let refused = "";
  await setup([bad], () => Promise.resolve()).catch((error) => refused = error.message);
  assert(refused.includes("pathname"), refused);
});
