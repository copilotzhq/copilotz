/**
 * An app without the web app: what a WhatsApp or voice app serves, as
 * plugins' routes alone (`routes`, answered by `runtime.fetch`): a webhook,
 * and a socket of its own, as a voice call's relay would be, with
 * `/health` for whatever watches it, and nothing else: no page, no code, no
 * sign-in. A route deals with HTTP and calls an Action with plain data, which
 * does the work. Stopped (Ctrl+C, or SIGTERM from a deploy), it stops
 * listening, gives running work a while to finish, and closes the runtime.
 *
 *   node examples/web-node/routes.ts [--port=8080]       # Deno and Bun run it too
 *   curl -X POST 'http://127.0.0.1:8080/hooks/ping' -d 'hello'
 *   curl 'http://127.0.0.1:8080/health'
 *   # a socket: new WebSocket("ws://127.0.0.1:8080/relay"), each message said back louder
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { upgradeWebSocket } from "@oxian/oxian-js/http";
import { createRuntime, defineAction, definePlugin } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { listen } from "../../hosts/web/node/mod.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8080" } } });

const relay = definePlugin({
  name: "relay",
  actions: {
    // Plain data in and out: no request. Called by a route as the system, it needs no `allow`.
    "relay.ping": defineAction({
      input: { type: "object", properties: { body: { type: "string" } } },
      run: (_ctx, input) => ({ pong: input.body ?? null }),
    }),
    "relay.say": defineAction({
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: (_ctx, input) => input.text.toUpperCase(),
    }),
  },
  routes: {
    // A webhook: the request's body becomes a call.
    "/hooks/ping": async (request, { runtime }) => {
      if (request.method !== "POST") {
        return new Response("Only POST", { status: 405, headers: { allow: "POST" } });
      }
      const answer = await runtime.call("relay.ping", { body: await request.text() });
      return Response.json(answer);
    },
    // A socket of its own: each message goes to an Action, and its answer back.
    "/relay": (request, { runtime }) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Connect with a WebSocket", { status: 426 });
      }
      const { socket, response } = upgradeWebSocket(request);
      socket.onmessage = async (event) => {
        socket.send(await runtime.call<string>("relay.say", { text: String(event.data) }));
      };
      return response;
    },
  },
});

const runtime = await createRuntime({ store: memoryStore(), plugins: [relay] });
const server = await listen(runtime.fetch, { port: Number(values.port) });
console.log(`${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.shutdown();
    await runtime.close({ drain: 5_000 });
    process.exit(0);
  });
}
