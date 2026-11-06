/**
 * Browsers let in over the real socket, as the third review probed them: a
 * connection counts from the moment it's let in (Welcome), not once it says
 * it's ready, so connections opened together can't pass a limit; a resume
 * credential works once, for the browser it was given to; a worker has 10
 * seconds to say it's ready; and one let in before who it was is ended
 * (signed out) is never ready, nor is a ticket handed out before let in.
 */
import { assert, assertEquals } from "@std/assert";
import { createWorker } from "@oxian/oxian-js";
import {
  createRuntime,
  definePlugin,
  type Runtime,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { CALL, SESSION } from "../../../../runtime/browsers.ts";
import { decode, encode } from "../../../../runtime/wire.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../../plugins/models/mod.ts";
import { chat } from "../../../../plugins/agents/chat/mod.ts";
import { access } from "../../../../plugins/access/mod.ts";
import { webLines } from "../../../../plugins/interfaces/web/lines.ts";
import { test, testWho, ticketFor } from "../../../../testing/mod.ts";
import { listen, type Listener } from "../serve.ts";

/** The runtime's socket. */
const SOCKET = "/oxian";

const app = definePlugin({
  name: "app",
  resources: {
    provider: { script: { adapter: "script" } },
    agents: { guide: { instructions: "x", model: "script/main" } },
    spaces: { visitors: { name: "Website", agents: ["guide"] } },
    web: { site: { in: "visitors", agent: "guide" } },
    links: { origin: "http://127.0.0.1", secret: "the-app-secret-for-tests-0123456789" },
  },
  adapters: { llm: { script: { async *generate() {} } } },
  // Every space, as the system reads them.
  views: {
    spaces: (_: unknown, ctx: ViewContext) =>
      (ctx.db.collection<{ _id: string }>("space").find({}).value ?? []).map((s) => s._id),
  },
});

async function setup(fn: (server: Listener, runtime: Runtime) => Promise<void>) {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, webLines, app, testWho],
  });
  const server = await listen(runtime.fetch);
  try {
    await fn(server, runtime);
  } finally {
    await server.shutdown();
    await runtime.close();
  }
}

const post = (server: Listener, path: string, body: unknown, cookie?: string) =>
  fetch(`${server.url.origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.url.origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

/** A visitor of the line: its ticket, and the cookie that's it. */
async function arrive(server: Listener, cookie?: string) {
  let kept = cookie;
  if (!kept) {
    const came = await post(server, "/web/site", {});
    assertEquals(came.status, 200, await came.clone().text());
    kept = came.headers.get("set-cookie")!.split(";")[0];
    await came.body?.cancel();
  }
  const r = await post(server, "/connect", {}, kept);
  assertEquals(r.status, 200, await r.clone().text());
  const { ticket } = await r.json() as { ticket: string };
  return { ticket, cookie: kept };
}

/** Settles in time: "ok", or why not. */
const settle = async (p: Promise<unknown>, ms: number): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise((_, reject) => timer = setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  } finally {
    clearTimeout(timer);
  }
};

type Raw = {
  worker: ReturnType<typeof createWorker>;
  /** The resume credential its Welcome gave, or why it wasn't welcomed. */
  welcomed: Promise<string>;
};

/**
 * A browser of an attacker's: Oxian's own worker, its socket watched for
 * the Welcome (its resume credential), its Ready sent when `gate` says.
 */
function raw(
  server: Listener,
  credential: { kind: "registration" | "resume"; capability: string },
  id: string,
  gate?: Promise<void>,
): Raw {
  const welcomed = Promise.withResolvers<string>();
  const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };
  const worker = createWorker({
    id,
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${server.port}${SOCKET}`,
        allowInsecureLoopback: true,
        socket: (context: { url: string; protocol: string }) => {
          const ws = new WebSocket(context.url, context.protocol);
          ws.addEventListener("message", (e: MessageEvent) => {
            if (typeof e.data !== "string") return;
            const frame = JSON.parse(e.data);
            if (frame.type === "welcome") welcomed.resolve(frame.resumeCapability);
            if (frame.type === "protocol_error") welcomed.reject(new Error(frame.code));
          });
          ws.addEventListener("close", () => welcomed.reject(new Error("closed")));
          const send = ws.send.bind(ws);
          ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            if (gate && typeof data === "string" && JSON.parse(data).type === "ready") {
              void gate.then(() => {
                try {
                  send(data);
                } catch { /* closed */ }
              });
              return;
            }
            send(data);
          };
          return ws;
        },
      },
    } as never,
    activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
    register: () =>
      Promise.resolve({
        credential,
        expiresAtMs: Date.now() + 60_000,
        ...(credential.kind === "resume" ? { resumeExpiresAtMs: Date.now() + 3_600_000 } : {}),
      }),
    reconnectDelay: false,
    capacity: 1,
    hostCalls: { maxConcurrent: 4 },
    workloads: {
      [SESSION]: async ({ input }: { input: ReadableStream<Uint8Array> }) => {
        const reader = input.getReader();
        while (!(await reader.read()).done) { /* its news */ }
      },
    },
  } as never) as ReturnType<typeof createWorker>;
  worker.closed.catch(() => {});
  worker.ready.catch(() => {});
  welcomed.promise.catch(() => {});
  return { worker, welcomed: welcomed.promise };
}

