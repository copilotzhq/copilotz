/**
 * Who a browser is, as the app's plugins declare it (see entrances.ts): a
 * signed-in person is their session's, first; a browser that's no one comes
 * in by a web line when its page asks, a visitor whose secret (signed: no
 * record is made) is in an httpOnly, SameSite=Strict cookie, the same
 * visitor while it lasts, and a contact in the line's space with a chat of
 * its own once it speaks. A forged cookie is no one, and never the visitor
 * it imitates; an erased contact's cookie is no one at once, and so is a
 * removed line's. New visitors are limited by the caller's address (as the
 * app's front says it, else as the socket's), at once too, refused plainly
 * past it, that address alone; and new visitors who speak, on the line.
 * What's past is collected. Connecting, signing in and out come from the
 * app's own page only. An app without a page or tickets serves its routes
 * alone, whatever its plugins declare; and what they declare is checked as
 * the host starts.
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
import { webLines } from "../../../plugins/interfaces/web/lines.ts";
import { test } from "../../../testing/mod.ts";
import { createTickets, type Tickets } from "../tickets.ts";
import { httpRequest, setClientAddress, webServer } from "../server.ts";

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
/** The app's secret, which visitors' cookies are signed with. */
const LINKS = { origin: PAGE, secret: "the-app-secret-for-tests-0123456789" };

const app = (limits: Record<string, number> = {}, caller = true) =>
  definePlugin({
    name: "app",
    resources: {
      agents: { guide: { instructions: "Help visitors.", model: "fake/echo" } },
      spaces: { visitors: { name: "Website", agents: ["guide"] } },
      links: LINKS,
      ...(caller ? { caller: { header: "cf-connecting-ip", front: FRONT } } : {}),
      web: {
        site: { in: "visitors", agent: "guide", limits },
        shop: { in: "shop", title: "Shop chat" },
        burst: { in: "visitors", limits: { ipVisitorsPerHour: 2 } },
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
  options: { plugins?: Plugin[]; limits?: Record<string, number>; caller?: false } = {},
) {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      webLines,
      devSignIn,
      who,
      app(options.limits, options.caller !== false),
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
  /** Where its socket came from, as the listener saw it: this machine unless said. */
  address?: string;
};

/**
 * A page's request: same origin, through the front, from an address
 * (203.0.113.7), on a socket from this machine (the front's, before it).
 */
const request = (path: string, asked: Asked = {}) =>
  setClientAddress(
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
    }),
    asked.address ?? "127.0.0.1",
  );

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
  const seen = runtime.observe<T>(view, item);
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
    "all-contacts": (_: unknown, ctx) =>
      (ctx.db.collection<{ _id: string; in: string; via: string }>("contact").find({}).value ??
        []).map((c) => `${c._id} ${c.in} ${c.via}`),
    "chats-of": (contact: string, ctx) =>
      (ctx.db.collection<{ space: string }>("member").find({
        member: `contact:${contact}`,
        on: "thread",
      }).value ?? []).map((m) => m.space.slice("thread:".length)),
    kept: (_: unknown, ctx) => ({
      contacts: (ctx.db.collection("contact").find({}).value ?? []).length,
      threads: (ctx.db.collection("thread").find({}).value ?? []).length,
      members: (ctx.db.collection<{ member: string }>("member").find({}).value ?? [])
        .filter((m) => m.member.startsWith("contact:")).length,
      visitors: (ctx.db.collection("contact_visitor").find({}).value ?? []).length,
    }),
    rates: (_: unknown, ctx) => ctx.db.collection("contact_rate").find({}).value ?? [],
  },
});

/** How many contacts the app keeps. */
const count = async (runtime: Runtime) => (await read<string[]>(runtime, "all-contacts")).length;

/** What the app keeps of visitors: contacts, chats, contacts' memberships, records. */
const kept = (runtime: Runtime) =>
  read<{ contacts: number; threads: number; members: number; visitors: number }>(runtime, "kept");

