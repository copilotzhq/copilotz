/**
 * Signing in by name is this machine's alone, on a real listener: a request
 * on another of its addresses (its LAN's) is refused whatever `Host` it
 * sends, `localhost` too, by the one-runtime host and the orgs host alike.
 * The socket's address says where it came from; a header never does.
 */
import { assertEquals } from "@std/assert";
import * as net from "node:net";
import { networkInterfaces } from "node:os";
import { createRuntime, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { access, devSignIn, identity } from "../../../../plugins/access/mod.ts";
import { directory } from "../../../../plugins/access/directory/mod.ts";
import { orgsHost } from "../../../orgs/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { createTickets } from "../../tickets.ts";
import { listen, serve } from "../mod.ts";

/** One of this machine's addresses that isn't loopback, if it has one. */
const LAN = Object.values(networkInterfaces()).flat().find((i) =>
  i && !i.internal && (i.family === "IPv4" || (i.family as unknown) === 4)
)?.address;

/** One raw HTTP/1.1 exchange over TCP, to the LAN address, so the Host header is ours to say. */
function raw(port: number, path: string, host: string, body: unknown): Promise<string> {
  const json = JSON.stringify(body);
  const text = `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${json.length}\r\nConnection: close\r\n\r\n${json}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: LAN, port }, () => socket.write(text));
    let got = "";
    const late = setTimeout(() => socket.destroy(), 5_000);
    socket.on("data", (d) => (got += d.toString()));
    socket.on("close", () => (clearTimeout(late), resolve(got)));
    socket.on("error", (error) => (clearTimeout(late), reject(error)));
  });
}

/** The status line a raw exchange answered. */
const status = (answer: string) => answer.split("\r\n")[0];

test({
  name: "from a LAN address, `Host: localhost` doesn't sign anyone in by name",
  ignore: !LAN,
  fn: async () => {
    const tickets = createTickets();
    const runtime = await createRuntime({
      store: memoryStore(),
      plugins: [...access, devSignIn],
      admit: tickets.admit,
    });
    const server = await serve({
      runtime,
      tickets,
      code: { entry: "app.js", files: { "app.js": "" } },
      hostname: LAN,
    });
    try {
      for (const host of ["localhost", "127.0.0.1", `${LAN}:${server.port}`]) {
        const answer = await raw(server.port, "/signin/dev", host, { name: "ana" });
        assertEquals(status(answer), "HTTP/1.1 404 Not Found", host);
        assertEquals(/set-cookie/i.test(answer), false, host);
      }
    } finally {
      await server.close();
    }
  },
});

test({
  name: "the orgs host: from a LAN address, `Host: localhost` doesn't make anyone staff",
  ignore: !LAN,
  fn: async () => {
    const dir = await createRuntime({
      store: memoryStore(),
      plugins: [
        identity,
        directory,
        devSignIn,
        definePlugin({ name: "d", resources: { directory: { staff: ["boss@example.com"] } } }),
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
      upgrade: () => new Response(null, { status: 503 }),
      code: { entry: "app.js", files: { "app.js": "" } },
    });
    const listener = await listen({
      fetch: host.serve,
      hypervisor: () => undefined,
      hostname: LAN,
    });
    try {
      for (const name of ["localhost", `${LAN}:${listener.port}`]) {
        const answer = await raw(listener.port, "/signin/dev", name, {
          name: "boss@example.com",
        });
        assertEquals(status(answer).split(" ")[1], "404", name);
        assertEquals(/set-cookie/i.test(answer), false, name);
      }
    } finally {
      await listener.shutdown();
      await host.close();
      await dir.close();
    }
  },
});
