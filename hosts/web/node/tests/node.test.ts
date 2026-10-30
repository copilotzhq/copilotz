/**
 * The web host on Node: `bundle` makes the page's code with esbuild, split
 * where it imports lazily, and `serve` answers the page, the code and
 * sign-in through `webServer`, and takes a signed-in browser's socket to the
 * runtime through Oxian's Node adapter: a client connects with its ticket and
 * calls an Action as its person. `listen` serves any fetch handler, each
 * socket going to the runtime its request is for (one per org). Deno and Bun
 * run it too, through their Node compatibility.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { identity } from "../../../../plugins/access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { bundle, listen, serve } from "../mod.ts";

test("bundle: the page's code, split where it imports lazily, named for webServer", async () => {
  const code = await bundle(new URL("./page/page.tsx", import.meta.url));
  assertEquals(code.entry, "page.js");
  const chunk = Object.keys(code.files).find((name) => /^later-\w+\.js$/.test(name));
  assert(chunk, `a chunk for later.ts among ${Object.keys(code.files)}`);
  assert(String(code.files["page.js"]).includes(`./${chunk}`));
  for (const name of Object.keys(code.files)) assertMatch(name, /^[\w.-]+\.js$/);
  const plain = await bundle(new URL("./page/page.tsx", import.meta.url), { minify: false });
  assert(String(plain.files["page.js"]).includes("A page"));
});

test("serve: the page and its code, sign-in, and a browser's socket, as its person", async () => {
  const tickets = createTickets();
  const probe = definePlugin({
    name: "probe",
    actions: {
      "probe.who": defineAction({
        input: { type: "object" },
        allow: (actor) => actor.kind === "person",
        run: (ctx) => ctx.actor?.id,
      }),
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [identity, probe],
    transports: [socket],
    admit: tickets.admit,
  });
  const server = await serve({
    runtime,
    tickets,
    code: await bundle(new URL("./page/page.tsx", import.meta.url)),
    dev: true,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const page = await fetch(`${base}/`);
    assertMatch(await page.text(), /<script type="module" src="\/app\/page\.js"><\/script>/);
    const script = await fetch(`${base}/app/page.js`);
    assertEquals(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    await script.body?.cancel();

    const signedIn = await fetch(`${base}/signin/dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ana" }),
    });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    await signedIn.body?.cancel();
    const connected = await fetch(`${base}/connect`, { method: "POST", headers: { cookie } });
    const { ticket } = await connected.json() as { ticket: string };

    const client = connect({
      transport: {
        type: "websocket",
        config: { url: `ws://127.0.0.1:${server.port}/oxian`, allowInsecureLoopback: true },
      },
      ticket: () => Promise.resolve(ticket),
      plugins: [],
    });
    try {
      await client.ready;
      assertEquals(await client.call("probe.who", {}), "ana");
    } finally {
      await client.close();
    }
  } finally {
    await server.shutdown();
    await runtime.close();
  }
});

/** A runtime that says its name and who called: `probe.who`. */
async function named(name: string) {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [definePlugin({
      name: "probe",
      actions: {
        "probe.who": defineAction({
          input: { type: "object" },
          allow: (actor) => actor.kind === "person",
          run: (ctx) => `${name}: ${ctx.actor?.id}`,
        }),
      },
    })],
    transports: [socket],
    admit: tickets.admit,
  });
  return { runtime, tickets };
}

/** Connects as `actor` to the socket at `url`, with a ticket from `tickets`, and asks who. */
async function who(url: string, tickets: { issue(actor: Actor): string }, actor: Actor) {
  const client = connect({
    transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
    ticket: () => Promise.resolve(tickets.issue(actor)),
    plugins: [],
  });
  try {
    await client.ready;
    return await client.call<string>("probe.who", {});
  } finally {
    await client.close();
  }
}

test("listen: each socket goes to the runtime its request is for; none, to the handler", async () => {
  // As orgs on hosts of their own would be: by the name the request was sent to.
  const orgs: Record<string, { runtime: Runtime; tickets: ReturnType<typeof createTickets> }> = {
    "127.0.0.1": await named("north"),
    localhost: await named("south"),
  };
  const server = await listen({
    fetch: () => new Response("Connect again", { status: 503 }),
    hypervisor: (request) => {
      const url = new URL(request.url);
      return url.searchParams.has("closed") ? undefined : orgs[url.hostname]?.runtime.hypervisor;
    },
  });
  const ana: Actor = { kind: "person", id: "ana" };
  try {
    for (const [host, { tickets }] of Object.entries(orgs)) {
      const said = await who(`ws://${host}:${server.port}/oxian`, tickets, ana);
      assertEquals(said, `${host === "localhost" ? "south" : "north"}: ana`);
    }
    const closed = await fetch(`http://127.0.0.1:${server.port}/oxian?closed`);
    assertEquals([closed.status, await closed.text()], [503, "Connect again"]);
  } finally {
    await server.shutdown();
    for (const { runtime } of Object.values(orgs)) await runtime.close();
  }
});