/** Time going by, for what's collected; and a first message let in that never went in. */
const aging = definePlugin({
  name: "aging",
  actions: {
    "test.unsent": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: (ctx) => ctx.call("contact.sending", {}),
    }),
    "test.age": defineAction({
      input: { type: "object" },
      run: async (ctx, input: { ms: number }) => {
        const earlier = (at: string) => new Date(Date.parse(at) - input.ms).toISOString();
        const visitors = ctx.db.collection<{ _id: string; at: string; expires: string }>(
          "contact_visitor",
        );
        for (const v of await visitors.find({})) {
          await visitors.updateOne({ _id: v._id }, {
            $set: { at: earlier(v.at), expires: earlier(v.expires) },
          });
        }
        const rates = ctx.db.collection<{ _id: string; until: number }>("contact_rate");
        for (const r of await rates.find({})) {
          await rates.updateOne({ _id: r._id }, { $set: { until: r.until - input.ms } });
        }
      },
    }),
  },
});

test("a visitor: let in by a line its page names, nothing made until it speaks, the same while its cookie lasts", async () => {
  await setup(async ({ serve, runtime, tickets }) => {
    // The page asks for nothing: nobody, and nobody's made.
    assertEquals((await connect(serve)).status, 401);
    assertEquals((await connect(serve, { body: { line: "nowhere" } })).status, 401);

    const first = await connect(serve, { body: { line: "site" } });
    assertEquals(first.status, 200);
    const visitor = first.said.actor!;
    assertEquals(visitor.kind, "contact");
    assertMatch(visitor.id, /^c-[0-9a-f]{24}$/);
    // Its secret: signed, in an httpOnly cookie only the app's own pages send, for its 30 days.
    assertMatch(
      first.set!,
      /^visitor=vis_site\.[\w-]{22}\.[0-9a-z]+\.32-[0-9a-f]{16}~24-[0-9a-f]{16}\.[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/,
    );
    // The visitor the server issued: its line, and its networks' tags (an IPv4 address, its /24),
    // what its messages are counted by; never the address.
    const actor = tickets.admit(first.said.ticket!)!;
    const { from: _, ...who } = actor;
    assertEquals(who, { kind: "contact", id: visitor.id, web: "site" });
    assertEquals((actor.from as string[]).map((tag) => tag.split("-")[0]), ["32", "24"]);
    assert(!JSON.stringify(actor).includes("203.0.113"));
    // Coming in made nothing, however many come: no contact, chat, membership, nor record.
    for (let i = 0; i < 5; i++) await connect(serve, { body: { line: "site" } });
    assertEquals(await kept(runtime), { contacts: 0, threads: 0, members: 0, visitors: 0 });
    // Back with its cookie, asking again: the same visitor, though it's said nothing.
    const back = await connect(serve, { cookie: first.cookie, body: { line: "site" } });
    assertEquals([back.status, back.said.actor], [200, visitor]);
    // On another line's page, before it speaks: another visitor, that line's.
    const shop = await connect(serve, { cookie: first.cookie, body: { line: "shop" } });
    assertEquals(shop.status, 200);
    assertNotEquals(shop.said.actor!.id, visitor.id);
    assertMatch(shop.set!, /^visitor=vis_shop\./);

    // It speaks: now a contact in the line's space, by the web, with one chat shared with it.
    const { thread } = await runtime.call<{ thread: string }>("chat.send", { text: "hi" }, {
      actor,
    });
    assertEquals(await read(runtime, "all-contacts"), [`${visitor.id} visitors web`]);
    assertEquals(await read<string[]>(runtime, "chats-of", visitor.id), [thread]);
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
      /^__Host-visitor=vis_site\.[^;]+; HttpOnly; SameSite=Strict; Path=\/; .*; Secure$/,
    );
    const hers = secure.cookie!.slice("__Host-".length);
    assertEquals(
      (await connect(serve, { url, cookie: secure.cookie, body: { line: "site" } })).said.actor,
      secure.said.actor,
    );
    // The same secret, as a sibling host would set it (no prefix): not read there.
    assertEquals((await connect(serve, { url, cookie: hers })).status, 401);
  }, { plugins: [keptContacts] });
});