test("connections opened together count as they're let in: one visitor's 30 at once, 2 ready", async () => {
  await setup(async (server, runtime) => {
    const first = await arrive(server);
    const tickets = [first.ticket];
    for (let i = 0; i < 29; i++) tickets.push((await arrive(server, first.cookie)).ticket);
    const clients = tickets.map((ticket, i) =>
      connect({
        transport: {
          type: "websocket",
          config: {
            url: `ws://127.0.0.1:${server.port}${SOCKET}`,
            allowInsecureLoopback: true,
          },
        },
        ticket: () => Promise.resolve(ticket),
        plugins: [],
        id: `tab-${i}`,
      })
    );
    try {
      const ready = await Promise.all(clients.map((c) => settle(c.ready, 8_000)));
      // Before: 23 or 24 of the 30, a visitor's limit being 2.
      assertEquals(ready.filter((r) => r === "ok").length, 2);
      assertEquals(runtime.stats().browsers, 2);
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    }
  });
});

test("a resume credential works once, for the browser it was given to: one ticket is one browser", async () => {
  await setup(async (server) => {
    const { ticket } = await arrive(server);
    const workers: Raw[] = [];
    const held = Promise.withResolvers<void>();
    try {
      const first = raw(server, { kind: "registration", capability: ticket }, "tab-0");
      workers.push(first);
      const again = await first.welcomed;
      await first.worker.ready;
      // Another browser showing it isn't let in; and it's used up then, for its own too.
      const other = raw(server, { kind: "resume", capability: again }, "tab-1", held.promise);
      workers.push(other);
      assertEquals(await settle(other.welcomed, 5_000), "authentication_failed");
      const back = raw(server, { kind: "resume", capability: again }, "tab-0", held.promise);
      workers.push(back);
      assertEquals(await settle(back.welcomed, 5_000), "authentication_failed");
      // The chain the review ran (each admission's new credential shown by a new browser,
      // Ready held until all are in): before, a thousand connections from one ticket.
      let credential = await (async () => {
        const fresh = raw(server, {
          kind: "registration",
          capability: (await arrive(server)).ticket,
        }, "chain-0");
        workers.push(fresh);
        return await fresh.welcomed;
      })();
      let admitted = 0;
      for (let i = 1; i <= 20; i++) {
        const next = raw(
          server,
          { kind: "resume", capability: credential },
          `chain-${i}`,
          held.promise,
        );
        workers.push(next);
        if (await settle(next.welcomed, 5_000) !== "ok") break;
        credential = await next.welcomed;
        admitted++;
      }
      assertEquals(admitted, 0);
    } finally {
      held.resolve();
      await Promise.all(workers.map((w) => w.worker.stop().catch(() => {})));
    }
  });
});

test("one browser holds two connections at most while it comes back; a third closes the oldest", async () => {
  await setup(async (server) => {
    const { ticket } = await arrive(server);
    const workers: Raw[] = [];
    const held = Promise.withResolvers<void>();
    try {
      const first = raw(server, { kind: "registration", capability: ticket }, "tab");
      workers.push(first);
      let credential = await first.welcomed;
      await first.worker.ready;
      // Back on a new connection while the first is still there: let in, its Ready held.
      const second = raw(server, { kind: "resume", capability: credential }, "tab", held.promise);
      workers.push(second);
      credential = await second.welcomed;
      // A third, the first two still there: let in, and the oldest closed (before: refused, so a
      // tab whose Welcome was lost on a network flap stayed locked out). Still two at most.
      const third = raw(server, { kind: "resume", capability: credential }, "tab", held.promise);
      workers.push(third);
      assertEquals(await settle(third.welcomed, 5_000), "ok");
    } finally {
      held.resolve();
      await Promise.all(workers.map((w) => w.worker.stop().catch(() => {})));
    }
  });
});

/**
 * A WebSocket whose network can fail: `kill()` tells the worker it closed (1006) while the real
 * socket stays open and silent (half-open, as the server sees it); `dropWelcome` kills it as the
 * Welcome arrives, before the worker sees it.
 */
