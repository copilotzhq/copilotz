/**
 * Who a browser is, as the app's plugins say it, through `runtime.fetch`: a
 * signed-in person is their session's (identity's `who`), first; a browser
 * that's no one comes in by a web line when its page posts `/web/<line>`, a
 * visitor whose secret (signed: no record is made) is in an httpOnly,
 * SameSite=Strict cookie that the web lines' `who` reads, the same visitor
 * while it lasts, and a contact in the line's space with a chat of its own
 * once it speaks. A forged cookie is no one, and never the visitor it
 * imitates; an erased contact's cookie is no one at once, and so is a
 * removed line's. New visitors are limited by the caller's address (as the
 * app's front says it, else as the socket's), at once too, refused plainly
 * past it, that address alone; and new visitors who speak, on the line.
 * What's past is collected. Coming in, signing in and out come from the
 * app's own page only. What the app declares is checked as it starts.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Plugin,
  type Route,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../../plugins/models/mod.ts";
import { chat } from "../../../plugins/agents/chat/mod.ts";
import { access, devSignIn, googleSignIn } from "../../../plugins/access/mod.ts";
import { webLines } from "../../../plugins/interfaces/web/lines.ts";
import { test } from "../../../testing/mod.ts";
import { webPage } from "../server.ts";

const ana: Actor = { kind: "person", id: "ana" };
/** The app's front's secret: it vouches for the caller's address it sends. */
const FRONT = "the-front-secret-for-tests-0123";
const PAGE = "http://localhost:8790";

/** A route that says who it was called as. */
const whoRoute: Route = (_request, { actor }) => Response.json({ kind: actor.kind, id: actor.id });
const who = definePlugin({ name: "who", routes: { "/who": whoRoute } });

/** The app's secret, which visitors' cookies are signed with. */
const LINKS = { origin: PAGE, secret: "the-app-secret-for-tests-0123456789" };

/**
 * An app with two web lines: `site`, in a space it declares, answered by
 * its guide; `shop`, in a space Ana made (she manages it), and `burst`,
 * for arrivals at once. Its front says who calls (`cf-connecting-ip`).
 */