test("a forged cookie is no one: never the visitor it imitates, and cleared; an erased visitor's, at once", async () => {
  await setup(async ({ serve, runtime, tickets }) => {
    const carla = await connect(serve, { body: { line: "shop" } });
    assertEquals(carla.status, 200, carla.said.error);
    const { id } = carla.said.actor!;
    await runtime.call("chat.send", { text: "hello" }, {
      actor: tickets.admit(carla.said.ticket!),
    });
    await runtime.idle();
    const secret = carla.cookie!.slice("visitor=".length);
    const [, line, rest] = /^vis_(\w+)\.(.*)$/.exec(secret)!;
    const flipped = secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a");
    // One the app made for another app (its own secret), and this one moved to another line.
    const other = await createRuntime({
      store: memoryStore(),
      plugins: [models, chat, ...access, webLines, app()],
    });
    const elsewhere = await (async () => {
      try {
        const answered = await webServer({ runtime: other, tickets: createTickets() })(
          request("/connect", { body: { line: "shop" } }),
        );
        return answered.headers.get("set-cookie")!.split(";")[0].slice("visitor=".length);
      } finally {
        await other.close();
      }
    })();
    for (
      const forged of [
        `vis_shop.${"A".repeat(22)}.mw2dkm7v.32-${"0".repeat(16)}.${"0".repeat(32)}`,
        `vis_shop.${"A".repeat(22)}.mw2dkm7v.-.${"0".repeat(32)}`,
        flipped,
        `vis_site.${rest}`,
        elsewhere,
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
      assertEquals((await route.json()).kind, "anonymous");
    }
    assertEquals(line, "shop");
    // The one cookie that's her is her.
    assertEquals((await connect(serve, { cookie: carla.cookie })).said.actor!.id, id);

    // Ana, who manages the shop, erases her: her cookie is no one from now on, asking or not.
    await runtime.call("contact.forget", { contact: id }, { actor: ana });
    const gone = await connect(serve, { cookie: carla.cookie });
    assertEquals(gone.status, 401);
    assertMatch(gone.set!, /^visitor=; .*Max-Age=0/);
    const anew = await connect(serve, { cookie: carla.cookie, body: { line: "shop" } });
    assertEquals(anew.status, 200);
    assertNotEquals(anew.said.actor!.id, id);
  });
});

test("limits on coming in: by address, that address alone, never the whole line; by the socket's without a front", async () => {
  await setup(async ({ serve, runtime, tickets }) => {
    const arrive = (from: string | false, line = "site") =>
      connect(serve, { from, body: { line } });
    const FROM_HERE = "Too many new visitors from here: try again later.";
    const a1 = await arrive("203.0.113.7");
    const a2 = await arrive("203.0.113.7");
    assertEquals([a1.status, a2.status], [200, 200]);
    const a3 = await arrive("203.0.113.7");
    assertEquals([a3.status, a3.said.error, a3.retry, a3.set], [429, FROM_HERE, "60", null]);
    // Someone already in isn't new: their cookie still connects.
    const a1back = await connect(serve, {
      from: "203.0.113.7",
      cookie: a1.cookie,
      body: { line: "site" },
    });
    assertEquals(a1back.said.actor, a1.said.actor);
    // Everyone else comes in still: the line takes newcomers from as many networks as come.
    for (let n = 0; n < 30; n++) {
      assertEquals((await arrive(`198.51.${n}.7`)).status, 200, `198.51.${n}.7`);
      assertEquals((await arrive(`2001:db8:${(0x100 + n).toString(16)}::1`)).status, 200);
    }
    // An IPv6 caller is counted by its /64: one network, one allowance (2, on this line).
    for (const [from, status] of [["2001:db8:1::1", 200], ["2001:db8:1::2", 200]] as const) {
      assertEquals((await arrive(from, "burst")).status, status, from);
    }
    const sameNet = await arrive("2001:db8:1::ffff", "burst");
    assertEquals([sameNet.status, sameNet.said.error], [429, FROM_HERE]);
    assertEquals((await arrive("2001:db8:1:1::1", "burst")).status, 200);
    // Its neighbours count too: a /56 takes four /64s' worth (8), a /48 eight (16), an IPv4 /24
    // eight addresses' (16). Past one, the next from anywhere in it is refused; elsewhere, not.
    const fill = async (froms: string[]) => {
      const statuses = [];
      for (const from of froms) statuses.push((await arrive(from, "burst")).status);
      return statuses.filter((s) => s === 200).length;
    };
    const ones = (n: number, at: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => at(i));
    assertEquals(await fill(ones(12, (i) => `2001:db8:2:${i.toString(16)}::1`)), 8);
    assertEquals(
      await fill(ones(24, (i) => `2001:db8:3:${(i * 0x100).toString(16)}::1`)),
      16,
    );
    assertEquals(await fill(ones(24, (i) => `203.0.112.${i + 1}`)), 16);
    assertEquals((await arrive("2001:db8:4::1", "burst")).status, 200);
    assertEquals((await arrive("203.0.111.1", "burst")).status, 200);

    // Around the front (without its secret, whatever address it claims): refused.
    const around = await arrive(false, "shop");
    assertEquals([around.status, around.said.error], [403, "Not through the app's front."]);
    const claimed = await connect(serve, {
      from: false,
      headers: { "cf-connecting-ip": "192.0.2.1" },
      body: { line: "shop" },
    });
    assertEquals(claimed.status, 403);

    // Many at once from one address can't pass its limit: places are taken one write each.
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => arrive("192.0.2.200", "burst")),
    );
    assertEquals(burst.filter((b) => b.status === 200).length, 2);
    assertEquals(burst.filter((b) => b.status === 429).length, 10);

    // New visitors who speak an hour, on the line (3 here): past them, a newcomer's first message
    // waits; those already speaking go on, and anyone still comes in.
    const speak = async (arrived: { said: { ticket?: string } }) =>
      await runtime.call("chat.send", { text: "hi" }, {
        actor: tickets.admit(arrived.said.ticket!),
      }).then(() => "sent", (e) => (e as Error).message);
    const comers = await Promise.all(
      ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"].map((from) => arrive(from)),
    );
    const said = [];
    for (const comer of comers) said.push(await speak(comer));
    assertEquals(said, [
      "sent",
      "sent",
      "sent",
      "This chat is busy right now: try again in a few minutes.",
    ]);
    assertEquals(await count(runtime), 3);
    const talker = await connect(serve, { from: "192.0.2.1", cookie: comers[0].cookie });
    assertEquals(await speak(talker), "sent");
    assertEquals((await arrive("192.0.2.9")).status, 200);
  }, { plugins: [keptContacts], limits: { ipVisitorsPerHour: 2, visitorsPerHour: 3 } });

  // Without a front that says who calls, the socket's address does (as the listener saw it).
  await setup(async ({ serve }) => {
    const arrive = (address?: string) => {
      const asked = new Request(`${PAGE}/connect`, {
        method: "POST",
        headers: { origin: PAGE, "content-type": "application/json" },
        body: JSON.stringify({ line: "site" }),
      });
      return serve(address ? setClientAddress(asked, address) : asked)
        .then(async (r) => [r.status, (await r.json()).error]);
    };
    assertEquals(await arrive("192.0.2.7"), [200, undefined]);
    assertEquals(await arrive("192.0.2.7"), [200, undefined]);
    assertEquals(await arrive("192.0.2.7"), [
      429,
      "Too many new visitors from here: try again later.",
    ]);
    assertEquals(await arrive("::ffff:192.0.2.8"), [200, undefined]);
    // With neither, nobody's let in: never in with no limit by address.
    const logged = console.error;
    const said: unknown[] = [];
    console.error = (...args: unknown[]) => void said.push(args);
    try {
      assertEquals(await arrive(), [500, "Couldn't connect"]);
    } finally {
      console.error = logged;
    }
    assertMatch(JSON.stringify(said), /no way to tell visitors apart/);
  }, { caller: false, limits: { ipVisitorsPerHour: 2 } });
});

