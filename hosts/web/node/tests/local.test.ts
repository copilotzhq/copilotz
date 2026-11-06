/**
 * Signing in by name is this machine's alone, on a real listener: a request
 * on another of its addresses (its LAN's) is refused whatever `Host` it
 * sends, `localhost` too.
 * The socket's address says where it came from; a header never does.
 */
import { assertEquals } from "@std/assert";
import * as net from "node:net";
import { networkInterfaces } from "node:os";
import { createRuntime } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { access, devSignIn } from "../../../../plugins/access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { listen } from "../serve.ts";

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
    const runtime = await createRuntime({ store: memoryStore(), plugins: [...access, devSignIn] });
    const listener = await listen(runtime.fetch, { hostname: LAN });
    try {
      for (const host of ["localhost", "127.0.0.1", `${LAN}:${listener.port}`]) {
        const answer = await raw(listener.port, "/signin/dev", host, { name: "ana" });
        assertEquals(status(answer), "HTTP/1.1 404 Not Found", host);
        assertEquals(/set-cookie/i.test(answer), false, host);
      }
    } finally {
      await listener.shutdown();
      await runtime.close();
    }
  },
});
