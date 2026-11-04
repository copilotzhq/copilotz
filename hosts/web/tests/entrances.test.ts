/**
 * Who a browser is, as the app's plugins declare it (see entrances.ts): a
 * signed-in person is their session's, first; a browser that's no one comes
 * in by a web line when its page asks, a contact in the line's space with a
 * chat of its own, its secret in an httpOnly, SameSite=Strict cookie, and
 * the same contact while it lasts. A forged cookie is no one, and never the
 * contact it imitates; an erased contact's cookie is no one at once. New
 * visitors are limited from one caller's address (as the app's front says
 * it) and on the line, at once too, and refused plainly past either.
 * Connecting, signing in and out come from the app's own page only. An app
 * without a page or tickets serves its routes alone, whatever its plugins
 * declare; and what they declare is checked as the host starts.
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../../plugins/models/mod.ts";
import { chat } from "../../../plugins/agents/chat/mod.ts";
import { access, devSignIn, googleSignIn, identity } from "../../../plugins/access/mod.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets, type Tickets } from "../tickets.ts";
import { httpRequest, webServer } from "../server.ts";

const ana: Actor = { kind: "person", id: "ana" };
/** The app's front's secret: it vouches for the caller's address it sends. */
const FRONT = "the-front-secret-for-tests-0123";
const PAGE = "http://localhost:8790";

/** A route that says who it was called as. */
const who = definePlugin({
  name: "who",
  actions: {
    "who.am": defineAction({
      input: httpRequest,
      allow: () => true,
      run: (ctx) => ({ body: { kind: ctx.actor?.kind, id: ctx.actor?.id } }),
    }),
  },
  resources: { routes: { who: { path: "/who", action: "who.am" } } },
});

/**
 * An app with two web lines: `site`, in a space it declares, answered by
 * its guide; `shop`, in a space Ana made (she manages it), and `burst`,
 * for arrivals at once. Its front says who calls (`cf-connecting-ip`).
 */
const app = (limits: Record<string, number> = {}) =>
  definePlugin({
    name: "app",
    resources: {
      agents: { guide: { instructions: "Help visitors.", model: "fake/echo" } },
      spaces: { visitors: { name: "Website", agents: ["guide"] } },
      web: {
        caller: { header: "cf-connecting-ip", front: FRONT },
        lines: {
          site: { in: "visitors", agent: "guide", limits },
          shop: { in: "shop", title: "Shop chat" },
          burst: { in: "visitors", limits: { ipVisitorsPerHour: 2 } },
        },
      },
    },
  });

type Setup = {
  serve: (request: Request) => Promise<Response>;
  runtime: Runtime;
  tickets: Tickets;
};

async function setup(
  fn: (s: Setup) => Promise<void>,
  options: { plugins?: Plugin[]; limits?: Record<string, number> } = {},
) {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      devSignIn,
      who,
      app(options.limits),
      ...options.plugins ?? [],
    ],
  });
  try {
    await runtime.call("space.create", { id: "shop", name: "Shop" }, { actor: ana });
    const serve = webServer({
      runtime,
      tickets,
      code: { entry: "app.js", files: { "app.js": "" } },
      front: { secret: FRONT },
    });
    await fn({ serve, runtime, tickets });
  } finally {
    await runtime.close();
  }
}

type Asked = {
  body?: unknown;
  cookie?: string;
  /** The caller's address, as the front says it (with its secret); `false`: around the front. */
  from?: string | false;
  origin?: string | null;
  url?: string;
  headers?: Record<string, string>;
};

