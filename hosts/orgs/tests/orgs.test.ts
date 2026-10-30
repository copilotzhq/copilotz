/**
 * Many orgs behind one address: signing in makes your personal org and puts
 * you in it; you make a team org and go into it; you're in an org only by
 * its own session, which the directory let you have; invitations by email
 * let people in with a role; staff go in anywhere, reaching it all; taking
 * someone out ends their sessions there and their belonging; a suspended
 * org lets nobody in. Each org's runtime is its own, opened on first use.
 */
import { assert, assertEquals } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, identity } from "../../../plugins/access/mod.ts";
import { directory } from "../../../plugins/access/directory/mod.ts";
import { test } from "../../../testing/mod.ts";
import { orgsHost } from "../mod.ts";

const BASE = "http://localhost:8800";

/** A browser's cookies: what responses set, sent back. */
function browser(serve: (request: Request) => Promise<Response>) {
  const jar = new Map<string, string>();
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await serve(
      new Request(BASE + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    for (const set of response.headers.getSetCookie()) {
      const [pair] = set.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (/Max-Age=0/.test(set)) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return { send, jar };
}

test("orgs: sign in, make and enter orgs, invite, staff, remove, suspend", async () => {
  const dir = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      directory,
      definePlugin({ name: "d", resources: { directory: { staff: ["sam@example.com"] } } }),
    ],
  });
  const opened: string[] = [];
  const host = orgsHost({
    directory: dir,
    open: async (org, given) => {
      opened.push(org.id);
      return await createRuntime({
        store: memoryStore(),
        plugins: [...access, ...given.plugins],
        admit: given.admit,
      });
    },
    upgrade: () => new Response(null, { status: 299 }),
    code: { entry: "app.js", files: { "app.js": "" } },
    dev: true,
  });
  try {
    const ana = browser(host.serve);
    // Signing in: her personal org, made and entered.
    const signed = await (await ana.send("POST", "/signin/dev", { name: "ana@example.com" }))
      .json();
    assertEquals(signed.org.kind, "personal");
    const personal: string = signed.org.id;
    assert(ana.jar.has("dir") && ana.jar.get("org") === personal && ana.jar.has(`s_${personal}`));
    // She makes Acme, and is in it.
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    assertEquals(ana.jar.get("org"), acme.id);
    const orgs = await (await ana.send("GET", "/orgs")).json();
    assertEquals(orgs.orgs.map((o: { name: string }) => o.name).sort(), ["Acme", "ana"]);
    // In Acme, her browser connects as her; she's its owner.
    const connected = await (await ana.send("POST", "/connect")).json();
    assertEquals(connected.person, "ana@example.com");
    const acmeRt = (await host.runtime(acme.id)) as Runtime;
    const asAna: Actor = { kind: "person", id: "ana@example.com" };
    assertEquals(await acmeRt.call("org.me", {}, { actor: asAna }), {
      role: "owner",
      staff: false,
      org: { id: acme.id, name: "Acme", kind: "team", base: `/o/${acme.id}` },
    });

    // She invites Bob; he signs in, sees it, accepts, and is in Acme as a member.
    await acmeRt.call("org.invite", { email: "bob@example.com" }, { actor: asAna });
    const bob = browser(host.serve);
    await bob.send("POST", "/signin/dev", { name: "bob@example.com" });
    const waiting = await (await bob.send("GET", "/orgs")).json();
    assertEquals(waiting.invites.map((i: { name: string }) => i.name), ["Acme"]);
    const answered = await (await bob.send("POST", "/orgs/invites/answer", {
      invite: waiting.invites[0].id,
      accept: true,
    })).json();
    assertEquals([answered.joined, bob.jar.get("org")], [true, acme.id]);
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
    const eve = browser(host.serve);
    await eve.send("POST", "/signin/dev", { name: "eve@example.com" });
    assertEquals((await eve.send("POST", "/orgs/enter", { org: acme.id })).status, 403);

    // Staff go in, reaching it all, on the record as staff.
    const sam = browser(host.serve);
    await sam.send("POST", "/signin/dev", { name: "sam@example.com" });
    assertEquals((await sam.send("POST", "/orgs/enter", { org: acme.id })).status, 200);
    const samIn = await (await sam.send("POST", "/connect")).json();
    assertEquals(samIn.person, "sam@example.com");
    const consoleOrgs = await (await sam.send("GET", "/console/orgs")).json();
    assert(consoleOrgs.orgs.some((o: { id: string }) => o.id === acme.id));
    assertEquals((await ana.send("GET", "/console/orgs")).status, 403);

    // Ana takes Bob out: his session there ends, and Acme is no longer his.
    await acmeRt.call("org.remove", { person: "bob@example.com" }, { actor: asAna });
    assertEquals((await bob.send("POST", "/connect")).status, 401);
    const after = await (await bob.send("GET", "/orgs")).json();
    assertEquals(after.orgs.map((o: { name: string }) => o.name), ["bob"]);

    // Suspended, Acme lets nobody in.
    await sam.send("POST", `/console/orgs/${acme.id}`, { suspended: true });
    assertEquals((await ana.send("POST", "/orgs/enter", { org: acme.id })).status, 403);
    // Each org got a runtime of its own, opened when first needed.
    assertEquals(new Set(opened).size, opened.length);
  } finally {
    await host.close();
    await dir.close();
  }
});

