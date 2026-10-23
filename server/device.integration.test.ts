import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../runtime/testing/server-authorization.test.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { defineCollection } from "../runtime/collections/definition.ts";
import { defineAction } from "../runtime/actions/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import {
  createCopilotzClient,
  createDeviceTransport,
} from "../client/index.ts";
import {
  type BrowserViewContext,
  createBrowserPorts,
  createBrowserRuntime,
  type ReadState,
} from "../client/web/index.ts";
import { defineView } from "../runtime/views/definition.ts";
import type { DeviceSocket } from "../runtime/subscriptions/device.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for pushed state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
Deno.test("device: real owner → WebSocket → SDK → Collection → View, Action seq, resume and revocation", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `device_${crypto.randomUUID().replaceAll("-", "")}`;
  const entry = defineCollection({
    name: "entry",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        value: { type: "number" },
        body: {},
      },
      required: ["id"],
    },
    content: { fields: ["body"] },
  });
  const member = defineCollection({
    name: "member",
    schema: {
      type: "object",
      properties: { id: { type: "string" }, allowed: { type: "boolean" } },
      required: ["id"],
    },
  });
  const add = defineAction({
    id: "entry.add",
    async execute(input: { amount: number }, ctx) {
      const current = await ctx.collections.entry.get({ id: "a" });
      await ctx.collections.entry.update({
        id: "a",
        set: { value: Number(current!.value) + input.amount },
      }, { operationKey: "add" });
      return "added";
    },
  });
  let authentications = 0;
  const facade = defineTestServerFacade({
    expose: { collections: { include: ["entry"] }, actions: true },
    authenticate(request) {
      authentications++;
      if (request.headers.get("authorization") !== "Bearer session") {
        return new Response(null, { status: 403 });
      }
      return {};
    },
    async evaluate(_request, { read }) {
      const grant = await read.get("member", "viewer");
      if (grant?.allowed === false) return new Response(null, { status: 403 });
      return { collectionMutations: { entry: { update: {} } } };
    },
  });
  const application = await createTestApplication({
    database,
    databaseSchema: schema,
    namespace: "main",
    collections: { entry, member },
    actions: { add },
    resources: { server: { default: facade } },
  });
  const sockets: WebSocket[] = [],
    received: Record<string, unknown>[] = [],
    sent: Record<string, unknown>[] = [];
  let holding = false;
  const held: (() => void)[] = [];
  const handler = createServerFacadeFetchHandler(application, {
    upgradeDevice(request) {
      const upgrade = Deno.upgradeWebSocket(request), socket = upgrade.socket;
      sockets.push(socket);
      socket.addEventListener(
        "message",
        (event) => received.push(JSON.parse(event.data)),
      );
      const wrapped: DeviceSocket = {
        get readyState() {
          return socket.readyState;
        },
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
        send(data) {
          const frame = JSON.parse(String(data));
          sent.push(frame);
          if (holding && ["snapshot", "batch"].includes(frame.t)) {
            held.push(() => socket.send(data));
          } else socket.send(data);
        },
        close: socket.close.bind(socket),
        addEventListener: socket.addEventListener.bind(socket),
        removeEventListener: socket.removeEventListener.bind(socket),
      };
      return { response: upgrade.response, socket: wrapped };
    },
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  const baseUrl = `http://127.0.0.1:${server.addr.port}/api`;
  const clientFrames: Record<string, unknown>[][] = [];
  const device = createDeviceTransport({
    url: baseUrl.replace("http", "ws") + "/device",
    credentials: () => ({ authorization: "Bearer session" }),
    socket(url) {
      const socket = new WebSocket(url), frames: Record<string, unknown>[] = [];
      clientFrames.push(frames);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        frames.push(JSON.parse(String(data)));
        send(data);
      };
      return socket;
    },
  });
  const client = createCopilotzClient({
    baseUrl,
    device,
    getRequestHeaders: () => ({ authorization: "Bearer session" }),
  });
  const renders: ReadState[] = [];
  const runtime = await createBrowserRuntime({
    ...createBrowserPorts(client),
    plugins: [{
      id: "app",
      collections: {
        entry: {
          placement: "server",
          commands: {
            add: {
              mutate: ({ current, input }) => ({
                set: { value: Number(current.value) + Number(input) },
              }),
            },
          },
        },
      },
      actions: {
        add: {
          id: "entry.add",
          placement: "server",
          optimistic: {
            collection: "entry",
            command: "add",
            id: () => "a",
            input: (input) => (input as { amount: number }).amount,
          },
        },
      },
      views: {
        entry: defineView<unknown, unknown, BrowserViewContext>({
          id: "entry",
          shows: "entry",
          modes: ["full"],
          renderer: "fake",
          render(_value, ctx) {
            return ctx.collections.entry.get("a", {
              content: { fields: ["body"], byteLimit: 4096 },
            });
          },
        }),
      },
    }],
    renderer: {
      id: "fake",
      mount(_target, output) {
        const render = () => renders.push(output.getSnapshot() as ReadState);
        render();
        const dispose = output.subscribe(render);
        return { dispose };
      },
    },
  });
  const value = () =>
    (renders.at(-1)?.value as { value?: number } | undefined)?.value;
  try {
    await application.host.collections.member.create({
      id: "viewer",
      allowed: true,
    });
    runtime.mount(null, { shows: "entry", value: null });
    await until(() => renders.at(-1)?.status === "missing");
    const hidden = client.collections.observe("member");
    await assertRejects(() => hidden.done, Error);
    assertEquals(hidden.status, "denied");
    hidden.close();
    assertEquals(
      sockets.length,
      1,
      "SDK and browser runtime share one authenticated socket",
    );
    await application.host.collections.entry.create({
      id: "a",
      value: 1,
      body: "Initial body",
    });
    await until(() => value() === 1);
    assert(sent.some((frame) => frame.t === "batch"));
    assertEquals(
      (renders.at(-1)!.value as { body: { value: string }[] }).body[0].value,
      "Initial body",
    );
    holding = true;
    const action = runtime.actions.add({ amount: 2 });
    assertEquals(value(), 3);
    assertEquals(renders.at(-1)?.pending, true);
    assertEquals(await action.result(), "added");
    assertEquals(
      renders.at(-1)?.pending,
      true,
      "HTTP terminal cannot settle unapplied owner sequence",
    );
    await until(() => held.length > 0);
    holding = false;
    for (const send of held.splice(0)) send();
    await until(() => renders.at(-1)?.pending === false);
    assertEquals(value(), 3);
    await until(() => received.some((frame) => frame.t === "applied"));
    const snapshots = sent.filter((frame) => frame.t === "snapshot").length;
    sockets.at(-1)!.close(4012, "restart");
    await application.host.collections.entry.update({
      id: "a",
      set: { value: 4 },
    });
    await until(() => value() === 4);
    const resumed = received.filter((frame) => frame.t === "subscribe").at(-1)!;
    assertEquals(
      resumed.cursor,
      clientFrames[0].filter((frame) => frame.t === "applied").at(-1)!
        .checkpoint,
    );
    assertEquals(
      sent.filter((frame) => frame.t === "snapshot").length,
      snapshots,
      "retained history resumes without a new snapshot",
    );
    const authenticatedBefore = authentications;
    await device.reauthenticate();
    await until(() => authentications > authenticatedBefore);
    await application.host.collections.entry.update({
      id: "a",
      set: { value: 5 },
    });
    await until(() => value() === 5);
    await application.host.collections.member.update({
      id: "viewer",
      set: { allowed: false },
    });
    await until(() => renders.at(-1)?.status === "denied");
    assertEquals(renders.at(-1)?.value, undefined);
    const subscriptions = received.filter((frame) =>
      frame.t === "subscribe"
    ).length;
    await application.host.collections.entry.update({
      id: "a",
      set: { value: 999 },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(value(), undefined);
    assertEquals(
      received.filter((frame) => frame.t === "subscribe").length,
      subscriptions,
    );
  } finally {
    runtime.dispose();
    device.close();
    for (const socket of sockets) if (socket.readyState < 2) socket.close();
    await server.shutdown();
    await application.close();
    await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.close();
  }
});