/** A page's request: same origin, through the front, from an address (203.0.113.7). */
const request = (path: string, asked: Asked = {}) =>
  new Request(`${asked.url ?? PAGE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(asked.origin === null ? {} : { origin: asked.origin ?? asked.url ?? PAGE }),
      ...(asked.cookie ? { cookie: asked.cookie } : {}),
      ...(asked.from === false
        ? {}
        : { "x-copilotz-front": FRONT, "cf-connecting-ip": asked.from ?? "203.0.113.7" }),
      ...asked.headers,
    },
    body: JSON.stringify(asked.body ?? {}),
  });

/** The cookie a response sets, as a browser sends it back. */
const sent = (response: Response) => response.headers.get("set-cookie")?.split(";")[0];

/** Connects: the answer's status, its JSON, and the cookie it sets. */
async function connect(serve: Setup["serve"], asked: Asked = {}) {
  const response = await serve(request("/connect", asked));
  return {
    status: response.status,
    said: await response.json() as {
      ticket?: string;
      actor?: Actor;
      name?: string;
      error?: string;
    },
    cookie: sent(response),
    set: response.headers.get("set-cookie"),
    retry: response.headers.get("retry-after"),
  };
}

/** What a View of the app's says, as the system reads it. */
async function read<T>(runtime: Runtime, view: string, item: unknown = {}): Promise<T> {
  const seen = runtime.observe<T>("test", view, item);
  try {
    const output = await seen.ready;
    if (output.status !== "ready") throw new Error(`${view}: ${output.status}`);
    return output.value;
  } finally {
    seen.close();
  }
}

/** Every contact the app keeps, as the system reads them. */
const keptContacts = definePlugin({
  name: "kept",
  views: {
    "all-contacts": {
      test: (_: unknown, ctx) =>
        (ctx.db.collection<{ _id: string; in: string; via: string }>("contact").find({}).value ??
          []).map((c) => `${c._id} ${c.in} ${c.via}`),
    },
    "chats-of": {
      test: (contact: string, ctx) =>
        (ctx.db.collection<{ space: string }>("member").find({
          member: `contact:${contact}`,
          on: "thread",
        }).value ?? []).map((m) => m.space),
    },
  },
});

/** How many contacts the app keeps. */
const count = async (runtime: Runtime) => (await read<string[]>(runtime, "all-contacts")).length;

test("a visitor: let in by a line its page names, a contact with a chat of its own, the same while its cookie lasts", async () => {
  await setup(async ({ serve, runtime, tickets }) => {
    // The page asks for nothing: nobody, and nobody's made.
    assertEquals((await connect(serve)).status, 401);
    assertEquals((await connect(serve, { body: { line: "nowhere" } })).status, 401);
    assertEquals(await count(runtime), 0);

    const first = await connect(serve, { body: { line: "site" } });
    assertEquals(first.status, 200);
    const visitor = first.said.actor!;
    assertEquals(visitor.kind, "contact");
    assertMatch(visitor.id, /^c-[\w-]+$/);
    // Its secret: in an httpOnly cookie only the app's own pages send, for its 30 days.
    assertMatch(
      first.set!,
      /^visitor=vis_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/,
    );
    assertEquals(tickets.admit(first.said.ticket!), { kind: "contact", id: visitor.id });
    // A contact in the line's space, by the web, with one chat shared with it there.
    assertEquals(await read(runtime, "all-contacts"), [`${visitor.id} visitors web`]);
    assertEquals((await read<string[]>(runtime, "chats-of", visitor.id)).length, 1);

    // Its cookie again, with or without the line: the same contact, nothing new made or set.
    for (const body of [{}, { line: "site" }, { line: "shop" }]) {
      const again = await connect(serve, { cookie: first.cookie, body });
      assertEquals([again.status, again.said.actor, again.set], [200, visitor, null]);
    }
    assertEquals(await count(runtime), 1);
    // A route, and a file, are asked as it too.
    const route = await serve(
      new Request(`${PAGE}/who`, { method: "POST", headers: { cookie: first.cookie! } }),
    );
    assertEquals(await route.json(), visitor);

    // Off this machine, the cookie is Secure, and this host's alone: `__Host-`, so no other host
    // under the domain (a preview's) can set one to make a browser a visitor of its choosing.
    const url = "https://app.example";
    const secure = await connect(serve, { url, body: { line: "site" } });
    assertEquals(secure.status, 200);
    assertMatch(
      secure.set!,
      /^__Host-visitor=vis_[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; .*; Secure$/,
    );
    const hers = secure.cookie!.slice("__Host-".length);
    assertEquals(
      (await connect(serve, { url, cookie: secure.cookie })).said.actor,
      secure.said.actor,
    );
    // The same secret, as a sibling host would set it (no prefix): not read there.
    assertEquals((await connect(serve, { url, cookie: hers })).status, 401);
  }, { plugins: [keptContacts] });
});

test("a forged cookie is no one: never the contact it imitates, and cleared; an erased visitor's, at once", async () => {
  await setup(async ({ serve, runtime }) => {
    const carla = await connect(serve, { body: { line: "shop" } });
    assertEquals(carla.status, 200, carla.said.error);
    const { id } = carla.said.actor!;
    const secret = carla.cookie!.slice("visitor=".length);
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    for (
      const forged of [
        `vis_${"A".repeat(43)}`,
        flipped,
        secret.slice(0, -4),
        `${secret}x`,
        "<script>",
        "x".repeat(4_000),
        "",
      ]
    ) {
      const tried = await connect(serve, { cookie: `visitor=${forged}` });
      assertEquals(tried.status, 401, forged.slice(0, 20));
      if (forged) assertMatch(tried.set ?? "visitor=; Max-Age=0", /^visitor=; .*Max-Age=0/);
      // Asking to come in with it makes someone new, never Carla.
      const fresh = await connect(serve, { cookie: `visitor=${forged}`, body: { line: "shop" } });
      assertEquals(fresh.status, 200);
      assertNotEquals(fresh.said.actor!.id, id);
      // A route takes it for no one.
      const route = await serve(
        new Request(`${PAGE}/who`, { method: "POST", headers: { cookie: `visitor=${forged}` } }),
      );
      assertEquals((await route.json()).kind, "visitor");
    }
    // The one cookie that's her is her.
    assertEquals((await connect(serve, { cookie: carla.cookie })).said.actor!.id, id);

    // Ana, who manages the shop, erases her: her cookie is no one from now on.
    await runtime.call("contact.forget", { contact: id }, { actor: ana });
    const gone = await connect(serve, { cookie: carla.cookie });
    assertEquals(gone.status, 401);
    assertMatch(gone.set!, /^visitor=; .*Max-Age=0/);
    const back = await connect(serve, { cookie: carla.cookie, body: { line: "shop" } });
    assertEquals(back.status, 200);
    assertNotEquals(back.said.actor!.id, id);
  });
});

test("limits: new visitors an hour from one address, then on the line; refused plainly, nothing made", async () => {
  await setup(async ({ serve, runtime }) => {
    const arrive = (from: string | false, line = "site") =>
      connect(serve, { from, body: { line } });
    const FROM_HERE = "Too many new visitors from here: try again later.";
    const a1 = await arrive("203.0.113.7");
    const a2 = await arrive("203.0.113.7");
    assertEquals([a1.status, a2.status], [200, 200]);
    const a3 = await arrive("203.0.113.7");
    assertEquals([a3.status, a3.said.error, a3.retry, a3.set], [429, FROM_HERE, "60", null]);
    assertEquals(await count(runtime), 2);
    // The line takes 3 an hour, all together: then no one new, from anywhere.
    assertEquals((await arrive("2001:db8::1")).status, 200);
    const full = await arrive("198.51.100.9");
    assertEquals([full.status, full.said.error], [
      429,
      "This chat is busy right now: try again in a few minutes.",
    ]);
    assertEquals(await count(runtime), 3);
    // An IPv6 caller is counted by its /64: one network, one allowance (2, on this line).
    for (const [from, status] of [["2001:db8:1::1", 200], ["2001:db8:1::2", 200]] as const) {
      assertEquals((await arrive(from, "burst")).status, status, from);
    }
    const sameNet = await arrive("2001:db8:1::ffff", "burst");
    assertEquals([sameNet.status, sameNet.said.error], [429, FROM_HERE]);
    assertEquals((await arrive("2001:db8:2::1", "burst")).status, 200);
    assertEquals(await count(runtime), 6);
    // Someone already in isn't new: their cookie still connects.
    assertEquals((await connect(serve, { cookie: a1.cookie })).said.actor, a1.said.actor);

    // Around the front (without its secret, whatever address it claims): refused, nothing made.
    const around = await arrive(false, "shop");
    assertEquals([around.status, around.said.error], [403, "Not through the app's front."]);
    const claimed = await connect(serve, {
      from: false,
      headers: { "cf-connecting-ip": "192.0.2.1" },
      body: { line: "shop" },
    });
    assertEquals(claimed.status, 403);
    assertEquals(await count(runtime), 6);

    // Many at once from one address can't pass its limit: places are taken one write each.
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => arrive("192.0.2.200", "burst")),
    );
    assertEquals(burst.filter((b) => b.status === 200).length, 2);
    assertEquals(burst.filter((b) => b.status === 429).length, 10);
    assertEquals(await count(runtime), 8);
  }, { plugins: [keptContacts], limits: { ipVisitorsPerHour: 2, visitorsPerHour: 3 } });
});

test("connecting, signing in and out come from the app's own page only", async () => {
  await setup(async ({ serve, runtime }) => {
    const refused = async (path: string, asked: Asked, why: string) => {
      const answer = await serve(request(path, asked));
      assertEquals(answer.status, 403, `${path}: ${why}`);
      assertEquals(answer.headers.get("set-cookie"), null, `${path}: ${why}`);
      await answer.body?.cancel();
    };
    for (const path of ["/connect", "/signin/dev", "/signout"]) {
      const body = path === "/connect" ? { line: "site" } : { name: "ana" };
      await refused(path, { origin: "https://evil.example", body }, "another site");
      await refused(path, { origin: "null", body }, "an opaque origin");
      await refused(path, { origin: "http://localhost:9999", body }, "another port");
      await refused(path, { headers: { "sec-fetch-site": "cross-site" }, body }, "fetch metadata");
      await refused(path, { headers: { "sec-fetch-site": "same-site" }, body }, "a sibling");
    }
    // Plain http is this machine's alone: elsewhere, a page is https.
    await refused("/connect", {
      url: "http://app.example",
      origin: "http://app.example",
      body: { line: "site" },
    }, "http off this machine");
    // Nobody was let in, nor signed in.
    assertEquals(await count(runtime), 0);

    // The app's own page, or no browser at all, is let in.
    assertEquals((await connect(serve, { body: { line: "site" } })).status, 200);
    assertEquals((await connect(serve, { origin: null, body: { line: "site" } })).status, 200);
    const same = await connect(serve, {
      headers: { "sec-fetch-site": "same-origin" },
      body: { line: "site" },
    });
    assertEquals(same.status, 200);

    // Behind the front, the page's origin is the host the front forwards, with its secret only.
    const inside = "http://10.0.0.7:8080";
    const forwarded = { url: inside, origin: "https://app.example", body: { line: "shop" } };
    assertEquals(
      (await connect(serve, { ...forwarded, headers: { "x-forwarded-host": "app.example" } }))
        .status,
      200,
    );
    // Without the secret, the forwarded host is no one's word: the origin isn't this host. (Asking
    // for no line, it'd be a 401 past the origin's check: this is that check.)
    await refused("/connect", {
      ...forwarded,
      body: {},
      from: false,
      headers: { "x-forwarded-host": "app.example" },
    }, "a forwarded host without the front's secret");
  }, { plugins: [keptContacts] });
});

test("a signed-in person comes in as themselves, even where the page asks to arrive", async () => {
  await setup(async ({ serve, runtime }) => {
    const signed = await serve(request("/signin/dev", { body: { name: "ana" } }));
    const session = sent(signed)!;
    assertMatch(signed.headers.get("set-cookie")!, /^session=ses_[^;]+; HttpOnly; SameSite=Lax;/);
    const visitor = await connect(serve, { body: { line: "site" } });
    for (const cookie of [session, `${session}; ${visitor.cookie}`]) {
      const in_ = await connect(serve, { cookie, body: { line: "site" } });
      assertEquals([in_.said.actor, in_.said.name, in_.set], [ana, "ana", null]);
    }
    assertEquals(await count(runtime), 1);
    // Signing out ends her session, and clears every entrance's cookie it was sent.
    const out = await serve(request("/signout", { cookie: `${session}; ${visitor.cookie}` }));
    const cleared = out.headers.getSetCookie();
    assertEquals(cleared.map((c) => c.split(";")[0]).sort(), ["session=", "visitor="]);
    assertEquals((await connect(serve, { cookie: session })).status, 401);
  }, { plugins: [keptContacts] });
});

test("an app without a page or tickets serves its routes alone, whatever its plugins declare", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      devSignIn,
      googleSignIn,
      who,
      app(),
      keptContacts,
      definePlugin({ name: "g", resources: { google: { clientId: "web.apps" } } }),
    ],
  });
  try {
    const serve = webServer({ runtime });
    const plain = async (method: string, path: string, body?: unknown) => {
      const answer = await serve(
        new Request(`${PAGE}${path}`, {
          method,
          headers: { origin: PAGE, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      return [answer.status, await answer.text(), answer.headers.get("set-cookie")];
    };
    for (
      const [method, path, body] of [
        ["POST", "/connect", { line: "site" }],
        ["POST", "/signin/dev", { name: "ana" }],
        ["POST", "/signin/google", { idToken: "x" }],
        ["POST", "/signout"],
        ["GET", "/"],
        ["GET", "/app/app.js"],
        ["GET", "/manifest.webmanifest"],
        ["GET", "/sw.js"],
        ["GET", "/assets/copilotz/fonts.css"],
        ["GET", "/oxian"],
        ["GET", "/somewhere"],
      ] as const
    ) {
      assertEquals(await plain(method, path, body), [404, "Not found", null], `${method} ${path}`);
    }
    assertEquals(await plain("GET", "/health"), [200, "ok", null]);
    assertEquals(await plain("POST", "/who"), [200, '{"kind":"visitor","id":""}', null]);
    assertEquals(await count(runtime), 0);
  } finally {
    await runtime.close();
  }
});

test("the page shows the ways to sign in the app declares; a host signing in elsewhere shows those", async () => {
  const google = definePlugin({
    name: "g",
    resources: { google: { clientId: ["web.apps", "ios.apps"] } },
  });
  const both = await createRuntime({
    store: memoryStore(),
    plugins: [identity, devSignIn, googleSignIn, google],
  });
  const none = await createRuntime({ store: memoryStore(), plugins: [identity] });
  try {
    const code = { entry: "app.js", files: { "app.js": "" } };
    const config = async (serve: (r: Request) => Promise<Response>) => {
      const html = await (await serve(new Request(`${PAGE}/`))).text();
      return JSON.parse(html.match(/<script id="copilotz-config"[^>]*>([^<]*)</)![1]);
    };
    const tickets = createTickets();
    assertEquals(await config(webServer({ runtime: both, tickets, code })), {
      signIn: { dev: {}, google: { clientId: "web.apps" } },
    });
    assertEquals(await config(webServer({ runtime: none, tickets, code })), { signIn: {} });
    // Signing in at another runtime (a directory): its ways, shown here, never served here.
    const elsewhere = webServer({ runtime: none, tickets, code, signIn: { at: both } });
    assertEquals(await config(elsewhere), {
      signIn: { dev: {}, google: { clientId: "web.apps" } },
    });
    const tried = await elsewhere(request("/signin/dev", { body: { name: "ana" } }));
    assertEquals([tried.status, tried.headers.get("set-cookie")], [404, null]);
    await tried.body?.cancel();
  } finally {
    await both.close();
    await none.close();
  }
});

test("what the app declares is checked as the host starts", async () => {
  const declaring = (resources: Record<string, unknown>) =>
    definePlugin({ name: "declaring", resources } as Parameters<typeof definePlugin>[0]);
  const bad: [Record<string, unknown>, string][] = [
    [{ entrances: { odd: { cookie: "a b", query: "credential.actor" } } }, "its cookie"],
    [{ entrances: { twin: { cookie: "session", query: "credential.actor" } } }, "another entrance"],
    [{ entrances: { odd: { cookie: "odd", query: "nothing" } } }, "its query"],
    [{ entrances: { odd: { cookie: "odd", query: "a.b", arrive: "no" } } }, "its arrive"],
    [{ entrances: { odd: { cookie: "odd", query: "a.b", sameSite: "none" } } }, "its sameSite"],
    [{ signIn: { magic: { action: "magic.in", entrance: "nowhere" } } }, "no entrance"],
    [{ signIn: { Magic: { action: "magic.in" } } }, "its name"],
  ];
  for (const [resources, said] of bad) {
    const runtime = await createRuntime({
      store: memoryStore(),
      plugins: [identity, declaring(resources)],
    });
    try {
      assertThrows(() => webServer({ runtime }), Error, said);
    } finally {
      await runtime.close();
    }
  }
  // A web line's settings, as the app starts.
  const lines: [Record<string, unknown>, string][] = [
    [{ lines: { site: { agent: "guide" } } }, "needs its in"],
    [{ lines: { site: { in: "s", agent: "nobody" } } }, "isn't one of the app's agents"],
    [{ lines: { site: { in: "s", limits: { perDay: 3 } } } }, "isn't a limit"],
    [{ lines: { site: { in: "s", limits: { visitorsPerHour: 0 } } } }, "a whole number over 0"],
    [{ lines: { site: { in: "s", days: 500 } } }, "400 at most"],
    [{ lines: { "a b": { in: "s" } } }, "its name"],
    [{ caller: { header: "x-forwarded-for" }, lines: {} }, "why its header is believed"],
    [{ caller: { header: "x-forwarded-for", front: FRONT }, lines: {} }, "say its hops"],
  ];
  for (const [web, said] of lines) {
    let started: Runtime | undefined;
    try {
      started = await createRuntime({
        store: memoryStore(),
        plugins: [
          ...access,
          declaring({ web, agents: { guide: { instructions: "", model: "x" } } }),
        ],
      });
      assert(false, `started with ${JSON.stringify(web)}`);
    } catch (error) {
      assertMatch((error as Error).message, new RegExp(said), JSON.stringify(web));
    } finally {
      await started?.close();
    }
  }
});

test("what the page asks coming in is a small JSON object", async () => {
  await setup(async ({ serve, runtime }) => {
    const tried = await serve(
      new Request(`${PAGE}/connect`, {
        method: "POST",
        headers: { origin: PAGE, "content-type": "application/json" },
        body: JSON.stringify({ line: "site", padding: "x".repeat(20_000) }),
      }),
    );
    assertEquals(tried.status, 400);
    await tried.body?.cancel();
    for (const body of ["[1]", '"site"', "{", "null"]) {
      const answer = await serve(
        new Request(`${PAGE}/connect`, { method: "POST", headers: { origin: PAGE }, body }),
      );
      assertEquals(answer.status, 400, body);
      await answer.body?.cancel();
    }
    assertEquals(await count(runtime), 0);
  }, { plugins: [keptContacts] });
});