test("orgs: staff move an org's rows, export them, and delete the org", async () => {
  const dir = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      directory,
      definePlugin({ name: "d", resources: { directory: { staff: ["sam@example.com"] } } }),
    ],
  });
  const opened: [string, string][] = [];
  const done: string[] = [];
  const host = orgsHost({
    directory: dir,
    open: async (org, given) => {
      opened.push([org.id, org.placement.schema]);
      return await createRuntime({
        store: memoryStore(),
        plugins: [...access, ...given.plugins],
        admit: given.admit,
      });
    },
    upgrade: () => new Response(null, { status: 299 }),
    code: { entry: "app.js", files: { "app.js": "" } },
    dev: true,
    operations: {
      move: (org, to) => Promise.resolve(void done.push(`move ${org.id} ${to.schema}`)),
      export: (org) => new Response(`-- ${org.id}\n`).body as ReadableStream<Uint8Array>,
      drop: (org) => Promise.resolve(void done.push(`drop ${org.id}`)),
    },
  });
  try {
    const ana = browser(host.serve);
    await ana.send("POST", "/signin/dev", { name: "ana@example.com" });
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    const sam = browser(host.serve);
    await sam.send("POST", "/signin/dev", { name: "sam@example.com" });
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
  } finally {
    await host.close();
    await dir.close();
  }
});

