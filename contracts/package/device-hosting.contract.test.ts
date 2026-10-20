import { createCopilotz as createWorker } from "../../worker.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineAction, defineCollection } from "../../index.ts";
import { listen as denoListen } from "../../runtime/adapters/deno/index.ts";
import { listen as nodeListen } from "../../runtime/adapters/node/index.ts";
import {
  createTestCopilotz,
  defineTestServerFacade,
} from "../../runtime/testing/server-authorization.test.ts";
import {
  createCopilotzClient,
  createDeviceTransport,
} from "../../client/index.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for device state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const entry = defineCollection({
  name: "entry",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, value: { type: "number" } },
    required: ["id"],
  },
});
const session = defineCollection({
  name: "session",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, active: { type: "boolean" } },
    required: ["id"],
  },
});
const facade = () =>
  defineTestServerFacade({
    expose: { collections: { include: ["entry"] } },
    authenticate(request) {
      return request.headers.get("authorization") === "Bearer session"
        ? {}
        : new Response(null, { status: 403 });
    },
    async evaluate(_request, { read }) {
      const current = await read.get("session", "viewer");
      return current?.active === true
        ? {}
        : new Response(null, { status: 403 });
    },
  });

for (
  const [runtime, listen] of [["Deno", denoListen], [
    "Node",
    nodeListen,
  ]] as const
) {
  for (const role of ["embedded", "gateway"] as const) {
    Deno.test(`${runtime} ${role} public listen: device deltas, session revocation and worker coexistence`, async () => {
      const schema = `device_host_${crypto.randomUUID().replaceAll("-", "")}`;
      const actions = {
        echo: defineAction({
          id: "host.echo",
          execute: (_input: null) => "worker result",
        }),
      };
      const common = {
        database: {
          url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
        },
        databaseSchema: schema,
        namespace: "main",
        collections: { entry, session },
        actions,
        resources: { server: { default: facade() } },
      };
      const app = role === "gateway"
        ? await createTestCopilotz({
          ...common,
          role: "gateway",
          target: { workerId: "device-host-worker" },
          transports: [{
            type: "websocket" as const,
            config: { path: "/workers" },
          }],
          admit(context) {
            return {
              definition: {
                workerId: context.identity.workerId,
                providerId: "test",
                workloads: [...context.workloads],
                capacity: context.capacity,
                providerConfig: {},
                labels: {},
              },
              sessionGeneration: 1,
              authenticatedWith: context.credential.kind,
              resume: {
                credential: { kind: "resume" as const, capability: "resume" },
                expiresAtMs: Date.now() + 60000,
              },
            };
          },
        })
        : await createTestCopilotz({ ...common, role: "embedded" });
      let worker: { close(): Promise<void> } | undefined;
      const frames: Record<string, unknown>[] = [];
      let device: ReturnType<typeof createDeviceTransport> | undefined;
      try {
        await app.collections.session.create({ id: "viewer", active: true });
        const listener = await listen(app);
        const baseUrl = new URL("api", listener.url).href;
        const normal = await fetch(`${baseUrl}/device`);
        assertEquals(normal.status, 426);
        await normal.body?.cancel();
        const refused = createDeviceTransport({
          url: baseUrl.replace("http", "ws") + "/device",
          credentials: () => ({ authorization: "Bearer invalid" }),
        });
        try {
          const denied = createCopilotzClient({ baseUrl, device: refused })
            .collections.observe("entry");
          await assertRejects(() => denied.done);
          assertEquals(denied.status, "denied");
          assertEquals(denied.rows, []);
          denied.close();
        } finally {
          refused.close();
        }
        if (role === "gateway") {
          const workerUrl = new URL("workers", listener.url);
          workerUrl.protocol = "ws:";
          const connected = await createWorker({
            role: "worker",
            id: "device-host-worker",
            actions,
            databaseSchema: schema,
            namespace: "main",
            transport: {
              type: "websocket",
              config: { url: workerUrl, allowInsecureLoopback: true },
            },
            activate: () => ({
              workerId: "device-host-worker",
              attemptId: "attempt",
              epoch: 1,
            }),
            register: () => ({
              credential: { kind: "registration", capability: "test" },
              expiresAtMs: Date.now() + 60000,
            }),
            handshake() {},
            reconnectDelay: false,
          });
          worker = connected;
          await connected.ready;
        }
        device = createDeviceTransport({
          url: baseUrl.replace("http", "ws") + "/device",
          credentials: () => ({ authorization: "Bearer session" }),
          socket(url) {
            const socket = new WebSocket(url);
            socket.addEventListener(
              "message",
              (event) => frames.push(JSON.parse(event.data)),
            );
            return socket;
          },
        });
        const client = createCopilotzClient({ baseUrl, device });
        const live = client.collections.observe("entry");
        void live.done.catch(() => undefined);
        await until(() => live.status === "ready");
        assertEquals(live.rows.length, 0);
        await app.collections.entry.create({ id: "a", value: 1 });
        await until(() => live.rows[0]?.value === 1);
        assert(frames.some((frame) => frame.t === "batch"));
        if (role === "gateway") {
          assertEquals(
            await app.actions.echo(null, { idempotencyKey: "echo" }),
            "worker result",
          );
        }
        await app.collections.session.update({
          id: "viewer",
          set: { active: false },
        });
        await until(() => live.status === "denied");
        assertEquals(live.rows, []);
        assert(frames.some((frame) => frame.t === "revoked"));
        live.close();
        device.close();
        // An idle socket is owned by the listener as well.
        const idle = new WebSocket(baseUrl.replace("http", "ws") + "/device");
        await new Promise<void>((resolve, reject) => {
          idle.onopen = () => resolve();
          idle.onerror = () => reject(new Error("idle socket failed"));
        });
        const closed = new Promise<void>((resolve) =>
          idle.onclose = () => resolve()
        );
        await listener.shutdown();
        await closed;
      } finally {
        device?.close();
        await worker?.close();
        await app.close();
      }
    });
  }
}

for (const role of ["embedded", "gateway"] as const) {
  Deno.test(`public ${role} custom upgrade is used by fetch and Deno listen, with deadline renewal`, async () => {
    let upgrades = 0;
    const options = {
      database: {
        url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
      },
      databaseSchema: `device_custom_${
        crypto.randomUUID().replaceAll("-", "")
      }`,
      collections: { entry, session },
      resources: { server: { default: facade() } },
      upgradeDevice(request: Request) {
        upgrades++;
        return {
          ...Deno.upgradeWebSocket(request),
          requestDeadline: Date.now() + 1500,
        };
      },
    };
    const app = role === "gateway"
      ? await createTestCopilotz({ ...options, role: "gateway" })
      : await createTestCopilotz({ ...options, role: "embedded" });
    const custom = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      app.fetch,
    );
    try {
      const hosted = denoListen(app);
      for (const port of [custom.addr.port, hosted.port]) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/device`);
        const closed = new Promise<CloseEvent>((resolve, reject) => {
          socket.onclose = resolve;
          socket.onerror = () => reject(new Error("Custom upgrade failed"));
        });
        const event = await closed;
        assertEquals(event.code, 4000);
        assertEquals(event.reason, "Device connection renewal");
      }
      assertEquals(upgrades, 2);
    } finally {
      await custom.shutdown();
      await app.close();
    }
  });
}