test("a visitor's line removed: its visitors are no one, at once", async () => {
  const store = memoryStore();
  const lines = (declared: boolean) =>
    definePlugin({
      name: "app",
      resources: {
        agents: { guide: { instructions: "Help visitors.", model: "fake/echo" } },
        spaces: { visitors: { name: "Website", agents: ["guide"] } },
        web: declared ? { site: { in: "visitors", agent: "guide" } } : {},
        links: LINKS,
      },
    });
  const tickets = createTickets();
  const first = await createRuntime({
    store,
    plugins: [models, chat, ...access, webLines, lines(true)],
  });
  let cookie: string | undefined;
  let quiet: string | undefined;
  try {
    const serve = webServer({ runtime: first, tickets });
    const came = await connect(serve, {
      from: false,
      address: "192.0.2.1",
      body: { line: "site" },
    });
    cookie = came.cookie;
    await first.call("chat.send", { text: "hi" }, { actor: tickets.admit(came.said.ticket!) });
    quiet = (await connect(serve, { from: false, address: "192.0.2.2", body: { line: "site" } }))
      .cookie;
    assertEquals((await connect(serve, { from: false, cookie })).status, 200);
  } finally {
    await first.close();
  }
  const then = await createRuntime({
    store,
    plugins: [models, chat, ...access, webLines, lines(false)],
  });
  try {
    const serve = webServer({ runtime: then, tickets });
    for (const held of [cookie, quiet]) {
      assertEquals((await connect(serve, { from: false, cookie: held })).status, 401);
      assertEquals(
        (await connect(serve, { from: false, cookie: held, body: { line: "site" } })).status,
        401,
      );
    }
  } finally {
    await then.close();
  }
});