test("orgs: a page in an org no longer yours lands you in one that is", async () => {
  const dir = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      directory,
      definePlugin({ name: "d", resources: { directory: { staff: ["sam@example.com"] } } }),
    ],
  });
  const host = orgsHost({
    directory: dir,
    open: async (_org, given) =>
      await createRuntime({
        store: memoryStore(),
        plugins: [...access, ...given.plugins],
        admit: given.admit,
      }),
    upgrade: () => new Response(null, { status: 299 }),
    code: { entry: "app.js", files: { "app.js": "" } },
    dev: true,
  });
  try {
    const ana = browser(host.serve);
    const { org: personal } =
      await (await ana.send("POST", "/signin/dev", { name: "ana@example.com" }))
        .json();
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    const acmeRt = (await host.runtime(acme.id)) as Runtime;
    await acmeRt.call("org.invite", { email: "bob@example.com" }, {
      actor: { kind: "person", id: "ana@example.com" },
    });
    const bob = browser(host.serve);
    await bob.send("POST", "/signin/dev", { name: "bob@example.com" });
    const { invites } = await (await bob.send("GET", "/orgs")).json();
    await bob.send("POST", "/orgs/invites/answer", { invite: invites[0].id, accept: true });
    assertEquals(bob.jar.get("org"), acme.id);
    // Taken out of Acme, his next page lands him in his own org.
    await acmeRt.call("org.remove", { person: "bob@example.com" }, {
      actor: { kind: "person", id: "ana@example.com" },
    });
    const page = (who: ReturnType<typeof browser>) =>
      host.serve(
        new Request(BASE + "/thread/t1", {
          headers: {
            accept: "text/html",
            cookie: [...who.jar].map(([n, v]) => `${n}=${v}`).join("; "),
          },
        }),
      );
    const moved = await page(bob);
    assertEquals([moved.status, moved.headers.get("location")], [302, "/thread/t1"]);
    assert(moved.headers.getSetCookie().some((c) => c.startsWith("org=p-")));
    // Acme suspended: Ana's page lands her in her personal org; a non-page call is refused.
    const sam = browser(host.serve);
    await sam.send("POST", "/signin/dev", { name: "sam@example.com" });
    await sam.send("POST", `/console/orgs/${acme.id}`, { suspended: true });
    const landed = await page(ana);
    assertEquals(landed.status, 302);
    assert(
      landed.headers.getSetCookie().some((c) =>
        c === `org=${personal.id}` || c.startsWith(`org=${personal.id};`)
      ),
    );
    assertEquals((await ana.send("POST", "/connect")).status, 403);
  } finally {
    await host.close();
    await dir.close();
  }
});

test("orgs: an org's address reaches it without a session; inviting an outsider to a space invites them to the org", async () => {
  const dir = await createRuntime({ store: memoryStore(), plugins: [identity, directory] });
  const host = orgsHost({
    directory: dir,
    open: async (_org, given) =>
      await createRuntime({
        store: memoryStore(),
        plugins: [
          ...access,
          ...given.plugins,
          definePlugin({
            name: "probe",
            actions: {
              "probe.where": {
                input: { type: "object" },
                allow: () => true,
                run: (ctx) => ({ body: { org: (ctx.resources.org as { id: string }).id } }),
              },
            },
            resources: { routes: { probe: { path: "/probe", action: "probe.where" } } },
          }),
        ],
        admit: given.admit,
      }),
    upgrade: () => new Response(null, { status: 299 }),
    code: { entry: "app.js", files: { "app.js": "" } },
    dev: true,
  });
  try {
    const ana = browser(host.serve);
    await ana.send("POST", "/signin/dev", { name: "ana@example.com" });
    const { org: acme } = await (await ana.send("POST", "/orgs", { name: "Acme" })).json();
    // No cookies at all: the address says which org.
    const probed = await host.serve(new Request(`${BASE}/o/${acme.id}/probe`, { method: "POST" }));
    assertEquals(await probed.json(), { org: acme.id });
    assertEquals((await host.serve(new Request(`${BASE}/o/nope/probe`))).status, 404);
    // Its page says where it is, so the addresses it shows work.
    const page = await (await ana.send("GET", "/")).text();
    assert(page.includes(`"base":"/o/${acme.id}"`));
    // Bob isn't in Acme: a space's invitation brings him to the org too, as a guest.
    const acmeRt = (await host.runtime(acme.id)) as Runtime;
    const asAna: Actor = { kind: "person", id: "ana@example.com" };
    const { space } = await acmeRt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: asAna,
    });
    await acmeRt.call("invitation.send", { space, email: "bob@example.com" }, { actor: asAna });
    const bob = browser(host.serve);
    await bob.send("POST", "/signin/dev", { name: "bob@example.com" });
    const { invites } = await (await bob.send("GET", "/orgs")).json();
    assertEquals(invites.map((i: { name: string; role: string }) => [i.name, i.role]), [[
      "Acme",
      "guest",
    ]]);
  } finally {
    await host.close();
    await dir.close();
  }
});
