/**
 * An app without the web app: what a WhatsApp or voice app serves. Its
 * routes alone (a webhook, and a socket of its own, as a voice call's relay
 * would be), `/health` for whatever watches it, and nothing else: no page,
 * no code, no sign-in. Stopped (Ctrl+C, or SIGTERM from a deploy), it stops
 * listening, gives running work a while to finish, and closes the runtime.
 *
 *   node examples/web-node/routes.ts [--port=8080]       # Deno and Bun run it too
 *   curl -X POST 'http://127.0.0.1:8080/hooks/ping' -d 'hello'
 *   curl 'http://127.0.0.1:8080/health'
 *   # a socket: new WebSocket("ws://127.0.0.1:8080/relay"), each message said back louder
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { createRuntime, defineAction, definePlugin } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { httpRequest, type Served } from "../../hosts/web/server.ts";
import { serveRoutes } from "../../hosts/web/node/mod.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8080" } } });

const relay = definePlugin({
  name: "relay",
  actions: {
    // A webhook: a request becomes a call, as a visitor (its `allow` decides who's let in).
    "relay.ping": defineAction({
      input: httpRequest,
      allow: () => true,
      run: (_ctx, request) => ({ body: { pong: request.body ?? null } }),
    }),
    "relay.say": defineAction({
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: (_ctx, input) => input.text.toUpperCase(),
    }),
  },
  resources: {
    routes: {
      ping: { path: "/hooks/ping", action: "relay.ping", methods: ["POST"] },
      // A socket of its own: each message goes to an Action, and its answer back.
      relay: {
        path: "/relay",
        serve: (request: Request, host: Served) => {
          if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("Connect with a WebSocket", { status: 426 });
          }
          const { socket, response } = host.upgrade();
          socket.onmessage = async (event) => {
            socket.send(await host.runtime.call<string>("relay.say", { text: String(event.data) }));
          };
          return response;
        },
      },
    },
  },
});

const runtime = await createRuntime({ store: memoryStore(), plugins: [relay] });
const server = await serveRoutes({ runtime, port: Number(values.port) });
console.log(`${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.close({ drain: 5_000 });
    process.exit(0);
  });
}