const app = (limits: Record<string, number> = {}, caller = true, links = LINKS) =>
  definePlugin({
    name: "app",
    resources: {
      agents: { guide: { instructions: "Help visitors.", model: "fake/echo" } },
      spaces: { visitors: { name: "Website", agents: ["guide"] } },
      links,
      // The front is the runtime's (it believes the host the front forwards); the web lines
      // read who calls from their own settings.
      ...(caller ? { caller: { header: "cf-connecting-ip", front: FRONT } } : {}),
      web: {
        ...(caller ? { caller: { header: "cf-connecting-ip", front: FRONT } } : {}),
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
};

async function setup(
  fn: (s: Setup) => Promise<void>,
  options: { plugins?: Plugin[]; limits?: Record<string, number>; caller?: false } = {},
) {
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
    await fn({ serve: (request) => runtime.fetch(request), runtime });
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

type Answered = {
  status: number;
  said: { ticket?: string; actor?: Actor; error?: string };
  cookie: string | undefined;
  set: string | null;
  retry: string | null;
};

const answered = async (response: Response): Promise<Answered> => ({
  status: response.status,
  said: await response.json(),
  cookie: sent(response),
  set: response.headers.get("set-cookie"),
  retry: response.headers.get("retry-after"),
});

/** A page coming in by a web line (`POST /web/<line>`): the answer and the cookie it sets. */
const arrive = async (serve: Setup["serve"], line: string, asked: Asked = {}) =>
  answered(await serve(request(`/web/${encodeURIComponent(line)}`, asked)));

/** Connects (`POST /connect`): a ticket for whoever the cookies say. */
const connect = async (serve: Setup["serve"], asked: Asked = {}) =>
  answered(await serve(request("/connect", asked)));

/** Coming in by a line, then connecting with the cookie it set (else the one it was sent). */
async function come(serve: Setup["serve"], line: string, asked: Asked = {}) {
  const arrived = await arrive(serve, line, asked);
  if (arrived.status !== 200) return arrived;
  const connected = await connect(serve, { ...asked, cookie: arrived.cookie ?? asked.cookie });
  return { ...connected, set: arrived.set, cookie: arrived.cookie ?? asked.cookie };
}

/** The visitor a cookie is, as the server issued it (its line and its networks' tags). */
const visitorOf = (runtime: Runtime, cookie: string) =>
  runtime.query<Actor | null>("contact_visitor.actor", {
    secret: cookie.slice(cookie.indexOf("=") + 1),
  });

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
        }).value ?? []).map((m) => m.space.slice("thread:".length)),
    },
    kept: {
      test: (_: unknown, ctx) => ({
        contacts: (ctx.db.collection("contact").find({}).value ?? []).length,
        threads: (ctx.db.collection("thread").find({}).value ?? []).length,
        members: (ctx.db.collection<{ member: string }>("member").find({}).value ?? [])
          .filter((m) => m.member.startsWith("contact:")).length,
        visitors: (ctx.db.collection("contact_visitor").find({}).value ?? []).length,
      }),
    },
    rates: { test: (_: unknown, ctx) => ctx.db.collection("contact_rate").find({}).value ?? [] },
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
  await setup(async ({ serve, runtime }) => {
    // The page asks for nothing: nobody, and nobody's made.
    assertEquals((await connect(serve)).status, 401);
    const nowhere = await arrive(serve, "nowhere");
    assertEquals([nowhere.status, nowhere.said.error], [404, "There's no such chat here."]);
    assertEquals(nowhere.set, null);

    const first = await come(serve, "site");
    assertEquals(first.status, 200);
    const visitor = first.said.actor!;
    assertEquals(visitor.kind, "contact");
    assertMatch(visitor.id, /^c-[0-9a-f]{24}$/);
    // Its secret: signed, in an httpOnly cookie only the app's own pages send, for its 30 days.
    assertMatch(
      first.set!,
      /^visitor=vis_site\.[\w-]{22}\.[0-9a-z]+\.32-[0-9a-f]{16}~24-[0-9a-f]{16}\.[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d{7}$/,
    );
    // The visitor the server issued: its line, and its networks' tags (an IPv4 address, its /24),
    // what its messages are counted by; never the address.
    const actor = (await visitorOf(runtime, first.cookie!))!;
    const { from: _, ...whoIs } = actor;
    assertEquals(whoIs, { kind: "contact", id: visitor.id, web: "site" });
    assertEquals((actor.from as string[]).map((tag) => tag.split("-")[0]), ["32", "24"]);
    assert(!JSON.stringify(actor).includes("203.0.113"));
    // Coming in made nothing, however many come: no contact, chat, membership, nor record.
    for (let i = 0; i < 5; i++) await come(serve, "site");
    assertEquals(await kept(runtime), { contacts: 0, threads: 0, members: 0, visitors: 0 });
    // Back with its cookie, asking again: the same visitor, though it's said nothing.
    const back = await come(serve, "site", { cookie: first.cookie });
    assertEquals([back.status, back.said.actor, back.set], [200, visitor, null]);
    // On another line's page, before it speaks: another visitor, that line's.
    const shop = await come(serve, "shop", { cookie: first.cookie });
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
    const again = await come(serve, "site", { cookie: first.cookie });
    assertEquals([again.status, again.said.actor, again.set], [200, visitor, null]);
    assertEquals((await connect(serve, { cookie: first.cookie })).said.actor, visitor);
    assertEquals(await count(runtime), 1);
    // A route is asked as it too.
    const route = await serve(
      new Request(`${PAGE}/who`, { method: "POST", headers: { cookie: first.cookie! } }),
    );
    assertEquals(await route.json(), visitor);

    // Off this machine, the cookie is Secure, and this host's alone: `__Host-`, so no other host
    // under the domain (a preview's) can set one to make a browser a visitor of its choosing.
    const url = "https://app.example";
    const secure = await come(serve, "site", { url });
    assertEquals(secure.status, 200);
    assertMatch(
      secure.set!,
      /^__Host-visitor=vis_site\.[^;]+; HttpOnly; SameSite=Strict; Path=\/; .*; Secure$/,
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

test("a forged cookie is no one: never the visitor it imitates; an erased visitor's, at once", async () => {
  await setup(async ({ serve, runtime }) => {
    const carla = await come(serve, "shop");
    assertEquals(carla.status, 200, carla.said.error);
    const { id } = carla.said.actor!;
    await runtime.call("chat.send", { text: "hello" }, {
      actor: (await visitorOf(runtime, carla.cookie!))!,
    });
    await runtime.idle();
    const secret = carla.cookie!.slice("visitor=".length);
    const [, line, rest] = /^vis_(\w+)\.(.*)$/.exec(secret)!;
    const flipped = secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a");
    // One the app made for another app (its own secret), and this one moved to another line.
    const other = await createRuntime({
      store: memoryStore(),
      plugins: [
        models,
        chat,
        ...access,
        webLines,
        app({}, true, { ...LINKS, secret: "another-app-secret-for-tests-01234567" }),
      ],
    });
    const elsewhere = await (async () => {
      try {
        const answer = await other.fetch(request("/web/shop"));
        return answer.headers.get("set-cookie")!.split(";")[0].slice("visitor=".length);
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
      assertEquals(
        tried.status,
        401,
        `${
          forged === elsewhere ? "elsewhere" : forged === flipped ? "flipped" : forged.slice(0, 20)
        }`,
      );
      // Asking to come in with it makes someone new, never Carla.
      const fresh = await come(serve, "shop", { cookie: `visitor=${forged}` });
      assertEquals(fresh.status, 200);
      assertNotEquals(fresh.said.actor!.id, id);
      assertMatch(fresh.set!, /^visitor=vis_shop\./);
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
    await runtime.idle();
    const gone = await connect(serve, { cookie: carla.cookie });
    assertEquals(gone.status, 401);
    const anew = await come(serve, "shop", { cookie: carla.cookie });
    assertEquals(anew.status, 200);
    assertNotEquals(anew.said.actor!.id, id);
  });
});

test("limits on coming in: by address, that address alone, never the whole line; by the socket's without a front", async () => {
  await setup(async ({ serve, runtime }) => {
    const arrival = (from: string | false, line = "site") => arrive(serve, line, { from });
    const FROM_HERE = "Too many new visitors from here: try again later.";
    const a1 = await arrival("203.0.113.7");
    const a2 = await arrival("203.0.113.7");
    assertEquals([a1.status, a2.status], [200, 200]);
    const a3 = await arrival("203.0.113.7");
    assertEquals([a3.status, a3.said.error, a3.retry, a3.set], [429, FROM_HERE, "60", null]);
    // Someone already in isn't new: their cookie still comes in.
    const a1back = await come(serve, "site", { from: "203.0.113.7", cookie: a1.cookie });
    assertEquals([a1back.status, a1back.set], [200, null]);
    // Everyone else comes in still: the line takes newcomers from as many networks as come.
    for (let n = 0; n < 30; n++) {
      assertEquals((await arrival(`198.51.${n}.7`)).status, 200, `198.51.${n}.7`);
      assertEquals((await arrival(`2001:db8:${(0x100 + n).toString(16)}::1`)).status, 200);
    }
    // An IPv6 caller is counted by its /64: one network, one allowance (2, on this line).
    for (const [from, status] of [["2001:db8:1::1", 200], ["2001:db8:1::2", 200]] as const) {
      assertEquals((await arrival(from, "burst")).status, status, from);
    }
    const sameNet = await arrival("2001:db8:1::ffff", "burst");
    assertEquals([sameNet.status, sameNet.said.error], [429, FROM_HERE]);
    assertEquals((await arrival("2001:db8:1:1::1", "burst")).status, 200);
    // Its neighbours count too: a /56 takes four /64s' worth (8), a /48 eight (16), an IPv4 /24
    // eight addresses' (16). Past one, the next from anywhere in it is refused; elsewhere, not.
    const fill = async (froms: string[]) => {
      const statuses = [];
      for (const from of froms) statuses.push((await arrival(from, "burst")).status);
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
    assertEquals((await arrival("2001:db8:4::1", "burst")).status, 200);
    assertEquals((await arrival("203.0.111.1", "burst")).status, 200);

    // Around the front (without its secret, whatever address it claims): refused.
    const around = await arrival(false, "shop");
    assertEquals([around.status, around.said.error], [403, "Not through the app's front."]);
    const claimed = await arrive(serve, "shop", {
      from: false,
      headers: { "cf-connecting-ip": "192.0.2.1" },
    });
    assertEquals(claimed.status, 403);

    // Many at once from one address can't pass its limit: places are taken one write each.
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => arrival("192.0.2.200", "burst")),
    );
    assertEquals(burst.filter((b) => b.status === 200).length, 2);
    assertEquals(burst.filter((b) => b.status === 429).length, 10);

    // New visitors who speak an hour, on the line (3 here): past them, a newcomer's first message
    // waits; those already speaking go on, and anyone still comes in.
    const speak = async (arrived: { cookie?: string }) =>
      await runtime.call("chat.send", { text: "hi" }, {
        actor: (await visitorOf(runtime, arrived.cookie!))!,
      }).then(() => "sent", (e) => (e as Error).message);
    const comers = await Promise.all(
      ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"].map((from) => arrival(from)),
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
    assertEquals(await speak(comers[0]), "sent");
    assertEquals((await arrival("192.0.2.9")).status, 200);
  }, { plugins: [keptContacts], limits: { ipVisitorsPerHour: 2, visitorsPerHour: 3 } });

  // Without a front that says who calls, the socket's address does (as the listener saw it).
  await setup(async ({ serve }) => {
    const arrival = (address?: string) => {
      const asked = new Request(`${PAGE}/web/site`, {
        method: "POST",
        headers: { origin: PAGE, "content-type": "application/json" },
        body: "{}",
      });
      return serve(address ? setClientAddress(asked, address) : asked)
        .then(async (r) => [r.status, (await r.json()).error]);
    };
    assertEquals(await arrival("192.0.2.7"), [200, undefined]);
    assertEquals(await arrival("192.0.2.7"), [200, undefined]);
    assertEquals(await arrival("192.0.2.7"), [
      429,
      "Too many new visitors from here: try again later.",
    ]);
    assertEquals(await arrival("::ffff:192.0.2.8"), [200, undefined]);
    // With neither, nobody's let in: never in with no limit by address.
    const logged = console.error;
    const said: unknown[] = [];
    console.error = (...args: unknown[]) => void said.push(args);
    try {
      assertEquals(await arrival(), [500, "Something went wrong"]);
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
        web: { lines: declared ? { site: { in: "visitors", agent: "guide" } } : {} },
        links: LINKS,
      },
    });
  const first = await createRuntime({
    store,
    plugins: [models, chat, ...access, webLines, lines(true)],
  });
  let cookie: string | undefined;
  let quiet: string | undefined;
  try {
    const serve = (r: Request) => first.fetch(r);
    const came = await come(serve, "site", { from: false, address: "192.0.2.1" });
    cookie = came.cookie;
    await first.call("chat.send", { text: "hi" }, { actor: (await visitorOf(first, cookie!))! });
    quiet = (await come(serve, "site", { from: false, address: "192.0.2.2" })).cookie;
    assertEquals((await connect(serve, { from: false, cookie })).status, 200);
  } finally {
    await first.close();
  }
  const then = await createRuntime({
    store,
    plugins: [models, chat, ...access, webLines, lines(false)],
  });
  try {
    const serve = (r: Request) => then.fetch(r);
    for (const held of [cookie, quiet]) {
      assertEquals((await connect(serve, { from: false, cookie: held })).status, 401);
      // Asking to come in by the removed line: there's no such chat.
      assertEquals((await arrive(serve, "site", { from: false, cookie: held })).status, 404);
    }
  } finally {
    await then.close();
  }
});

test("what's past goes: visitors' records past their time, counters, and contacts never heard", async () => {
  await setup(async ({ serve, runtime }) => {
    const admitted = async (from: string) =>
      (await visitorOf(runtime, (await come(serve, "site", { from })).cookie!))!;
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

test("coming in, signing in and out come from the app's own page only", async () => {
  await setup(async ({ serve, runtime }) => {
    const refused = async (path: string, asked: Asked, why: string) => {
      const answer = await serve(request(path, asked));
      assertEquals(answer.status, 403, `${path}: ${why}`);
      assertEquals(answer.headers.get("set-cookie"), null, `${path}: ${why}`);
      await answer.body?.cancel();
    };
    for (const path of ["/connect", "/web/site", "/signin/dev", "/signout"]) {
      // Dev sign-in is this machine's alone, never through the front: from here, its page is all.
      const body = path === "/signin/dev" ? { name: "ana" } : {};
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
    await refused("/web/site", { url: "http://app.example", origin: "http://app.example" }, "http");
    // Nobody was let in, nor signed in.
    assertEquals(await count(runtime), 0);

    // The app's own page, or no browser at all, is let in.
    assertEquals((await arrive(serve, "site")).status, 200);
    assertEquals((await arrive(serve, "site", { origin: null })).status, 200);
    const same = await arrive(serve, "site", { headers: { "sec-fetch-site": "same-origin" } });
    assertEquals(same.status, 200);

    // Behind the front, the page's origin is the host the front forwards, with its secret only.
    const inside = "http://10.0.0.7:8080";
    const forwarded = { url: inside, origin: "https://app.example" };
    assertEquals(
      (await arrive(serve, "shop", {
        ...forwarded,
        headers: { "x-forwarded-host": "app.example" },
      }))
        .status,
      200,
    );
    // Without the secret, the forwarded host is no one's word: the origin isn't this host.
    await refused("/web/shop", {
      ...forwarded,
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
    const visitor = await come(serve, "site");
    for (const cookie of [session, `${session}; ${visitor.cookie}`]) {
      const arrived = await arrive(serve, "site", { cookie });
      assertEquals([arrived.status, arrived.set], [200, null]);
      const in_ = await connect(serve, { cookie });
      assertEquals([in_.said.actor, in_.set], [ana, null]);
    }
    assertEquals(await count(runtime), 0);
    const me = await serve(new Request(`${PAGE}/me`, { headers: { cookie: session } }));
    assertEquals((await me.json()).person, "ana");
    // Signing out ends her session and clears its cookie: the visitor's is another credential.
    const out = await serve(request("/signout", { cookie: `${session}; ${visitor.cookie}` }));
    assertEquals(out.headers.getSetCookie().map((c) => c.split(";")[0]), ["session="]);
    assertEquals((await connect(serve, { cookie: session })).status, 401);
    // What she held for a visitor, she is again.
    assertEquals(
      (await connect(serve, { cookie: `${session}; ${visitor.cookie}` })).said.actor,
      visitor.said.actor,
    );
  }, { plugins: [keptContacts] });
});

test("a plugin's sign-in routes are there when the plugin is, and ask for what they need", async () => {
  const google = definePlugin({
    name: "g",
    resources: { google: { clientId: ["web.apps", "ios.apps"] } },
  });
  const withGoogle = await createRuntime({
    store: memoryStore(),
    plugins: [...access, devSignIn, googleSignIn, google],
  });
  const plain = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    const here = (path: string, init: RequestInit = {}) =>
      setClientAddress(new Request(`${PAGE}${path}`, init), "127.0.0.1");
    // The page asks what it can offer: dev sign-in is there from this machine (`{}`), Google's
    // client id (the first) is anyone's, kept five minutes.
    const dev = await withGoogle.fetch(here("/signin/dev"));
    assertEquals([dev.status, await dev.json()], [200, {}]);
    const elsewhere = await withGoogle.fetch(new Request("http://app.example/signin/dev"));
    assertEquals(elsewhere.status, 404);
    await elsewhere.body?.cancel();
    const client = await withGoogle.fetch(new Request(`${PAGE}/google`));
    assertEquals(await client.json(), { clientId: "web.apps" });
    assertEquals(client.headers.get("cache-control"), "public, max-age=300");
    // Google's button posts its token: a body it can't read is refused before any call.
    const bad = await withGoogle.fetch(request("/signin/google", { body: {}, from: false }));
    assertEquals([bad.status, (await bad.json()).error], [400, "Send { idToken }"]);
    // Without the plugins, there are no such routes.
    for (const path of ["/signin/dev", "/signin/google", "/google"]) {
      const answer = await plain.fetch(here(path));
      assertEquals(answer.status, 404, path);
      await answer.body?.cancel();
    }
  } finally {
    await withGoogle.close();
    await plain.close();
  }
});

test("without the web page, the page's paths are 404s; the routes of plugins still answer", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [...access, webLines, devSignIn, who, app(), keptContacts],
  });
  try {
    const plain = async (method: string, path: string) => {
      const answer = await runtime.fetch(
        new Request(`${PAGE}${path}`, { method, headers: { origin: PAGE } }),
      );
      return [answer.status, await answer.text(), answer.headers.get("set-cookie")];
    };
    for (
      const [method, path] of [
        ["GET", "/"],
        ["GET", "/app/app.js"],
        ["GET", "/manifest.webmanifest"],
        ["GET", "/sw.js"],
        ["GET", "/assets/copilotz/fonts.css"],
        ["GET", "/somewhere"],
        ["POST", "/signin/google"],
      ] as const
    ) {
      assertEquals(await plain(method, path), [404, "Not found", null], `${method} ${path}`);
    }
    assertEquals(await plain("GET", "/health"), [200, "ok", null]);
    assertEquals(await plain("POST", "/who"), [200, '{"kind":"anonymous","id":""}', null]);
    assertEquals(await count(runtime), 0);
  } finally {
    await runtime.close();
  }
  // With the page, the same paths are the page's (and a script's fetch is still a 404).
  const withPage = await createRuntime({
    store: memoryStore(),
    plugins: [
      ...access,
      webPage,
      definePlugin({
        name: "settings",
        resources: { page: { code: { entry: "app.js", files: { "app.js": "" } } } },
      }),
    ],
  });
  try {
    const page = await withPage.fetch(new Request(`${PAGE}/somewhere`));
    assertEquals(page.headers.get("content-type"), "text/html; charset=utf-8");
    await page.body?.cancel();
    const fetched = await withPage.fetch(
      new Request(`${PAGE}/somewhere`, { headers: { accept: "application/json" } }),
    );
    assertEquals(fetched.status, 404);
    await fetched.body?.cancel();
  } finally {
    await withPage.close();
  }
});

test("what the app declares is checked as it starts", async () => {
  const declaring = (resources: Record<string, unknown>) =>
    definePlugin({ name: "declaring", resources } as Parameters<typeof definePlugin>[0]);
  // A web line's settings, as the app starts.
  const lines: [Record<string, unknown>, string][] = [
    [{ lines: { site: { agent: "guide" } } }, "needs its in"],
    [{ lines: { site: { in: "s", agent: "nobody" } } }, "isn't one of the app's agents"],
    [{ lines: { site: { in: "s", limits: { perHour: 3 } } } }, "isn't a limit"],
    [{ lines: { site: { in: "s", files: { count: 0 } } } }, "files.count is a whole number"],
    [{ lines: { site: { in: "s", files: { bytes: 50_000_000 } } } }, "10000000 at most"],
    [{ lines: { site: { in: "s", files: { size: 1 } } } }, "files.size isn't one"],
    [{ lines: { site: { in: "s", transcribe: "yes" } } }, "its transcribe is true or false"],
    // Visitors' secrets are signed with the app's: a line needs it.
    [{ lines: { site: { in: "s" } } }, "the app's secret"],
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
          webLines,
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
    for (const path of ["/web/site", "/signin/dev"]) {
      const tried = await serve(
        setClientAddress(
          new Request(`${PAGE}${path}`, {
            method: "POST",
            headers: { origin: PAGE, "content-type": "application/json" },
            body: JSON.stringify({ name: "ana", padding: "x".repeat(20_000) }),
          }),
          "127.0.0.1",
        ),
      );
      assertEquals(tried.status, 400, path);
      await tried.body?.cancel();
      for (const body of ["[1]", '"site"', "{", "null"]) {
        const answer = await serve(
          setClientAddress(
            new Request(`${PAGE}${path}`, { method: "POST", headers: { origin: PAGE }, body }),
            "127.0.0.1",
          ),
        );
        assertEquals(answer.status, 400, `${path} ${body}`);
        await answer.body?.cancel();
      }
    }
    assertEquals(await count(runtime), 0);
  }, { plugins: [keptContacts] });
});
