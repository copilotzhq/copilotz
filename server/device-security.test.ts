import { assert, assertEquals } from "@std/assert";
import { WebSocket as Socket } from "ws";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../runtime/testing/server-authorization.test.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { defineCollection } from "../runtime/collections/definition.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { createHypervisor } from "../dependencies/oxian-hypervisor.ts";
import { listen } from "../runtime/adapters/node/listen.ts";

const hello = (credentials: unknown) => ({
  t: "hello",
  version: "1.0",
  capabilities: ["subscriptions"],
  credentials,
});
function connect(url: string, headers: Record<string, string> = {}) {
  const socket = new Socket(url.replace(/^http/, "ws") + "/api/device", {
    headers,
  });
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  const opened = new Promise<number>((resolve) => {
    socket.on("open", () => resolve(101));
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.on("error", () => {});
  });
  return {
    socket,
    frames,
    opened,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Device security timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
for (const adapter of ["deno", "node"] as const) {
  Deno.test(`SEC3 ${adapter} real facade socket enforces origins, proof, quotas and pre-auth byte bounds`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    });
    const schema = `device_security_${crypto.randomUUID().replaceAll("-", "")}`;
    const authGate = Promise.withResolvers<void>();
    const facade = defineTestServerFacade({
      allowedOrigins: ["https://trusted.example"],
      deviceLimits: { maxSubscriptions: 2, maxPendingBytes: 512 },
      expose: { collections: true },
      async authenticate(request) {
        if (request.headers.get("authorization") === "Bearer pending") {
          await authGate.promise;
        }
        return request.headers.get("cookie") === "sid=victim" ||
            request.headers.get("authorization")?.startsWith("Bearer ")
          ? {}
          : new Response(null, { status: 403 });
      },
    });
    const app = await createTestApplication({
      database: db,
      databaseSchema: schema,
      namespace: "main",
      collections: {
        note: defineCollection({
          name: "note",
          schema: { type: "object", properties: { id: { type: "string" } } },
        }),
      },
      resources: { server: { default: facade } },
    });
    const handler = createServerFacadeFetchHandler(
      app,
      adapter === "deno"
        ? { upgradeDevice: (request) => Deno.upgradeWebSocket(request) }
        : {},
    );
    const hypervisor = createHypervisor({
      transports: [{
        type: "in-process",
        config: { topic: crypto.randomUUID() },
      }],
      fallback: handler,
    });
    const server = adapter === "deno"
      ? Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler)
      : await listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${
      "addr" in server ? server.addr.port : server.port
    }`;
    const peers: ReturnType<typeof connect>[] = [];
    const open = (headers: Record<string, string> = {}) => {
      const peer = connect(url, headers);
      peers.push(peer);
      return peer;
    };
    try {
      const evil = open({
        origin: "https://evil.example",
        cookie: "sid=victim",
      });
      assertEquals(await evil.opened, 403);
      for (const origin of [url, "https://trusted.example"]) {
        const peer = open({ origin, cookie: "sid=victim" });
        assertEquals(await peer.opened, 101);
        peer.send(hello({ cookie: true }));
        await until(() => peer.frames.some((f) => f.t === "welcome"));
        peer.send({
          t: "subscribe",
          channel: "a",
          generation: 1,
          collection: "note",
          query: {},
        });
        await until(() => peer.frames.some((f) => f.t === "snapshot"));
      }
      const token = open();
      assertEquals(await token.opened, 101);
      token.send(hello({ authorization: "Bearer token" }));
      await until(() => token.frames.some((f) => f.t === "welcome"));
      for (let i = 0; i < 3; i++) {
        token.send({
          t: "subscribe",
          channel: `c${i}`,
          generation: 1,
          collection: "note",
          query: {},
        });
      }
      await until(() =>
        token.frames.some((f) => f.code === "subscription_capacity_exceeded")
      );
      token.send({ t: "unsubscribe", channel: "c0", generation: 1 });
      token.send({
        t: "subscribe",
        channel: "replacement",
        generation: 1,
        collection: "note",
        query: {},
      });
      await until(() =>
        token.frames.some((f) =>
          f.channel === "replacement" && f.t === "snapshot"
        )
      );
      for (
        const credentials of [{}, { cookie: "sid=victim" }, {
          authorization: "invalid",
        }]
      ) {
        const peer = open({ cookie: "sid=victim" });
        await peer.opened;
        peer.send(hello(credentials));
        await until(() => peer.frames.some((f) => f.t === "error"));
        assert(!peer.frames.some((f) => f.t === "welcome"));
      }
      const pending = open();
      await pending.opened;
      pending.send(hello({ authorization: "Bearer pending" }));
      pending.send({
        t: "subscribe",
        channel: "early",
        generation: 1,
        collection: "note",
        query: {},
      });
      await until(() => pending.frames.some((f) => f.t === "error"));
      assert(!pending.frames.some((f) => f.t === "welcome"));
      const oversized = open();
      await oversized.opened;
      oversized.send(hello({ authorization: `Bearer ${"x".repeat(600)}` }));
      await until(() => oversized.frames.some((f) => f.t === "error"));
      assert(!oversized.frames.some((f) => f.t === "welcome"));
    } finally {
      authGate.resolve();
      for (const peer of peers) peer.socket.terminate();
      await server.shutdown();
      await hypervisor.shutdown();
      await app.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}
