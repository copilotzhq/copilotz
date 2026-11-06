/**
 * An app without the web app (`serve` with no page's code): its routes
 * answer, a route's socket too, `/health` says it's up, and nothing else is
 * there. The runtime's own socket still takes its clients. Closing stops
 * listening, lets what's running finish, and closes the runtime with what it
 * was given. With the page, the routes take sockets the same way. Deno and
 * Bun run it too, through their Node compatibility.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { httpRequest, type Served, socket } from "../../server.ts";
import { createTickets } from "../../tickets.ts";
import { serve } from "../mod.ts";

const hooks = definePlugin({
  name: "hooks",
  actions: {
    "hooks.hello": defineAction({
      input: httpRequest,
      allow: () => true,
      run: (ctx, input) => ({ body: { who: ctx.actor?.kind, path: input.path } }),
    }),
    "hooks.slow": defineAction({
      input: httpRequest,
      allow: () => true,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { body: "slow, but done" };
      },
    }),
    "probe.who": defineAction({
      input: { type: "object" },
      allow: (actor) => actor.kind === "person",
      run: (ctx) => ctx.actor?.id,
    }),
  },
  resources: {
    routes: {
      hello: { path: "/hooks/hello", action: "hooks.hello" },
      slow: { path: "/hooks/slow", action: "hooks.slow" },
      // A relay's socket: what it's sent comes back.
      echo: {
        path: "/relay",
        serve: (request: Request, host: Served) => {
          if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("A socket only", { status: 426 });
          }
          const { socket, response } = host.upgrade();
          socket.onmessage = (event) => socket.send(`echo: ${event.data}`);
          return response;
        },
      },
    },
  },
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
  const server = await serve({ runtime });
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
    for (const path of ["/", "/app/app.js", "/signin/dev", "/connect", "/nowhere"]) {
      const missing = await fetch(`${base}${path}`, { method: path === "/" ? "GET" : "POST" });
      assertEquals([path, missing.status, await missing.text()], [path, 404, "Not found"]);
    }
    const plain = await fetch(`${base}/relay`);
    assertEquals([plain.status, await plain.text()], [426, "A socket only"]);

    assertEquals(await echo(`ws://127.0.0.1:${server.port}/relay`), "echo: hello");
  } finally {
    await server.close();
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
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [hooks],
    transports: [socket],
    admit: tickets.admit,
  });
  const server = await serve({
    runtime,
    tickets,
    code: { entry: "app.js", files: { "app.js": "" } },
  });
  try {
    assertEquals(await echo(`ws://127.0.0.1:${server.port}/relay`), "echo: hello");
  } finally {
    await server.close();
  }
});

test("without a page, the runtime's own socket still takes its clients", async () => {
  const tickets = createTickets();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [hooks],
    transports: [socket],
    admit: tickets.admit,
  });
  const server = await serve({ runtime });
  const ana: Actor = { kind: "person", id: "ana" };
  const client = connect({
    transport: {
      type: "websocket",
      config: { url: `ws://127.0.0.1:${server.port}/oxian`, allowInsecureLoopback: true },
    },
    ticket: () => Promise.resolve(tickets.issue(ana)),
    plugins: [],
  });
  try {
    await client.ready;
    assertEquals(await client.call("probe.who", {}), "ana");
  } finally {
    await client.close();
    await server.close();
  }
});

test("closing lets a running request finish, then closes the runtime", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [hooks] });
  const asked: unknown[] = [];
  const owned: Runtime = {
    ...runtime,
    close: (options?: { drain?: number }) => {
      asked.push(options);
      return runtime.close();
    },
  };
  const server = await serve({ runtime: owned });
  const base = `http://127.0.0.1:${server.port}`;
  const relay = await opened(`ws://127.0.0.1:${server.port}/relay`);
  const hungUp = closed(relay);
  const slow = fetch(`${base}/hooks/slow`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const closing = server.close({ drain: 500 });
  assertEquals(server.close({ drain: 1 }), closing, "closing again is the same close");
  const answered = await slow;
  assertEquals([answered.status, await answered.text()], [200, "slow, but done"]);
  await closing;
  await hungUp;
  assertEquals(asked, [{ drain: 500 }]);
  await assertRejects(() => fetch(`${base}/health`));
});
