import { assert, assertEquals } from "@std/assert";
import { WebSocket as Socket } from "ws";
import { createHypervisor } from "../../../dependencies/oxian-hypervisor.ts";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../../testing/server-authorization.test.ts";
import { createTestDatabase } from "../../testing/ominipg.ts";
import { createServerFacadeFetchHandler } from "../../../server/facade.ts";
import { listen } from "./listen.ts";

Deno.test("Node portable facade upgrade waits for admission, cancels late acceptance and bounds native delivery", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `device_admit_${crypto.randomUUID().replaceAll("-", "")}`;
  let gate = Promise.withResolvers<void>();
  let entered = Promise.withResolvers<void>();
  let reject = false, authenticated = 0;
  const app = await createTestApplication({
    database: db,
    databaseSchema: schema,
    namespace: "main",
    resources: {
      server: {
        default: defineTestServerFacade({
          authenticate() {
            authenticated++;
            return {};
          },
        }),
      },
    },
  });
  const handler = createServerFacadeFetchHandler(app, {
    async admit() {
      entered.resolve();
      await gate.promise;
      if (reject) throw new Error("Admission refused");
    },
  });
  const hypervisor = createHypervisor({
    transports: [{
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    }],
    fallback: handler,
  });
  const listener = await listen({ hypervisor }, {
    hostname: "127.0.0.1",
    port: 0,
  });
  const peers: InstanceType<typeof Socket>[] = [];
  const connect = () => {
    const peer = new Socket(`ws://127.0.0.1:${listener.port}/api/device`);
    peers.push(peer);
    const opened = Promise.withResolvers<void>(),
      closed = Promise.withResolvers<number>();
    peer.on("open", () => opened.resolve());
    peer.on("close", (code) => closed.resolve(code));
    peer.on("error", () => {});
    return { peer, opened: opened.promise, closed: closed.promise };
  };
  try {
    const first = connect();
    await entered.promise;
    assertEquals(first.peer.readyState, Socket.CONNECTING);
    assertEquals(authenticated, 0);
    gate.resolve();
    await first.opened;
    // Native parser bounds fragmented message assembly before device delivery.
    first.peer.send("x".repeat(200000), { fin: false });
    first.peer.send("x".repeat(200000), { fin: true });
    assertEquals(await first.closed, 1009);
    assertEquals(authenticated, 0);
    gate = Promise.withResolvers<void>();
    entered = Promise.withResolvers<void>();
    const cancelled = connect();
    let accepted = false;
    void cancelled.opened.then(() => accepted = true);
    await entered.promise;
    cancelled.peer.terminate();
    await cancelled.closed;
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(!accepted);
    gate = Promise.withResolvers<void>();
    entered = Promise.withResolvers<void>();
    reject = true;
    const refused = connect();
    void refused.opened.then(() => accepted = true);
    await entered.promise;
    gate.resolve();
    await refused.closed;
    assert(!accepted);
    assertEquals(authenticated, 0);
  } finally {
    gate.resolve();
    for (const peer of peers) peer.terminate();
    await listener.shutdown();
    await hypervisor.shutdown();
    await app.close();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