test("what's past goes: visitors' records past their time, counters, and contacts never heard", async () => {
  await setup(async ({ serve, runtime, tickets }) => {
    const admitted = async (from: string) =>
      tickets.admit((await connect(serve, { from, body: { line: "site" } })).said.ticket!)!;
    // One speaks; one is made a contact for a first message that never went in.
    const talker = await admitted("192.0.2.1");
    const { thread } = await runtime.call<{ thread: string }>("chat.send", { text: "hi" }, {
      actor: talker,
    });
    const silent = await admitted("192.0.2.2");
    await runtime.call("test.unsent", {}, { actor: silent });
    assertEquals(await count(runtime), 2);
    // Ten minutes on, and more: the one never heard goes, with its chat; the other stays, heard.
    await runtime.call("test.age", { ms: 11 * 60_000 });
    assertEquals(await runtime.call("contact.prune", {}), { gone: 1 });
    assertEquals(await read(runtime, "all-contacts"), [`${talker.id} visitors web`]);
    assertEquals(await read<string[]>(runtime, "chats-of", talker.id), [thread]);
    assertEquals((await kept(runtime)).visitors, 1);
    // Past its time (its cookie's), its record goes; its contact and chat stay, the space's.
    await runtime.call("test.age", { ms: 31 * 86_400_000 });
    await runtime.call("contact.prune", {});
    assertEquals(await kept(runtime), { contacts: 1, threads: 1, members: 2, visitors: 0 });
    assertEquals(await read(runtime, "rates"), []);
  }, { plugins: [keptContacts, aging] });
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
      // Dev sign-in is this machine's alone, never through the front: from here, its page is all.
      const body = path === "/connect" ? { line: "site" } : { name: "ana" };
      const here = path === "/signin/dev" ? { from: false as const } : {};
      await refused(path, { origin: "https://evil.example", body, ...here }, "another site");
      await refused(path, { origin: "null", body, ...here }, "an opaque origin");
      await refused(path, { origin: "http://localhost:9999", body, ...here }, "another port");
      await refused(
        path,
        { headers: { "sec-fetch-site": "cross-site" }, body, ...here },
        "fetch metadata",
      );
      await refused(
        path,
        { headers: { "sec-fetch-site": "same-site" }, body, ...here },
        "a sibling",
      );
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
    // Signed in by name from this machine (never through the front: that's not this machine).
    const signed = await serve(request("/signin/dev", { body: { name: "ana" }, from: false }));
    const session = sent(signed)!;
    assertMatch(signed.headers.get("set-cookie")!, /^session=ses_[^;]+; HttpOnly; SameSite=Lax;/);
    const visitor = await connect(serve, { body: { line: "site" } });
    for (const cookie of [session, `${session}; ${visitor.cookie}`]) {
      const in_ = await connect(serve, { cookie, body: { line: "site" } });
      assertEquals([in_.said.actor, in_.said.name, in_.set], [ana, "ana", null]);
    }
    assertEquals(await count(runtime), 0);
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
      webLines,
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
    assertEquals(await plain("POST", "/who"), [200, '{"kind":"anonymous","id":""}', null]);
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
  // A way to sign in, as one is: unrecorded, its answer a session.
  const magic = definePlugin({
    name: "magic",
    actions: {
      "magic.in": defineAction({ input: { type: "object" }, record: false, run: () => ({}) }),
    },
  });
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
      plugins: [identity, magic, declaring(resources)],
    });
    try {
      assertThrows(() => webServer({ runtime }), Error, said);
    } finally {
      await runtime.close();
    }
  }
  // A web site's settings, as the app starts.
  const lines: [Record<string, unknown>, string][] = [
    [{ web: { site: { agent: "guide" } } }, "needs its in"],
    [{ web: { site: { in: "s", agent: "nobody" } } }, "isn't one of the app's agents"],
    [{ web: { site: { in: "s", limits: { perHour: 3 } } } }, "isn't a limit"],
    [{ web: { site: { in: "s", files: { count: 0 } } } }, "files.count is a whole number"],
    [{ web: { site: { in: "s", files: { bytes: 50_000_000 } } } }, "10000000 at most"],
    [{ web: { site: { in: "s", files: { size: 1 } } } }, "files.size isn't one"],
    [{ web: { site: { in: "s", transcribe: "yes" } } }, "its transcribe is true or false"],
    // Visitors' secrets are signed with the app's: a line needs it.
    [{ web: { site: { in: "s" } } }, "the app's secret"],
    [{ web: { site: { in: "s", limits: { visitorsPerHour: 0 } } } }, "a whole number over 0"],
    [{ web: { site: { in: "s", days: 500 } } }, "400 at most"],
    [{ web: { "a b": { in: "s" } } }, "its name"],
    [{ caller: { header: "x-forwarded-for" } }, "why its header is believed"],
    [{ caller: { header: "x-forwarded-for", front: FRONT } }, "say its hops"],
  ];
  for (const [declared, said] of lines) {
    let started: Runtime | undefined;
    try {
      started = await createRuntime({
        store: memoryStore(),
        plugins: [
          ...access,
          webLines,
          declaring({ ...declared, agents: { guide: { instructions: "", model: "x" } } }),
        ],
      });
      assert(false, `started with ${JSON.stringify(declared)}`);
    } catch (error) {
      assertMatch((error as Error).message, new RegExp(said), JSON.stringify(declared));
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
