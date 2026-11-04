/**
 * Cookies from before they were the host's alone. Over https a host-only
 * entrance's cookie is `__Host-<name>` (the default now: `hostOnly: false`
 * keeps the plain name); a browser signed in before still holds the plain
 * one. On connecting and on signing out, what it holds there ends (so a
 * host reading the plain name again, rolled back, finds no one) and goes.
 * Over plain http to this machine, the plain name is the current one, and
 * stays.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { identity } from "../../../plugins/access/identity/mod.ts";
import { test } from "../../../testing/mod.ts";
import { whomOf } from "../entrances.ts";
import { createTickets } from "../tickets.ts";
import { webServer } from "../server.ts";

/** A page's POST to `site`, from its own origin, with these cookies. */
const post = (
  serve: (r: Request) => Promise<Response>,
  site: string,
  path: string,
  cookie: string,
) =>
  serve(
    new Request(`${site}${path}`, {
      method: "POST",
      headers: { origin: site, cookie, "content-type": "application/json" },
      body: "{}",
    }),
  );

/** The cookies an answer sets, `name=value`, and which of them it clears. */
const setOf = (answer: Response) => {
  const all = answer.headers.getSetCookie();
  return {
    set: all.filter((c) => !/Max-Age=0/.test(c)).map((c) => c.split(";")[0].split("=")[0]),
    cleared: all.filter((c) => /Max-Age=0/.test(c)).map((c) => c.split("=")[0]).sort(),
  };
};

test("over https, a session still under its plain name ends and goes, on connecting and signing out", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [identity] });
  try {
    const serve = webServer({ runtime, tickets: createTickets() });
    const start = async () =>
      (await runtime.call<{ session: string }>("session.start", { person: "ana" })).session;
    const who = (secret: string) => runtime.query<Actor | null>("credential.actor", { secret });
    const site = "https://app.example.com";
    const [old, now] = [await start(), await start()];

    // Connecting: she's who `__Host-session` says; the plain one's session ends, and it goes.
    const connected = await post(serve, site, "/connect", `session=${old}; __Host-session=${now}`);
    assertEquals(connected.status, 200);
    assertEquals((await connected.json()).actor, { kind: "person", id: "ana" });
    console.log(`connecting with a plain session cookie clears: ${setOf(connected).cleared}`);
    assertEquals(setOf(connected).cleared, ["session"]);
    assertEquals(await who(old), null);
    assertEquals((await who(now))?.id, "ana");

    // Signing out: both go, and both end.
    const older = await start();
    const out = await post(serve, site, "/signout", `session=${older}; __Host-session=${now}`);
    assertEquals(setOf(out).cleared, ["__Host-session", "session"]);
    assertEquals([await who(older), await who(now)], [null, null]);

    // Over plain http to this machine, `session` is the current name: it's who she is, and stays.
    const here = await start();
    const local = await post(serve, "http://localhost:8790", "/connect", `session=${here}`);
    assertEquals((await local.json()).actor, { kind: "person", id: "ana" });
    assertEquals(setOf(local).cleared, []);
    assertEquals((await who(here))?.id, "ana");
  } finally {
    await runtime.close();
  }
});

test("an entrance's cookie is the host's alone unless it says hostOnly: false", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      definePlugin({
        name: "more",
        resources: {
          entrances: {
            guest: { cookie: "guest", query: "credential.actor", order: 10 },
            shared: { cookie: "shared", query: "credential.actor", order: 20, hostOnly: false },
          },
        },
      }),
    ],
  });
  try {
    const whom = whomOf(runtime);
    const named = (site: string) =>
      whom.entrances.map((entrance) => whom.named(entrance, new URL(site)));
    assertEquals(named("https://app.example.com"), ["__Host-session", "__Host-guest", "shared"]);
    assertEquals(named("http://localhost:8790"), ["session", "guest", "shared"]);
    // With names of the host's own (the orgs host's), every one is its alone.
    const orgs = whomOf(runtime, { cookie: (name) => `${name}_acme` });
    assert(
      orgs.entrances.every((e) =>
        orgs.named(e, new URL("https://app.example.com")).startsWith("__Host-")
      ),
    );
  } finally {
    await runtime.close();
  }
});
