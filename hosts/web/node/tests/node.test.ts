/**
 * The web host on Node: `bundle` makes the page's code with esbuild, split
 * where it imports lazily, and `listen` serves the runtime's `fetch`: the
 * page and its code (`webPage`), sign-in, and a signed-in browser's socket
 * to the runtime through Oxian's Node adapter: a client connects with its
 * ticket and calls an Action as its person. A handler of its own may pick
 * the runtime a socket goes to (one per org). Deno and Bun run it too,
 * through their Node compatibility.
 */
import { get } from "node:http";
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
import { devSignIn, identity } from "../../../../plugins/access/mod.ts";
import { test, testWho, ticketFor } from "../../../../testing/mod.ts";
import { webPage } from "../../server.ts";
import { bundle, listen } from "../mod.ts";

test("bundle: the page's code, split where it imports lazily, named for webPage", async () => {
  const code = await bundle(new URL("./page/page.tsx", import.meta.url));
  assertEquals(code.entry, "page.js");
  const chunk = Object.keys(code.files).find((name) => /^later-\w+\.js$/.test(name));
  assert(chunk, `a chunk for later.ts among ${Object.keys(code.files)}`);
  assert(String(code.files["page.js"]).includes(`./${chunk}`));
  for (const name of Object.keys(code.files)) assertMatch(name, /^[\w.-]+\.js$/);
  const plain = await bundle(new URL("./page/page.tsx", import.meta.url), { minify: false });
  assert(String(plain.files["page.js"]).includes("A page"));
});

test("listen: the page and its code, sign-in, and a browser's socket, as its person", async () => {
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
  const code = await bundle(new URL("./page/page.tsx", import.meta.url));
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      identity,
      devSignIn,
      probe,
      webPage,
      definePlugin({ name: "settings", resources: { page: { code } } }),
    ],
  });
  const server = await listen(runtime.fetch).catch(async (error) => {
    await runtime.close();
    throw error;
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assertMatch(
      await navigate(`${base}/`),
      /<script type="module" src="\/app\/page\.js"><\/script>/,
    );
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

/** The page as a browser navigating gets it (Node's `fetch` always says `Sec-Fetch-Mode: cors`). */
const navigate = (url: string) =>
  new Promise<string>((resolve, reject) => {
    get(url, { headers: { "sec-fetch-mode": "navigate" } }, (answer) => {
      let body = "";
      answer.on("data", (chunk) => (body += chunk));
      answer.on("end", () => resolve(body));
    }).on("error", reject);
  });

/** A runtime that says its name and who called: `probe.who`. */
function named(name: string) {
  return createRuntime({
    store: memoryStore(),
    plugins: [
      testWho,
      definePlugin({
        name: "probe",
        actions: {
          "probe.who": defineAction({
            input: { type: "object" },
            allow: (actor) => actor.kind === "person",
            run: (ctx) => `${name}: ${ctx.actor?.id}`,
          }),
        },
      }),
    ],
  });
}

/** Connects as `actor` to the socket at `url`, with a ticket from `runtime`, and asks who. */
async function who(url: string, runtime: Runtime, actor: Actor) {
  const client = connect({
    transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
    ticket: () => ticketFor(runtime, actor),
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
  const orgs: Record<string, Runtime> = {
    "127.0.0.1": await named("north"),
    localhost: await named("south"),
  };
  const server = await listen((request) => {
    const url = new URL(request.url);
    const runtime = url.searchParams.has("closed") ? undefined : orgs[url.hostname];
    return runtime ? runtime.fetch(request) : new Response("Connect again", { status: 503 });
  });
  const ana: Actor = { kind: "person", id: "ana" };
  try {
    for (const [host, runtime] of Object.entries(orgs)) {
      const said = await who(`ws://${host}:${server.port}/oxian`, runtime, ana);
      assertEquals(said, `${host === "localhost" ? "south" : "north"}: ana`);
    }
    const closed = await fetch(`http://127.0.0.1:${server.port}/oxian?closed`);
    assertEquals([closed.status, await closed.text()], [503, "Connect again"]);
  } finally {
    await server.shutdown();
    for (const runtime of Object.values(orgs)) await runtime.close();
  }
});
