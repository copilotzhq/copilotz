/**
 * The app, installable: its manifest comes from the theme (name, colours,
 * icons drawn from its mark), its service worker carries the code's version
 * (a new version, a new worker) and only ever handles the page, the code and
 * the host's own files, and the page links them. The icons are drawn from
 * the mark's paths without an image library: real PNGs, the mark where it
 * should be. And the browser's orgs: a server with many answers them, one
 * with one org answers none.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets } from "../tickets.ts";
import { webServer } from "../server.ts";
import { manifestOf, precacheOf, versionOf, workerOf } from "../pwa.ts";
import { themeOf } from "../theme/css.ts";
import { coverage, iconPng, outlines, rgbaOf } from "../theme/png.ts";
import { asStaff, currentOrg, loadOrgs, orgName, type Orgs, refreshOrgs } from "../orgs.ts";

const brand = definePlugin({
  name: "brand",
  resources: {
    theme: {
      light: { background: "#fafaf9", foreground: "#1c1917" },
      logo: {
        mark: { viewBox: "0 0 24 24", paths: [{ d: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z" }] },
      },
    },
  },
});

test("the manifest: the app's name, its colours and its icons, from the theme", () => {
  const manifest = manifestOf(themeOf([brand]), "Harbor Desk");
  assertEquals(
    [manifest.name, manifest.short_name, manifest.start_url, manifest.display],
    ["Harbor Desk", "Harbor Desk", "/", "standalone"],
  );
  assertEquals([manifest.background_color, manifest.theme_color], ["#fafaf9", "#fafaf9"]);
  assertEquals(manifest.icons.map((i) => [i.sizes, i.purpose]), [
    ["192x192", "any"],
    ["512x512", "any"],
    ["512x512", "maskable"],
    ["any", "any"],
  ]);
  // A mark that's an image file is the icon as it is, with the theme's PNG.
  const image = definePlugin({
    name: "image",
    resources: {
      theme: { logo: { mark: "/assets/brand/mark.svg", icon: "/assets/brand/icon.png" } },
    },
  });
  assertEquals(manifestOf(themeOf([image])).icons.map((i) => i.src), [
    "/assets/brand/mark.svg",
    "/assets/brand/icon.png",
  ]);
});

test("the worker carries the code's version, and handles only pages, code and host files", async () => {
  const one = await versionOf({ "app.js": "a", "chunk-1.js": "b" });
  assertEquals(one, await versionOf({ "chunk-1.js": "b", "app.js": "a" }));
  assert(one !== await versionOf({ "app.js": "a", "chunk-1.js": "c" }));
  const theme = themeOf([]);
  const script = workerOf({
    version: one,
    code: "/app/",
    entry: "app.js",
    precache: ["/app/app.js", ...precacheOf(theme)],
    theme,
    title: "A <b>app</b>",
  });
  assertMatch(script, new RegExp(`"version":"${one}"`));
  assertMatch(script, /"entry":"\/app\/app.js"/);
  assertMatch(script, /request\.method !== "GET"/);
  assertMatch(script, /url\.origin !== self\.location\.origin/);
  assert(!script.includes("<b>"), "nothing in it ends the script or opens a tag");
  assert(precacheOf(theme).includes("/assets/copilotz/fonts.css"));
  // It runs: its handlers register.
  const heard: string[] = [];
  new Function("self", "caches", script)({
    addEventListener: (type: string) => heard.push(type),
    location: { origin: "http://x" },
  }, {});
  assertEquals(heard.sort(), ["activate", "fetch", "install", "message"]);
});

test("the server: the manifest, the worker at the root, and the page linking them", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [identity] });
  try {
    const serve = webServer({
      runtime,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "1" } },
      upgrade: () => new Response(null),
      title: "Test",
      theme: themeOf([]),
    });
    const manifest = await serve(new Request("http://localhost/manifest.webmanifest"));
    assertMatch(manifest.headers.get("content-type")!, /application\/manifest\+json/);
    assertEquals((await manifest.json()).name, "Test");
    const worker = await serve(new Request("http://localhost/sw.js"));
    assertEquals(worker.headers.get("service-worker-allowed"), "/");
    assertEquals(worker.headers.get("cache-control"), "no-cache");
    assertMatch(await worker.text(), /copilotz-/);
    const page = await (await serve(new Request("http://localhost/"))).text();
    assertMatch(page, /<link rel="manifest" href="\/manifest.webmanifest">/);
    assertMatch(page, /<meta name="apple-mobile-web-app-title" content="Test">/);
    for (const size of ["192", "512"]) {
      const icon = await serve(new Request(`http://localhost/assets/copilotz/icon-${size}.png`));
      assertEquals(icon.headers.get("content-type"), "image/png");
      const bytes = new Uint8Array(await icon.arrayBuffer());
      assertEquals(new DataView(bytes.buffer).getUint32(16), Number(size));
    }
  } finally {
    await runtime.close();
  }
});

test("icons are drawn from the mark's paths: a PNG, the mark in its middle", async () => {
  const png = (await iconPng(themeOf([brand]), 64, "maskable"))!;
  assertEquals([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  assertEquals([view.getUint32(16), view.getUint32(20)], [64, 64]);
  // A circle of radius 10 in a box of 24, drawn 48 px wide: about π·10² of its area.
  const shapes = outlines("M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", ([x, y]) => [x * 2, y * 2]);
  const covered = coverage(shapes, 48, 48).reduce((n, c) => n + c, 0);
  assert(Math.abs(covered - Math.PI * 400) < 25, `covered ${covered}`);
  // Relative commands, curves and closing: a 10 by 10 square drawn every way covers 100.
  for (const d of ["M1 1h10v10H1z", "m1 1 10 0 0 10-10 0z", "M1 1L11 1L11 11L1 11Z"]) {
    assert(Math.abs(coverage(outlines(d, (p) => p), 16, 16).reduce((n, c) => n + c, 0) - 100) < 1);
  }
  assertEquals(
    [rgbaOf("#fff"), rgbaOf("#11223380"), rgbaOf("rgb(1 2 3 / 50%)"), rgbaOf("var(--x)")],
    [[255, 255, 255, 255], [17, 34, 51, 128], [1, 2, 3, 128], undefined],
  );
});

test("the browser's orgs: a server with many answers them; one with one org, none", async () => {
  const orgs: Orgs = {
    person: "ana",
    email: "ana@example.com",
    current: "o-1",
    orgs: [{ id: "p-1", name: "ana", kind: "personal" }, { id: "o-1", name: "Acme", kind: "team" }],
    invites: [],
    staff: false,
  };
  const fetched = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.resolve(Response.json(orgs))) as typeof fetch;
    const many = await refreshOrgs();
    assertEquals(many.status === "ready" && many.here?.name, "Acme");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
      )) as typeof fetch;
    assertEquals((await refreshOrgs()).status, "none");
    assertEquals((await loadOrgs()).status, "none");
  } finally {
    globalThis.fetch = fetched;
  }
  assertEquals(currentOrg(orgs)?.id, "o-1");
  assertEquals(orgName(orgs.orgs[0]), "Personal");
  assertEquals(asStaff(orgs), false);
  assertEquals(asStaff({ ...orgs, staff: true, current: "o-9" }), true);
});