class Flaky extends EventTarget {
  real: WebSocket;
  dead = false;
  constructor(url: string, protocol: string | string[] | undefined, dropWelcome: boolean) {
    super();
    this.real = new WebSocket(url, protocol);
    for (const type of ["open", "error", "close"]) {
      this.real.addEventListener(type, (e) => {
        if (this.dead) return;
        const close = e as CloseEvent;
        this.dispatchEvent(
          type === "close"
            ? new CloseEvent("close", { code: close.code, reason: close.reason })
            : new Event(type),
        );
      });
    }
    this.real.addEventListener("message", (e) => {
      if (this.dead) return;
      if (typeof e.data === "string" && dropWelcome) {
        try {
          if (JSON.parse(e.data).type === "welcome") return this.kill();
        } catch { /* not JSON */ }
      }
      this.dispatchEvent(new MessageEvent("message", { data: e.data }));
    });
  }
  get readyState() {
    return this.dead ? 3 : this.real.readyState;
  }
  get bufferedAmount() {
    return this.real.bufferedAmount;
  }
  get protocol() {
    return this.real.protocol;
  }
  get extensions() {
    return this.real.extensions;
  }
  get url() {
    return this.real.url;
  }
  get binaryType() {
    return this.real.binaryType;
  }
  set binaryType(v: BinaryType) {
    this.real.binaryType = v;
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (!this.dead) this.real.send(data);
  }
  close(code?: number, reason?: string) {
    if (!this.dead) this.real.close(code, reason);
  }
  kill() {
    if (this.dead) return;
    this.dead = true;
    queueMicrotask(() =>
      super.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "", wasClean: false }))
    );
  }
  override dispatchEvent(e: Event) {
    return this.dead && e.type !== "close" ? false : super.dispatchEvent(e);
  }
}

test("a tab comes back after a network flap whose reconnect's Welcome is lost", async () => {
  await setup(async (server, runtime) => {
    const ana = { kind: "person" as const, id: "ana" };
    const sockets: Flaky[] = [];
    const client = connect({
      transport: {
        type: "websocket",
        config: {
          url: `ws://127.0.0.1:${server.port}${SOCKET}`,
          allowInsecureLoopback: true,
          // The second socket (the reconnect) loses its Welcome: the network went as it came.
          socket: (context: { url: string; protocol: string }) => {
            const s = new Flaky(context.url, context.protocol, sockets.length === 1);
            sockets.push(s);
            return s;
          },
        },
      } as never,
      ticket: () => ticketFor(runtime, ana),
      plugins: [],
    });
    try {
      await client.ready;
      // The network drops; the server isn't told (the first socket is half-open there).
      sockets[0].kill();
      // Before: the resume credential was spent unwelcomed, the third connection refused, and the
      // client gave up: locked out for good. Now it re-enrols, and is back within seconds.
      let back = "never";
      for (let i = 0; i < 20 && back !== "ok"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        back = await settle(client.call("space.create", { id: `s${i}`, name: "S" }), 2_000);
      }
      assertEquals(back, "ok");
    } finally {
      await client.close().catch(() => {});
      for (const s of sockets) {
        try {
          s.real.close();
        } catch { /* closed */ }
      }
    }
  });
});

test("a worker welcomed has 10 seconds to say it's ready", async () => {
  await setup((_server, runtime) => {
    assertEquals(runtime.hypervisor.config.readyTimeoutMs, 10_000);
    return Promise.resolve();
  });
});

test("a connection let in before its person signs out is never ready, nor a ticket taken before", async () => {
  await setup(async (server, runtime) => {
    // Signed in by a session of hers (not dev sign-in's route: it owns the `session` cookie,
    // and identity's `/signout` can't clear it too).
    const { session } = await runtime.call<{ session: string }>("session.start", { person: "ana" });
    const cookie = `session=${session}`;
    const { ticket } = await (await post(server, "/connect", {}, cookie)).json();
    const workers: Raw[] = [];
    const held = Promise.withResolvers<void>();
    try {
      // A stolen cookie's: one connection ready, and one let in, its Ready held.
      const ready = raw(server, { kind: "registration", capability: ticket }, "thief-1");
      workers.push(ready);
      const again = await ready.welcomed;
      await ready.worker.ready;
      const waiting = raw(server, { kind: "resume", capability: again }, "thief-1", held.promise);
      workers.push(waiting);
      await waiting.welcomed;
      // And a ticket taken before, kept for after.
      const { ticket: spare } = await (await post(server, "/connect", {}, cookie)).json();
      assertEquals((await post(server, "/signout", {}, cookie)).status, 200);
      const later = raw(server, { kind: "registration", capability: spare }, "thief-2");
      workers.push(later);
      assertEquals(await settle(later.welcomed, 5_000), "authentication_failed");
      assertEquals(await settle(ready.worker.closed, 5_000), "ok");
      held.resolve();
      // Before: ready, and making spaces as her.
      assert(await settle(waiting.worker.ready, 3_000) !== "ok");
      const made = await settle(
        (async () => {
          const call = await waiting.worker.callHost({
            workload: CALL,
            body: encode({ action: "space.create", input: { id: "after", name: "After" } }),
          });
          return decode(call.output);
        })(),
        2_000,
      );
      assert(made !== "ok");
      const spaces = runtime.observe<string[]>("spaces", {});
      const seen = await spaces.ready;
      spaces.close();
      assert(seen.status === "ready" && !seen.value.includes("after"));
    } finally {
      held.resolve();
      await Promise.all(workers.map((w) => w.worker.stop().catch(() => {})));
    }
  });
});
