/**
 * An org's web line, behind the orgs host: its page, at the org's address
 * (`/o/<org>/`), says where the app is (`base`), and the page asks to come
 * in there (`/o/<org>/connect`), as a browser that's no one: a visitor of
 * that org's line, its cookie the org's own, counted by the address its
 * socket came from; its first message, a contact in the org, with its chat.
 * Another org's line isn't this one's, and the lobby lets no visitor in.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  type Actor,
  type BrowserLimits,
  createRuntime,
  definePlugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../../plugins/models/mod.ts";
import { chat } from "../../../plugins/agents/chat/mod.ts";
import { access, devSignIn, identity } from "../../../plugins/access/mod.ts";
import { webLines } from "../../../plugins/interfaces/web/lines.ts";
import { directory } from "../../../plugins/access/directory/mod.ts";
import { test } from "../../../testing/mod.ts";
import { setClientAddress } from "../../web/address.ts";
import { orgsHost } from "../mod.ts";

const BASE = "http://localhost:8800";

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

test("an org's web line: its page at the org's address, and visitors let in there", async () => {
  const dir = await createRuntime({
    store: memoryStore(),
    plugins: [identity, directory, devSignIn],
  });
  const runtimes = new Map<
    string,
    { runtime: Runtime; admit: (t: string) => Actor | undefined; browsers: BrowserLimits }
  >();
  const host = orgsHost({
    directory: dir,
    open: async (org, given) => {
      const runtime = await createRuntime({
        store: memoryStore(),
        plugins: [
          models,
          chat,
          ...access,
          webLines,
          ...given.plugins,
          // Each org's line, by its id: the app's settings name the org each is for.
          definePlugin({
            name: "lines",
            resources: {
              agents: { guide: { instructions: "Help.", model: "fake/echo" } },
              spaces: { visitors: { name: "Website", agents: ["guide"] } },
              links: { origin: BASE, secret: "the-app-secret-for-tests-0123456789" },
              web: {
                lines: {
                  [`site-${org.id}`]: { in: "visitors", agent: "guide", org: org.id },
                },
              },
            },
          }),
        ],
        admit: given.admit,
        transports: given.transports,
        browsers: given.browsers,
      });
      runtimes.set(org.id, { runtime, admit: given.admit, browsers: given.browsers });
      return runtime;
    },
    upgrade: () => new Response(null, { status: 299 }),
    code: { entry: "app.js", files: { "app.js": "" } },
  });
  try {
    // Two orgs (Ana's and Bob's personal ones).
    const orgOf = async (name: string) => {
      const signed = await host.serve(
        setClientAddress(
          new Request(`${BASE}/signin/dev`, {
            method: "POST",
            headers: { origin: BASE, "content-type": "application/json" },
            body: JSON.stringify({ name }),
          }),
          "127.0.0.1",
        ),
      );
      return ((await signed.json()) as { org: { id: string } }).org.id;
    };
    const ana = await orgOf("ana");
    const bob = await orgOf("bob");
    // Every org's contacts' connections are counted together: one listener holds them all.
    await host.serve(asked(`/o/${bob}/`)).then((r) => r.body?.cancel());
    const pools = [ana, bob].map((org) => runtimes.get(org)?.browsers.pool);
    assert(pools[0] && pools[0] === pools[1]);

    // The org's page, at its address: it says where the app is, so the page connects there.
    const page = await (await host.serve(asked(`/o/${ana}/`))).text();
    const config = JSON.parse(page.match(/<script id="copilotz-config"[^>]*>([^<]*)</)![1]);
    assertEquals([config.base, config.socket], [`/o/${ana}`, `/o/${ana}/oxian`]);

    // A browser that's no one, asking to come in by the org's line there: a visitor of the org.
    const line = `site-${ana}`;
    const came = await host.serve(asked(`/o/${ana}/connect`, { body: { line } }));
    assertEquals(came.status, 200);
    const { ticket, actor } = await came.json() as { ticket: string; actor: Actor };
    assertEquals(actor.kind, "contact");
    const set = came.headers.get("set-cookie")!;
    assertMatch(set, new RegExp(`^visitor_${ana}=vis_${line}\\.`));
    const cookie = set.split(";")[0];
    // Its cookie, there again: the same visitor.
    const again = await host.serve(asked(`/o/${ana}/connect`, { cookie, body: { line } }));
    assertEquals((await again.json() as { actor: Actor }).actor, actor);
    // Counted by its socket's address, there too: the org's line's limits hold.
    for (let i = 0; i < 19; i++) {
      const more = await host.serve(asked(`/o/${ana}/connect`, { body: { line } }));
      assertEquals(more.status, 200, `arrival ${i + 2}`);
      await more.body?.cancel();
    }
    const past = await host.serve(asked(`/o/${ana}/connect`, { body: { line } }));
    assertEquals(past.status, 429);
    await past.body?.cancel();
    const elsewhere = await host.serve(
      asked(`/o/${ana}/connect`, { body: { line }, address: "192.0.2.6" }),
    );
    assertEquals(elsewhere.status, 200);
    await elsewhere.body?.cancel();

    // Its first message: a contact in the org, with a chat of its own there.
    const { runtime, admit } = runtimes.get(ana)!;
    const { thread } = await runtime.call<{ thread: string }>("chat.send", { text: "hi" }, {
      actor: admit(ticket),
    });
    assert(thread.startsWith("web-"));

    // Another org's line isn't this one's; nor does the lobby let a visitor in.
    for (
      const [path, body] of [
        [`/o/${ana}/connect`, { line: `site-${bob}` }],
        [`/o/${bob}/connect`, { line }],
        ["/connect", { line }],
      ] as const
    ) {
      const refused = await host.serve(asked(path, { body }));
      assertEquals(refused.status, 401, path);
      await refused.body?.cancel();
    }
  } finally {
    await host.close();
    await dir.close();
  }
});
