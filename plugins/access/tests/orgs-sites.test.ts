/**
 * An org's site chat, behind the directory: its page, at the org's address
 * (`/o/<org>/`), says where the app is (`base`), and a browser that's no one
 * comes in there (`POST /o/<org>/web/<name>`, then `/o/<org>/connect`): a
 * visitor of that org's site, its cookie the org's own (`visitor_<org>`),
 * counted by the address its socket came from; its first message, a contact
 * in the org, with its chat. Another org's site isn't this one's, and the
 * lobby lets no visitor in. (Ported from the orgs host's tests.)
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { type Actor, contactsPool, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { webLines } from "../../interfaces/web/lines.ts";
import { setClientAddress } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { BASE, browser, served } from "./orgs-served.ts";

/** A request as a browser on the page sends it, its socket from `address`. */
const asked = (path: string, init: { cookie?: string; body?: unknown; address?: string } = {}) =>
  setClientAddress(
    new Request(BASE + path, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        origin: BASE,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    init.address ?? "192.0.2.5",
  );

test("an org's site chat: its page at the org's address, and visitors let in there", async () => {
  // Every org's visitors' connections are counted together: one listener holds them all.
  const pool = contactsPool();
  const app = await served({
    open: async (org, given) =>
      await createRuntime({
        store: memoryStore(),
        plugins: [
          models,
          chat,
          webLines,
          ...given,
          definePlugin({
            name: "sites",
            resources: {
              agents: { guide: { instructions: "Help.", model: "fake/echo" } },
              spaces: { visitors: { name: "Website", agents: ["guide"] } },
              links: { origin: BASE, secret: "the-app-secret-for-tests-0123456789" },
              web: { [`site-${org.id}`]: { in: "visitors", agent: "guide" } },
            },
          }),
        ],
        browsers: { pool },
      }),
  });
  const { dir, orgs } = app;
  try {
    // Two orgs (Ana's and Bob's personal ones).
    const ana = (await browser(dir).signIn("ana"))!;
    const bob = (await browser(dir).signIn("bob"))!;

    // The org's page, at its address: it says where the app is, so the page connects there.
    const page = await (await dir.fetch(asked(`/o/${ana}/`, {}))).text();
    const config = JSON.parse(page.match(/<script id="copilotz-config"[^>]*>([^<]*)</)![1]);
    assertEquals(config, { base: `/o/${ana}` });

    // A browser that's no one, coming in by the org's site there: a visitor of the org.
    const site = `site-${ana}`;
    const came = await dir.fetch(asked(`/o/${ana}/web/${site}`, { body: {} }));
    assertEquals(came.status, 200);
    const set = came.headers.get("set-cookie")!;
    assertMatch(set, new RegExp(`^visitor_${ana}=`));
    assertMatch(set, /SameSite=Strict/);
    const cookie = set.split(";")[0];
    const connected = await dir.fetch(asked(`/o/${ana}/connect`, { cookie, body: {} }));
    const { actor } = await connected.json() as { actor: Actor };
    assertEquals(actor.kind, "contact");
    // Its cookie, there again: the same visitor, nothing new made.
    const again = await dir.fetch(asked(`/o/${ana}/web/${site}`, { cookie, body: {} }));
    assertEquals([again.status, again.headers.get("set-cookie")], [200, null]);
    const still = await dir.fetch(asked(`/o/${ana}/connect`, { cookie, body: {} }));
    assertEquals((await still.json() as { actor: Actor }).actor, actor);
    // Counted by its socket's address, there too: the org's site's limits hold.
    let past: Response | undefined;
    for (let i = 0; i < 40 && !past; i++) {
      const more = await dir.fetch(asked(`/o/${ana}/web/${site}`, { body: {} }));
      if (more.status === 429) past = more;
      else assertEquals(more.status, 200, `arrival ${i + 2}`);
      await more.body?.cancel();
    }
    assert(past, "the site's limit by address holds");
    const elsewhere = await dir.fetch(
      asked(`/o/${ana}/web/${site}`, { body: {}, address: "192.0.2.6" }),
    );
    assertEquals(elsewhere.status, 200);
    await elsewhere.body?.cancel();

    // Its first message: a contact in the org, with a chat of its own there.
    const runtime = (await orgs.get(ana))!;
    const visitor = await runtime.query<Actor>("contact_visitor.actor", {
      secret: cookie.slice(cookie.indexOf("=") + 1),
    });
    assertEquals([visitor.kind, visitor.id], [actor.kind, actor.id]);
    const { thread } = await runtime.call<{ thread: string }>("chat.send", { text: "hi" }, {
      actor: visitor,
    });
    assert(thread.startsWith("web-"));

    // Another org's site isn't this one's; nor does the lobby let a visitor in.
    for (const path of [`/o/${ana}/web/site-${bob}`, `/o/${bob}/web/${site}`, `/web/${site}`]) {
      const refused = await dir.fetch(asked(path, { body: {} }));
      assertEquals([refused.status, refused.headers.get("set-cookie")], [404, null], path);
      await refused.body?.cancel();
    }
    // Nor its `/connect`: a visitor's cookie is its org's alone.
    const lobby = await dir.fetch(asked("/connect", { cookie, body: {} }));
    assertEquals(lobby.status, 401);
    await lobby.body?.cancel();
  } finally {
    await app.close();
  }
});
