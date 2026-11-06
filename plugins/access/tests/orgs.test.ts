/**
 * Many orgs behind one address, by the directory's routes: signing in, the
 * first page makes your personal org and puts you in it; you make a team org
 * and go into it; you're in an org only by its own session, which the
 * directory handed you to; invitations by email let people in with a role;
 * staff go in anywhere, reaching it all; taking someone out ends their
 * sessions there and their belonging; a suspended org lets nobody in. Each
 * org's runtime is its own, opened on first use, every request it serves
 * forwarded to it untouched. Over https every cookie is the host's alone
 * (`__Host-`), so one another host set is no one; what the directory answers
 * is never cached, comes from the app's page only, and says what goes wrong
 * only in words for anyone. (Ported from the orgs host's tests.)
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  definePlugin,
  type Runtime,
  setClientAddress,
} from "../../../runtime/mod.ts";
import { connect } from "../../../runtime/client.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { listen } from "../../../hosts/web/node/serve.ts";
import { runtime as which, test } from "../../../testing/mod.ts";
import { BASE, browser, served } from "./orgs-served.ts";

const asAna: Actor = { kind: "person", id: "ana@example.com" };

test("orgs: sign in, make and enter orgs, invite, staff, remove, suspend", async () => {
  const app = await served({ resources: { directory: { staff: ["sam@example.com"] } } });
  const { dir, orgs, opened } = app;
  try {
    const ana = browser(dir);
    // Signing in, then the page: her personal org, made and entered.
    const personal = await ana.signIn("ana@example.com");
    assert(ana.jar.has("dir") && ana.jar.has(`s_${personal}`), [...ana.jar.keys()].join());
    const mine = await (await ana.send("GET", "/orgs")).json();
    assertEquals([mine.current, mine.orgs[0].kind], [personal, "personal"]);
    // She makes Acme, and is in it.
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    assertEquals(ana.jar.get("org"), acme.id);
    const listed = await (await ana.send("GET", "/orgs")).json();
    assertEquals(listed.orgs.map((o: { name: string }) => o.name).sort(), ["Acme", "ana"]);
    // In Acme (its page's /connect, at its address), her browser connects as her; she's its owner.
    const connected = await (await ana.send("POST", `/o/${acme.id}/connect`)).json();
    assertEquals(connected.actor, asAna);
    // What her page shows her as: her name as she signed in, not her id.
    assertEquals((await (await ana.send("GET", `/o/${acme.id}/me`)).json()).name, "ana");
    const acmeRt = (await orgs.get(acme.id)) as Runtime;
    assertEquals(await acmeRt.call("org.me", {}, { actor: asAna }), {
      role: "owner",
      staff: false,
      org: { id: acme.id, name: "Acme", kind: "team", base: `/o/${acme.id}` },
    });

    // She invites Bob; he signs in, sees it, accepts, and is in Acme as a member.
    await acmeRt.call("org.invite", { email: "bob@example.com" }, { actor: asAna });
    const bob = browser(dir);
    await bob.signIn("bob@example.com");
    const waiting = await (await bob.send("GET", "/orgs")).json();
    assertEquals(waiting.invites.map((i: { name: string }) => i.name), ["Acme"]);
    const answered = await (await bob.send("POST", "/orgs/invites/answer", {
      invite: waiting.invites[0].id,
      accept: true,
    })).json();
    assertEquals([answered.org.id, bob.jar.get("org")], [acme.id, acme.id]);
    const asBob: Actor = { kind: "person", id: "bob@example.com" };
    assertEquals(await acmeRt.call("org.me", {}, { actor: asBob }), {
      role: "member",
      staff: false,
      org: { id: acme.id, name: "Acme", kind: "team", base: `/o/${acme.id}` },
    });
    const people = await acmeRt.call<{ people: { person: string; role: string }[] }>(
      "org.people",
      {},
      { actor: asBob },
    );
    assertEquals(people.people.map((p) => [p.person, p.role]), [
      ["ana@example.com", "owner"],
      ["bob@example.com", "member"],
    ]);

    // Eve belongs to Acme in no way: she can't go in.
    const eve = browser(dir);
    await eve.signIn("eve@example.com");
    assertEquals((await eve.send("POST", "/orgs/enter", { org: acme.id })).status, 403);

    // Staff go in, reaching it all, on the record as staff.
    const sam = browser(dir);
    await sam.signIn("sam@example.com");
    assertEquals((await sam.send("POST", "/orgs/enter", { org: acme.id })).status, 200);
    const samIn = await (await sam.send("POST", `/o/${acme.id}/connect`)).json();
    assertEquals(samIn.actor, { kind: "person", id: "sam@example.com" });
    const consoleOrgs = await (await sam.send("GET", "/console/orgs")).json();
    assert(consoleOrgs.orgs.some((o: { id: string }) => o.id === acme.id));
    assertEquals((await ana.send("GET", "/console/orgs")).status, 403);
    assertEquals((await (await sam.send("GET", "/orgs")).json()).asStaff, true);

    // Staff in an org of their own are one of its people, until they ask; then they keep
    // their role and act as staff, and going in as usual puts them back.
    await sam.send("POST", "/orgs", { name: "Sam's" });
    assertEquals((await (await sam.send("GET", "/orgs")).json()).asStaff, false);
    const sams = (await (await sam.send("GET", "/orgs")).json()).current as string;
    const samsRt = (await orgs.get(sams)) as Runtime;
    const standing = async () => {
      const actor = await samsRt.query<Actor>("credential.actor", {
        secret: sam.jar.get(`s_${sams}`)!,
      });
      const { role, staff } = await samsRt.call<{ role: string; staff: boolean }>("org.me", {}, {
        actor,
      });
      return { role, staff };
    };
    assertEquals((await sam.send("POST", "/orgs/enter", { org: sams, staff: true })).status, 200);
    assertEquals((await (await sam.send("GET", "/orgs")).json()).asStaff, true);
    assertEquals(await standing(), { role: "owner", staff: true });
    assertEquals((await sam.send("POST", "/orgs/enter", { org: sams })).status, 200);
    assertEquals((await (await sam.send("GET", "/orgs")).json()).asStaff, false);
    assertEquals(await standing(), { role: "owner", staff: false });
    await sam.send("POST", "/orgs/enter", { org: acme.id });

    // Staff by the email they verified, as anyone signed in with Google is: their id isn't it.
    const gia = browser(dir);
    await gia.signIn("gia-1234");
    assertEquals((await (await gia.send("GET", "/orgs")).json()).staff, false);
    assertEquals((await gia.send("GET", "/console/orgs")).status, 403);
    await dir.call("person.set", { person: "gia-1234", email: "Sam@Example.com" });
    assertEquals((await (await gia.send("GET", "/orgs")).json()).staff, true);
    assertEquals((await gia.send("GET", "/console/orgs")).status, 200);
    const gias = (await (await gia.send("GET", "/orgs")).json()).current as string;
    assertEquals((await gia.send("POST", "/orgs/enter", { org: gias, staff: true })).status, 200);
    assertEquals((await (await gia.send("GET", "/orgs")).json()).asStaff, true);

    // Only staff can ask to: a member can't, and someone else's org is still closed to them.
    assertEquals(
      (await ana.send("POST", "/orgs/enter", { org: acme.id, staff: true })).status,
      403,
    );
    assertEquals((await (await ana.send("GET", "/orgs")).json()).asStaff, false);
    assertEquals(
      (await eve.send("POST", "/orgs/enter", { org: acme.id, staff: true })).status,
      403,
    );

    // Ana takes Bob out: his session there ends at once, and Acme is no longer his.
    assertEquals((await bob.send("POST", `/o/${acme.id}/connect`)).status, 200);
    await acmeRt.call("org.remove", { person: "bob@example.com" }, { actor: asAna });
    assertEquals((await bob.send("POST", `/o/${acme.id}/connect`)).status, 401);
    const after = await (await bob.send("GET", "/orgs")).json();
    assertEquals(after.orgs.map((o: { name: string }) => o.name), ["bob"]);

    // Suspended, Acme lets nobody in, by its address either.
    await sam.send("POST", `/console/orgs/${acme.id}`, { suspended: true });
    assertEquals((await ana.send("POST", "/orgs/enter", { org: acme.id })).status, 403);
    assertEquals((await ana.send("POST", `/o/${acme.id}/connect`)).status, 403);
    // Each org got a runtime of its own, opened when first needed.
    const ids = opened.map(([id]) => id);
    assertEquals(new Set(ids).size, ids.length);
  } finally {
    await app.close();
  }
});

test("orgs: staff move an org's rows, export them, and delete the org", async () => {
  const done: string[] = [];
  const app = await served({
    resources: { directory: { staff: ["sam@example.com"] } },
    operations: {
      move: (org, to) => Promise.resolve(void done.push(`move ${org.id} ${to.schema}`)),
      export: (org) => new Response(`-- ${org.id}\n`).body as ReadableStream<Uint8Array>,
      drop: (org) => Promise.resolve(void done.push(`drop ${org.id}`)),
    },
  });
  const { dir, opened } = app;
  try {
    const ana = browser(dir);
    await ana.signIn("ana@example.com");
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    const sam = browser(dir);
    await sam.signIn("sam@example.com");
    // Only staff operate; a bad schema name is refused.
    assertEquals(
      (await ana.send("POST", `/console/orgs/${acme.id}/move`, { schema: "big" })).status,
      403,
    );
    assertEquals(
      (await sam.send("POST", `/console/orgs/${acme.id}/move`, { schema: "Big!" })).status,
      400,
    );
    // Moved: closed, its rows moved, and opened again where they went.
    const moved =
      await (await sam.send("POST", `/console/orgs/${acme.id}/move`, { schema: "acme" })).json();
    assertEquals(moved.placement, { schema: "acme" });
    assertEquals(app.orgs.peek(acme.id), undefined);
    assertEquals((await ana.send("POST", "/orgs/enter", { org: acme.id })).status, 200);
    assertEquals(opened.filter(([id]) => id === acme.id), [[acme.id, "orgs"], [acme.id, "acme"]]);
    // Exported, as a download.
    const exported = await sam.send("GET", `/console/orgs/${acme.id}/export`);
    assertEquals(await exported.text(), `-- ${acme.id}\n`);
    assert(exported.headers.get("content-disposition")!.includes(`${acme.id}.sql`));
    // Deleted only when its name is typed; then nobody's in it.
    assertEquals(
      (await sam.send("POST", `/console/orgs/${acme.id}/delete`, { confirm: "acme" })).status,
      400,
    );
    assertEquals(
      (await sam.send("POST", `/console/orgs/${acme.id}/delete`, { confirm: "Acme" })).status,
      200,
    );
    assertEquals(done, [`move ${acme.id} acme`, `drop ${acme.id}`]);
    const orgs = await (await ana.send("GET", "/orgs")).json();
    assertEquals(orgs.orgs.map((o: { name: string }) => o.name), ["ana"]);
    assertEquals((await ana.send("POST", "/orgs/enter", { org: acme.id })).status, 403);
    assertEquals((await ana.send("GET", `/o/${acme.id}/me`)).status, 404);
    // An app that doesn't do one says so.
    const plain = await served({ resources: { directory: { staff: ["sam@example.com"] } } });
    try {
      const staff = browser(plain.dir);
      const own = await staff.signIn("sam@example.com");
      assertEquals((await staff.send("GET", `/console/orgs/${own}/export`)).status, 501);
    } finally {
      await plain.close();
    }
  } finally {
    await app.close();
  }
});

test("orgs: a page in an org no longer yours lands you in one that is", async () => {
  const app = await served({ resources: { directory: { staff: ["sam@example.com"] } } });
  const { dir, orgs } = app;
  try {
    const ana = browser(dir);
    const personal = await ana.signIn("ana@example.com");
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    const acmeRt = (await orgs.get(acme.id)) as Runtime;
    await acmeRt.call("org.invite", { email: "bob@example.com" }, { actor: asAna });
    const bob = browser(dir);
    await bob.signIn("bob@example.com");
    const { invites } = await (await bob.send("GET", "/orgs")).json();
    await bob.send("POST", "/orgs/invites/answer", { invite: invites[0].id, accept: true });
    assertEquals(bob.jar.get("org"), acme.id);
    // His page, in Acme: Acme's own.
    const there = await bob.page("/thread/t1");
    assertEquals([there.status, there.headers.get("content-type")], [
      200,
      "text/html; charset=utf-8",
    ]);
    assert((await there.text()).includes(`"base":"/o/${acme.id}"`));
    // Taken out of Acme, his next page lands him in his own org: the same page, there.
    await acmeRt.call("org.remove", { person: "bob@example.com" }, { actor: asAna });
    const moved = await bob.page("/thread/t1");
    assertEquals([moved.status, moved.headers.get("location")], [302, "/thread/t1"]);
    assert(bob.jar.get("org")?.startsWith("p-"));
    assert(
      (await (await bob.page("/thread/t1")).text()).includes(`"base":"/o/${bob.jar.get("org")}"`),
    );
    // Acme suspended: Ana's page lands her in her personal org; a call that's not a page is refused.
    const sam = browser(dir);
    await sam.signIn("sam@example.com");
    await sam.send("POST", `/console/orgs/${acme.id}`, { suspended: true });
    const kept = new Map(ana.jar);
    assertEquals((await ana.send("GET", "/app/app.js")).status, 403);
    const landed = await ana.page("/");
    assertEquals(landed.status, 302);
    assertEquals(ana.jar.get("org"), personal);
    for (const [name, value] of kept) ana.jar.set(name, value);
    assertEquals((await ana.send("POST", `/o/${acme.id}/connect`)).status, 403);
  } finally {
    await app.close();
  }
});

test("orgs: an org's address reaches it without a session; inviting an outsider to a space invites them to the org", async () => {
  const app = await served({
    plugins: () => [
      definePlugin({
        name: "probe",
        routes: {
          "/probe": (_request, { runtime }) =>
            Response.json({ org: (runtime.describe().resources.org as { id: string }).id }),
        },
      }),
    ],
  });
  const { dir, orgs } = app;
  try {
    const ana = browser(dir);
    await ana.signIn("ana@example.com");
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    // No cookies at all: the address says which org.
    const probed = await dir.fetch(new Request(`${BASE}/o/${acme.id}/probe`, { method: "POST" }));
    assertEquals(await probed.json(), { org: acme.id });
    assertEquals((await dir.fetch(new Request(`${BASE}/o/nope/probe`))).status, 404);
    // Its page says where it is, so the addresses it shows work, and its socket connects there.
    const page = await (await ana.page("/")).text();
    assert(page.includes(`"base":"/o/${acme.id}"`));
    // The app's own socket isn't an org's: nobody connects to it without a ticket of its own.
    const bare = await dir.fetch(new Request(`${BASE}/oxian`));
    assert(bare.status >= 400, String(bare.status));
    await bare.body?.cancel();
    assertEquals((await dir.fetch(new Request(`${BASE}/o/nope/oxian`))).status, 404);
    // Bob isn't in Acme: a space's invitation brings him to the org too, as a guest.
    const acmeRt = (await orgs.get(acme.id)) as Runtime;
    const { space } = await acmeRt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: asAna,
    });
    await acmeRt.call("invitation.send", { space, email: "bob@example.com" }, { actor: asAna });
    const bob = browser(dir);
    await bob.signIn("bob@example.com");
    const { invites } = await (await bob.send("GET", "/orgs")).json();
    assertEquals(invites.map((i: { name: string; role: string }) => [i.name, i.role]), [[
      "Acme",
      "guest",
    ]]);
  } finally {
    await app.close();
  }
});

test("orgs: a browser's socket reaches its org through the directory, by its address (Node's listener)", async () => {
  const app = await served();
  const listener = await listen(app.dir.fetch);
  const at = `http://127.0.0.1:${listener.port}`;
  const ana = browser(app.dir, at);
  const clients: ReturnType<typeof connect>[] = [];
  try {
    const acme = await ana.signIn("ana@example.com");
    // The page's ticket, at the org's address; its socket there, through the directory.
    const ticket = async () => {
      const answer = await ana.send("POST", `/o/${acme}/connect`);
      if (answer.status !== 200) throw new Error(`No ticket: ${answer.status}`);
      return ((await answer.json()) as { ticket: string }).ticket;
    };
    const client = connect({
      transport: {
        type: "websocket",
        config: {
          url: `ws://127.0.0.1:${listener.port}/o/${acme}/oxian`,
          allowInsecureLoopback: true,
        },
      },
      ticket,
      plugins: [],
    });
    clients.push(client);
    await client.ready;
    const me = await client.call<{ role: string; org: { id: string } }>("org.me", {});
    assertEquals([me.role, me.org.id], ["owner", acme]);
    const acmeRt = app.orgs.peek(acme!)!;
    assertEquals(acmeRt.stats().browsers, 1);
    // No such org's socket: a 404, from the directory.
    const nope = await fetch(`${at}/o/nope/oxian`);
    assertEquals(nope.status, 404);
    await nope.body?.cancel();
    // Signing out (the directory's), its browser in the org goes too.
    assertEquals((await ana.send("POST", "/signout")).status, 200);
    const end = Date.now() + 2_000;
    while (acmeRt.stats().browsers > 0 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(acmeRt.stats().browsers, 0);
    assertEquals((await ana.send("POST", `/o/${acme}/connect`)).status, 401);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await listener.shutdown();
    await app.close();
  }
});

test({
  name: "orgs: Deno.serve(dir.fetch) takes an org's socket itself, forwarded",
  ignore: which !== "deno",
  fn: async () => {
    const app = await served();
    // deno-lint-ignore no-explicit-any
    const deno = (globalThis as any).Deno;
    const server = deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, app.dir.fetch);
    const at = `http://127.0.0.1:${server.addr.port}`;
    const ana = browser(app.dir, at);
    const acme = await ana.signIn("ana@example.com");
    const client = connect({
      transport: {
        type: "websocket",
        config: {
          url: `ws://127.0.0.1:${server.addr.port}/o/${acme}/oxian`,
          allowInsecureLoopback: true,
        },
      },
      ticket: async () =>
        ((await (await ana.send("POST", `/o/${acme}/connect`)).json()) as { ticket: string })
          .ticket,
      plugins: [],
    });
    try {
      await client.ready;
      assertEquals((await client.call<{ role: string }>("org.me", {})).role, "owner");
    } finally {
      await client.close();
      await server.shutdown();
      await app.close();
    }
  },
});

test("orgs over https: every cookie is the host's alone, so one another host set is no one", async () => {
  const app = await served();
  try {
    const ana = browser(app.dir, "https://localhost:8800");
    const signed = await ana.send("POST", "/signin/dev", { name: "ana@example.com" });
    assertEquals(signed.headers.get("cache-control"), "no-store");
    const landed = await ana.page("/");
    assertEquals(landed.status, 302);
    const org = ana.jar.get("__Host-org")!;
    assertEquals([...ana.jar.keys()].sort(), ["__Host-dir", "__Host-org", `__Host-s_${org}`]);
    for (const set of [...signed.headers.getSetCookie(), ...landed.headers.getSetCookie()]) {
      assert(set.endsWith("; Secure"), set);
    }
    assertEquals(landed.headers.get("cache-control"), "no-store");
    // The org's own runtime reads its session by that name.
    const connected = await ana.send("POST", `/o/${org}/connect`);
    assertEquals((await connected.json()).actor, { kind: "person", id: "ana@example.com" });
    const orgs = await ana.send("GET", "/orgs");
    assertEquals([orgs.status, orgs.headers.get("cache-control")], [200, "no-store"]);
    await orgs.body?.cancel();

    // The same secrets under plain names (what a preview's page script can set): nobody.
    const tossed = [...ana.jar].map(([n, v]) => `${n.replace("__Host-", "")}=${v}`).join("; ");
    const as = (path: string, method = "GET") =>
      app.dir.fetch(setClientAddress(
        new Request(`https://localhost:8800${path}`, { method, headers: { cookie: tossed } }),
        "127.0.0.1",
      ));
    assertEquals((await as("/orgs")).status, 401);
    assertEquals((await as(`/o/${org}/connect`, "POST")).status, 401);

    // Signing out clears every one of them.
    const out = await ana.send("POST", "/signout");
    assertEquals(out.headers.get("cache-control"), "no-store");
    assertEquals(
      out.headers.getSetCookie().map((c) => c.split(";")[0]).sort(),
      ["__Host-dir=", "__Host-org=", `__Host-s_${org}=`],
    );
    assertEquals(ana.jar.size, 0);
  } finally {
    await app.close();
  }
});

test("orgs: signing out ends every org's session it holds, and the directory's", async () => {
  const app = await served();
  const { dir, orgs } = app;
  try {
    const ana = browser(dir);
    const personal = (await ana.signIn("ana@example.com"))!;
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    const held = {
      dir: ana.jar.get("dir")!,
      [personal]: ana.jar.get(`s_${personal}`)!,
      [acme.id]: ana.jar.get(`s_${acme.id}`)!,
    };
    const at = async (rt: Runtime, secret: string) =>
      (await rt.query<Actor | null>("credential.actor", { secret }))?.id ?? null;
    assertEquals(await at((await orgs.get(acme.id))!, held[acme.id]), "ana@example.com");
    // Acme closes (idle); signing out never opens it, but every cookie goes.
    await orgs.close(acme.id);
    const out = await ana.send("POST", "/signout");
    assertEquals(
      out.headers.getSetCookie().map((c) => c.split("=")[0]).sort(),
      ["dir", "org", `s_${acme.id}`, `s_${personal}`].sort(),
    );
    assertEquals(orgs.peek(acme.id), undefined);
    assertEquals(await at(dir, held.dir), null);
    assertEquals(await at((await orgs.get(personal))!, held[personal]), null);
    // Acme's session was held while it was closed: it's out of that browser, and ends with time.
    assertEquals(ana.jar.size, 0);
    // A request naming orgs that don't exist in its cookies opens nothing, and fails nothing.
    const odd = await dir.fetch(setClientAddress(
      new Request(`${BASE}/signout`, {
        method: "POST",
        headers: { cookie: "s_nope=abcdefgh; s_also-nope=x" },
      }),
      "127.0.0.1",
    ));
    assertEquals(odd.status, 200);
    assertEquals(orgs.peek("nope"), undefined);
  } finally {
    await app.close();
  }
});

test("orgs: signing in by name is this machine's, by its socket's address", async () => {
  const app = await served();
  try {
    const asked = (address?: string) => {
      const request = new Request(`${BASE}/signin/dev`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "sam@example.com" }),
      });
      return app.dir.fetch(address ? setClientAddress(request, address) : request);
    };
    for (const address of [undefined, "192.168.1.20"]) {
      const refused = await asked(address);
      assertEquals([refused.status, refused.headers.getSetCookie()], [404, []], address);
    }
    assertEquals((await asked("127.0.0.1")).status, 200);
  } finally {
    await app.close();
  }
});

test("orgs: what goes wrong says only what's for anyone, by its code's status", async () => {
  const logged = console.error;
  console.error = () => {};
  try {
    const broken = await served({
      open: () => Promise.reject(new Error("postgres://admin:hunter2@db/app")),
    });
    try {
      const ana = browser(broken.dir);
      assertEquals(
        (await ana.send("POST", "/signin/dev", { name: "ana@example.com" })).status,
        200,
      );
      const failed = await ana.page("/");
      assertEquals([failed.status, await failed.json()], [500, { error: "Something went wrong" }]);
    } finally {
      await broken.close();
    }
    const app = await served();
    try {
      const ana = browser(app.dir);
      await ana.signIn("ana@example.com");
      const bob = browser(app.dir);
      const bobs = await bob.signIn("bob@example.com");
      // A refusal meant for her says why.
      const closed = await ana.send("POST", "/orgs/enter", { org: bobs });
      assertEquals([closed.status, await closed.json()], [403, {
        error: "No such org, or not one you belong to.",
      }]);
      // What she sent that isn't JSON is hers to fix.
      const odd = await app.dir.fetch(setClientAddress(
        new Request(`${BASE}/orgs`, {
          method: "POST",
          headers: { cookie: ana.cookie() },
          body: "{not json",
        }),
        "127.0.0.1",
      ));
      assertEquals(odd.status, 400);
      // Not signed in: told so.
      assertEquals((await app.dir.fetch(new Request(`${BASE}/orgs`))).status, 401);
    } finally {
      await app.close();
    }
  } finally {
    console.error = logged;
  }
});

test("orgs: what the directory answers to a POST comes from the app's page only", async () => {
  const app = await served();
  try {
    const ana = browser(app.dir);
    const org = await ana.signIn("ana@example.com");
    const ask = (path: string, headers: Record<string, string>) =>
      app.dir.fetch(setClientAddress(
        new Request(BASE + path, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ana.cookie(), ...headers },
          body: JSON.stringify({ name: "x", org }),
        }),
        "127.0.0.1",
      ));
    const elsewhere: Record<string, Record<string, string>> = {
      "another site": { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      "another site, no fetch metadata": { origin: "https://evil.example" },
      "a sibling": { origin: "https://x-preview.example.com", "sec-fetch-site": "same-site" },
      "an opaque origin": { origin: "null" },
      "another port": { origin: "http://localhost:9999" },
      "a forged front": { origin: "https://evil.example", "x-forwarded-host": "evil.example" },
    };
    const paths = [
      "/signin/dev",
      "/signout",
      "/orgs",
      "/orgs/enter",
      "/orgs/invites/answer",
      "/console/codes",
      "/connect",
      `/o/${org}/connect`,
      `/o/${org}/enter`,
    ];
    for (const path of paths) {
      for (const [why, headers] of Object.entries(elsewhere)) {
        const answer = await ask(path, headers);
        assertEquals([answer.status, answer.headers.getSetCookie()], [403, []], `${path}: ${why}`);
        await answer.body?.cancel();
      }
    }
    // Its own page is let through (to whatever it then answers).
    const own = await ask(`/o/${org}/connect`, { origin: "http://localhost:8800" });
    assertEquals(own.status, 200);
    await own.body?.cancel();
    // An org's way in is the directory's alone: nobody else's handoff opens it.
    const forged = await ask(`/o/${org}/enter?org=${org}&person=eve&exp=9999999999&sig=x`, {});
    assertEquals([forged.status, forged.headers.getSetCookie()], [403, []]);
  } finally {
    await app.close();
  }
});

test("orgs: an org's runtime closes when idle, and opens again with its rows and sessions", async () => {
  const opened: string[] = [];
  const stores = new Map<string, ReturnType<typeof memoryStore>>();
  const app = await served({
    open: async (org, given) => {
      opened.push(org.id);
      if (!stores.has(org.id)) stores.set(org.id, memoryStore());
      return await createRuntime({ store: stores.get(org.id)!, plugins: given });
    },
  });
  try {
    const ana = browser(app.dir);
    const org = (await ana.signIn("ana@example.com"))!;
    assertEquals((await ana.send("POST", `/o/${org}/connect`)).status, 200);
    await app.orgs.close(org);
    assertEquals(app.orgs.peek(org), undefined);
    // Asked again, it opens again: her session there still is her.
    const again = await ana.send("POST", `/o/${org}/connect`);
    assertEquals((await again.json()).actor, asAna);
    assertEquals(opened, [org, org]);
  } finally {
    await app.close();
  }
});
