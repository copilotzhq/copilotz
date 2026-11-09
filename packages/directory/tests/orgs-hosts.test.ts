/**
 * Hosts orgs claim, by the directory's routes: an org claims a host for
 * itself (never the app's own, nor another org's), and requests to it are
 * that org's routes by host, every path, never the app's page or socket; a
 * host nobody claimed is a 404; releasing it ends that at once. The front
 * asks whose a host is, with its secret, and its forwarded host counts only
 * with it. (Ported from the orgs host's tests.)
 */
import { assertEquals, assertRejects } from "@std/assert";
import { defineAction, definePlugin, type Runtime } from "copilotz";
import { test } from "copilotz/testing";
import { served } from "./orgs-served.ts";

type Hosts = {
  claimHost(host: string, claim?: { target?: string }): Promise<void>;
  releaseHost(host: string): Promise<void>;
};

/** What an org serves on hosts it claims, and Actions to claim and release them. */
const sites = (org: string) =>
  definePlugin({
    name: "sites",
    actions: {
      "sites.claim": defineAction({
        input: {
          type: "object",
          properties: { host: { type: "string" }, target: { type: "string" } },
          required: ["host"],
        },
        run: (ctx, input) =>
          (ctx.resources.directory as unknown as Hosts).claimHost(
            input.host,
            input.target ? { target: input.target } : {},
          ),
      }),
      "sites.release": defineAction({
        input: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
        run: (ctx, input) => (ctx.resources.directory as unknown as Hosts).releaseHost(input.host),
      }),
    },
    routes: {
      "*://*.sites.test:*/*": (request) =>
        Response.json({
          org,
          host: new URL(request.url).host,
          path: new URL(request.url).pathname,
        }),
    },
  });

const FRONT = "the-front-secret-0123";

test("orgs: a claimed host is its org's routes; unknown hosts 404; the front resolves hosts", async () => {
  const app = await served({
    resources: {
      hosts: { localhost: true, "*.run.test": true },
      caller: { header: "cf-connecting-ip", front: FRONT },
    },
    plugins: (org) => [sites(org.id)],
  });
  const { dir, orgs } = app;
  const get = (url: string, headers: Record<string, string> = {}) =>
    dir.fetch(new Request(url, { headers }));
  try {
    const { org: acme } = await dir.call<{ org: string }>("org.create", {
      name: "Acme",
      by: "ana",
    });
    const { org: beta } = await dir.call<{ org: string }>("org.create", {
      name: "Beta",
      by: "bob",
    });
    const acmeRt = (await orgs.get(acme)) as Runtime;
    const betaRt = (await orgs.get(beta)) as Runtime;

    // Nobody's yet: a 404, not the app.
    assertEquals((await get("http://shop.sites.test/")).status, 404);
    await acmeRt.call("sites.claim", { host: "Shop.Sites.test" });
    const shop = await get("http://shop.sites.test/cart?x=1");
    assertEquals(await shop.json(), { org: acme, host: "shop.sites.test", path: "/cart" });
    // Every path is the org's routes', the app's socket and its own paths too.
    for (const path of ["/oxian", `/o/${acme}/oxian`, "/orgs", "/signout", "/connect"]) {
      assertEquals((await (await get(`http://shop.sites.test${path}`)).json()).org, acme, path);
    }

    // Another org can't take it; nobody claims the app's own hosts.
    await assertRejects(() => betaRt.call("sites.claim", { host: "shop.sites.test" }));
    await assertRejects(() => betaRt.call("sites.claim", { host: "localhost" }));
    await assertRejects(() => betaRt.call("sites.claim", { host: "api.run.test" }));

    // A host the org claimed with no route of its own for it: a 404, never the app's.
    await betaRt.call("sites.claim", { host: "beta.other.test" });
    for (const path of ["/", "/oxian", "/connect", "/health", "/app/app.js"]) {
      assertEquals((await get(`http://beta.other.test${path}`)).status, 404, path);
    }

    // The app's own hosts are the app's, as ever: its socket, which takes no one without a ticket.
    const own = await get("http://localhost/oxian");
    assertEquals(own.status >= 400 && own.status !== 404, true);
    await own.body?.cancel();

    // The front: whose a host is (and where it sends it), with its secret only, on any host.
    const resolve = (name: string, headers: Record<string, string> = {}) =>
      get(`http://app.run.test/__copilotz/hosts/resolve?host=${name}`, headers);
    assertEquals((await resolve("shop.sites.test")).status, 403);
    assertEquals((await resolve("shop.sites.test", { "x-copilotz-front": "guess" })).status, 403);
    const vouched = { "x-copilotz-front": FRONT };
    assertEquals(await (await resolve("shop.sites.test", vouched)).json(), { org: acme });
    assertEquals((await resolve("nobody.sites.test", vouched)).status, 404);
    const asked = await get(
      "http://elsewhere.test/__copilotz/hosts/resolve?host=shop.sites.test",
      vouched,
    );
    assertEquals(await asked.json(), { org: acme });
    await acmeRt.call("sites.claim", {
      host: "shop.sites.test",
      target: "https://shop-abc.a.run.app",
    });
    assertEquals(await (await resolve("shop.sites.test", vouched)).json(), {
      org: acme,
      target: "https://shop-abc.a.run.app",
    });

    // Behind the front: the host it forwards counts, with its secret only.
    const forwarded = { "x-forwarded-host": "shop.sites.test" };
    const through = await get("https://app.run.test/a", { ...forwarded, ...vouched });
    assertEquals(await through.json(), { org: acme, host: "shop.sites.test", path: "/a" });
    // Without it, the request is for the host it came to: the app's (its lobby's page).
    const forged = await get("https://app.run.test/a", { ...forwarded, accept: "text/html" });
    assertEquals(forged.headers.get("content-type"), "text/html; charset=utf-8");

    // Released: nobody's again, at once.
    await acmeRt.call("sites.release", { host: "shop.sites.test" });
    assertEquals((await get("http://shop.sites.test/")).status, 404);
    assertEquals((await resolve("shop.sites.test", vouched)).status, 404);
    // Now Beta may claim it.
    await betaRt.call("sites.claim", { host: "shop.sites.test" });
    assertEquals((await (await get("http://shop.sites.test/")).json()).org, beta);

    // A deleted org's hosts go with it.
    await dir.call("org.delete", { org: beta });
    assertEquals(await dir.query("orgHost.resolve", { host: "beta.other.test" }), null);
  } finally {
    await app.close();
  }
});

test("orgs: without the app's own hosts named, every host is the app's", async () => {
  const app = await served({ plugins: (org) => [sites(org.id)] });
  const { dir, orgs } = app;
  try {
    const { org } = await dir.call<{ org: string }>("org.create", { name: "Acme", by: "ana" });
    const rt = (await orgs.get(org)) as Runtime;
    // A claim is kept (the front may route by it), but the directory serves the app on every host.
    await rt.call("sites.claim", { host: "shop.sites.test" });
    assertEquals(await dir.query("orgHost.resolve", { host: "shop.sites.test" }), { org });
    const lobby = await dir.fetch(
      new Request("http://shop.sites.test/", { headers: { accept: "text/html" } }),
    );
    assertEquals(lobby.headers.get("content-type"), "text/html; charset=utf-8");
    // Nobody resolves hosts without a front.
    const resolve = await dir.fetch(
      new Request("http://localhost/__copilotz/hosts/resolve?host=shop.sites.test", {
        headers: { "x-copilotz-front": "" },
      }),
    );
    assertEquals(resolve.status, 403);
  } finally {
    await app.close();
  }
});
