/**
 * An app without the web app (no `webPage`): its routes answer, a route's
 * socket too, `/health` says it's up, and nothing else is there. The
 * runtime's own socket still takes its clients. With the page, the routes
 * take sockets the same way. Shutting the listener down lets what's running
 * finish; the runtime is the app's to close. Deno and Bun run it too,
 * through their Node compatibility.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { upgradeWebSocket } from "@oxian/oxian-js/http";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Route,
} from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { test, testWho, ticketFor } from "../../../../testing/mod.ts";
import { webPage } from "../../server.ts";
import { listen } from "../serve.ts";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** Says who called and the path asked. */
const hello: Route = (request, { actor }) =>
  json({ who: actor.kind, path: new URL(request.url).pathname });

/** Answers after a moment. */
const slow: Route = async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return new Response("slow, but done");
};

/** A relay's socket: what it's sent comes back. */
const echoRoute: Route = (request) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("A socket only", { status: 426 });
  }
  const { socket, response } = upgradeWebSocket(request);
  socket.onmessage = (event) => socket.send(`echo: ${event.data}`);
  return response;
};

const hooks = definePlugin({
  name: "hooks",
  actions: {
    "probe.who": defineAction({
      input: { type: "object" },
      allow: (actor) => actor.kind === "person",
      run: (ctx) => ctx.actor?.id,
    }),
  },
  routes: { "/hooks/hello": hello, "/hooks/slow": slow, "/relay": echoRoute },
});

/** A socket at `url`, once it's open. */
const opened = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`No socket at ${url}`));
  });
const message = (ws: WebSocket) =>
  new Promise<string>((resolve) =>
    ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true })
  );
const closed = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));

test("without a page: the app's routes, a route's socket, /health, and nothing else", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [hooks] });
  const server = await listen(runtime.fetch);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const hello = await fetch(`${base}/hooks/hello?from=meta`, { method: "POST", body: "{}" });
    assertEquals([hello.status, await hello.json()], [200, {
      who: "anonymous",
      path: "/hooks/hello",
    }]);
    const health = await fetch(`${base}/health`);
    assertEquals([health.status, await health.text()], [200, "ok"]);
    // No page, no code, no sign-in: they aren't here.
    for (const path of ["/", "/app/app.js", "/signin/dev", "/nowhere"]) {
      const missing = await fetch(`${base}${path}`, { method: path === "/" ? "GET" : "POST" });
      assertEquals([path, missing.status], [path, 404]);
      await missing.body?.cancel();
    }
    // /connect is the runtime's own: it needs someone signed in.
    const connected = await fetch(`${base}/connect`, { method: "POST" });
    assertEquals(connected.status, 401);
    await connected.body?.cancel();
    const plain = await fetch(`${base}/relay`);
    assertEquals([plain.status, await plain.text()], [426, "A socket only"]);

    assertEquals(await echo(`ws://127.0.0.1:${server.port}/relay`), "echo: hello");
  } finally {
    await server.shutdown();
    await runtime.close();
  }
});

/** What a relay at `url` sends back for "hello". */
async function echo(url: string) {
  const relay = await opened(url);
  const said = message(relay);
  relay.send("hello");
  const answer = await said;
  const gone = closed(relay);
  relay.close();
  await gone;
  return answer;
}

test("with the page, the routes take sockets of their own too", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      hooks,
      webPage,
      definePlugin({
        name: "settings",
        resources: { page: { code: { entry: "app.js", files: { "app.js": "" } } } },
      }),
    ],
  });
  const server = await listen(runtime.fetch);
  try {
    assertEquals(await echo(`ws://127.0.0.1:${server.port}/relay`), "echo: hello");
  } finally {
    await server.shutdown();
    await runtime.close();
  }
});

test("without a page, the runtime's own socket still takes its clients", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [testWho, hooks] });
  const server = await listen(runtime.fetch);
  const ana: Actor = { kind: "person", id: "ana" };
  const client = connect({
    transport: {
      type: "websocket",
      config: { url: `ws://127.0.0.1:${server.port}/oxian`, allowInsecureLoopback: true },
    },
    ticket: () => ticketFor(runtime, ana),
    plugins: [],
  });
  try {
    await client.ready;
    assertEquals(await client.call("probe.who", {}), "ana");
  } finally {
    await client.close();
    await server.shutdown();
    await runtime.close();
  }
});

test("shutting down lets a running request finish, and stops listening", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [hooks] });
  const server = await listen(runtime.fetch);
  const base = `http://127.0.0.1:${server.port}`;
  const relay = await opened(`ws://127.0.0.1:${server.port}/relay`);
  const hungUp = closed(relay);
  const pending = fetch(`${base}/hooks/slow`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stopping = server.shutdown();
  const answered = await pending;
  assertEquals([answered.status, await answered.text()], [200, "slow, but done"]);
  await stopping;
  await hungUp;
  await assertRejects(() => fetch(`${base}/health`));
  await runtime.close();
});
