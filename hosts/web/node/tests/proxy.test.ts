/**
 * Signing in by name behind a proxy on the same machine: the app listens on
 * loopback, as advised for dev sign-in, and a proxy forwards to it over
 * loopback, rewriting `Host` to the app's (nginx's `$proxy_host`, Apache's
 * `ProxyPreserveHost Off`, `ngrok --host-header=rewrite`). Every request
 * through it then comes from this machine, to this machine. What gives it
 * away is the header a proxy adds to say whom it forwards for
 * (`x-forwarded-for`, `forwarded`, `via`…): with any of them, nobody signs
 * in by name. A request straight from this machine still does. A proxy that
 * says nothing (nginx's `proxy_pass` as it comes) can't be told from this
 * machine: dev sign-in doesn't start in an app whose links say it's public.
 */
import { assert, assertEquals } from "@std/assert";
import { createServer, request as forward } from "node:http";
import type { AddressInfo } from "node:net";
import { createRuntime, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { identity } from "../../../../plugins/access/identity/mod.ts";
import { devSignIn } from "../../../../plugins/access/dev/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { listen } from "../serve.ts";

/**
 * A proxy on this machine, forwarding to `upstream` over loopback: `Host`
 * becomes the upstream's, and it adds `headers` (what it says of the caller).
 */
async function proxy(upstream: number, headers: Record<string, string>) {
  const server = createServer((incoming, outgoing) => {
    const sent = forward({
      host: "127.0.0.1",
      port: upstream,
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstream}`, ...headers },
    }, (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    });
    sent.on("error", () => outgoing.destroy());
    incoming.pipe(sent);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Signs in by name at `origin`, as a client that isn't a browser (no `Origin`). */
const signIn = async (origin: string) => {
  const answer = await fetch(`${origin}/signin/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ name: "ceo@acme.example" }),
  });
  await answer.body?.cancel();
  return { status: answer.status, cookie: answer.headers.has("set-cookie") };
};

test("a proxy on this machine that says whom it forwards for signs nobody in by name", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [identity, devSignIn] });
  const app = await listen(runtime.fetch);
  const proxies: { close(): Promise<void> }[] = [];
  try {
    // Straight from this machine, to this machine: signed in.
    assertEquals(await signIn(`http://127.0.0.1:${app.port}`), { status: 200, cookie: true });
    const said: Record<string, Record<string, string>> = {
      "x-forwarded-for": { "x-forwarded-for": "203.0.113.9" },
      "a loopback x-forwarded-for": { "x-forwarded-for": "127.0.0.1" },
      "forwarded": { forwarded: "for=203.0.113.9;proto=https" },
      "x-real-ip": { "x-real-ip": "203.0.113.9" },
      "via": { via: "1.1 proxy" },
      "x-forwarded-host": { "x-forwarded-host": "app.example" },
      "cf-connecting-ip": { "cf-connecting-ip": "203.0.113.9" },
    };
    for (const [what, headers] of Object.entries(said)) {
      const through = await proxy(app.port, headers);
      proxies.push(through);
      const answer = await signIn(`http://127.0.0.1:${through.port}`);
      console.log(`through a Host-rewriting proxy that adds ${what}: ${answer.status}`);
      assertEquals(answer, { status: 404, cookie: false }, what);
    }
  } finally {
    await Promise.all(proxies.map((p) => p.close()));
    await app.shutdown();
    await runtime.close();
  }
});

test("dev sign-in doesn't start in an app whose links say it's somewhere public", async () => {
  const start = (origin: string) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        identity,
        devSignIn,
        definePlugin({
          name: "app",
          resources: { links: { origin, secret: "the-app-secret-for-tests-0123456789" } },
        }),
      ],
    }).then(async (runtime) => (await runtime.close(), "started"), (error) => error.message);
  for (const origin of ["https://app.example.com", "http://203.0.113.9:8080"]) {
    const said = await start(origin);
    console.log(`dev sign-in with links at ${origin}: ${said}`);
    assert(String(said).includes("leave devSignIn out of a deployed app"), origin);
  }
  // This machine, or one on its network: it starts, as ever.
  for (
    const origin of [
      "http://localhost:8790",
      "https://127.0.0.1",
      "http://[::1]:8790",
      "http://192.168.1.20:8080",
      "http://studio.local",
    ]
  ) {
    assertEquals(await start(origin), "started", origin);
  }
});
