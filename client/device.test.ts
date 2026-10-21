import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createDeviceTransport } from "./device.ts";
import { createLiveQuery } from "./live-query.ts";
import { attachDeviceSocket } from "../server/device.ts";
import {
  DEVICE_LIMITS,
  type DeviceSocket,
  fragments,
  Reassembly,
  SubscriptionQueue,
} from "../runtime/subscriptions/device.ts";
import type { SubscriptionFrame } from "../runtime/subscriptions/types.ts";
import { record } from "./testing/live-transport.test.ts";

const snapshot = (seq = "1", text = "a"): SubscriptionFrame => ({
  t: "snapshot",
  rows: [record({ id: "a", text })],
  sequence: seq,
  checkpoint: `s${seq}`,
  complete: true,
});
const batch = (from = "1", to = "2"): SubscriptionFrame => ({
  t: "batch",
  from,
  to,
  changes: [],
  checkpoint: `s${to}`,
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
class Socket extends EventTarget implements DeviceSocket {
  readyState = 1;
  bufferedAmount = 0;
  peer!: Socket;
  output: Record<string, unknown>[] = [];
  filter?: (frame: Record<string, unknown>) => boolean;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const frame = JSON.parse(String(data));
    this.output.push(frame);
    if (this.filter?.(frame) === false) return;
    queueMicrotask(() => {
      this.peer.dispatchEvent(
        new MessageEvent("message", { data: String(data) }),
      );
    });
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = this.peer.readyState = 3;
    queueMicrotask(() => {
      this.dispatchEvent(new CloseEvent("close", { code }));
      this.peer.dispatchEvent(new CloseEvent("close", { code }));
    });
  }
}
function pair() {
  const client = new Socket(), server = new Socket();
  client.peer = server;
  server.peer = client;
  return { client, server };
}
function fixture() {
  const sockets: ReturnType<typeof pair>[] = [];
  const queues = new Map<string, SubscriptionQueue<SubscriptionFrame>>();
  const cursors: { collection: string; checkpoint?: string }[] = [];
  let credentials = "session", authenticated = 0, detached = 0;
  const device = createDeviceTransport({
    url: "ws://test",
    credentials: () => credentials,
    socket() {
      const socket = pair();
      sockets.push(socket);
      attachDeviceSocket(socket.server, {
        heartbeatMs: 10,
        async authenticate(proof) {
          await Promise.resolve();
          authenticated++;
          if (proof !== "session") {
            throw Object.assign(new Error("Denied"), { code: "forbidden" });
          }
          return {
            async observe(collection, _query, options) {
              await Promise.resolve();
              cursors.push({ collection, checkpoint: options.checkpoint });
              const queue = new SubscriptionQueue<SubscriptionFrame>();
              queues.set(collection, queue);
              if (options.checkpoint === "s1") queue.push(batch());
              else queue.push(snapshot());
              return {
                frames: queue,
                detach() {
                  detached++;
                  queue.end();
                },
              };
            },
          };
        },
      });
      queueMicrotask(() => socket.client.dispatchEvent(new Event("open")));
      return socket.client;
    },
  });
  return {
    device,
    sockets,
    queues,
    cursors,
    setCredentials(value: string) {
      credentials = value;
    },
    counts: () => ({ authenticated, detached }),
  };
}
Deno.test("device fragments bounded logical JSON atomically; gaps, overlap and missing checkpoint reject", () => {
  const frame = {
    ...snapshot("1", "é".repeat(600_000)),
    channel: "a",
    generation: 1,
  };
  const parts = [...fragments(frame)].map((data) => {
    assert(new TextEncoder().encode(data).length <= DEVICE_LIMITS.frame);
    return JSON.parse(data);
  });
  assert(parts.length > 1);
  const assembler = new Reassembly();
  for (const part of parts.slice(0, -1)) {
    assertEquals(assembler.accept(part), undefined);
  }
  assertEquals(assembler.accept(parts.at(-1)), frame);
  assertThrows(() => new Reassembly().accept(parts[1]), Error, "gap");
  const overlap = new Reassembly();
  overlap.accept(parts[0]);
  assertThrows(() => overlap.accept(parts[0]), Error, "Overlapping");
  const missing = new Reassembly();
  for (const part of parts.slice(0, -1)) missing.accept(part);
  assertThrows(
    () => missing.accept({ ...parts.at(-1), checkpoint: undefined }),
    Error,
    "Incomplete",
  );
  assertThrows(
    () =>
      new Reassembly().accept({
        ...parts[0],
        total: DEVICE_LIMITS.logical + 1,
      }),
    Error,
    "declaration",
  );
});
Deno.test("device heartbeat repairs a lost final push from applied checkpoint while another channel progresses", async () => {
  const f = fixture();
  const a = createLiveQuery(f.device, "a", {}),
    b = createLiveQuery(f.device, "b", {});
  try {
    await until(() => a.sequence === "1" && b.sequence === "1");
    let dropped = false;
    f.sockets[0].server.filter = (frame) => {
      if (frame.t === "batch" && !dropped) {
        dropped = true;
        return false;
      }
      return true;
    };
    f.queues.get("a")!.push(batch());
    await until(() => dropped);
    f.queues.get("b")!.push(batch());
    await until(() => a.sequence === "2" && b.sequence === "2");
    assertEquals(
      f.cursors.filter((c) => c.collection === "a").map((c) => c.checkpoint),
      [undefined, "s1"],
    );
    assertEquals(f.cursors.filter((c) => c.collection === "b").length, 1);
    const subscriptions = f.sockets[0].client.output.filter((frame) =>
      frame.t === "subscribe" && frame.collection === "a"
    );
    assertEquals(subscriptions[0].channel, subscriptions[1].channel);
    assertEquals(subscriptions[1].generation, 2);
    f.sockets[0].server.send(
      JSON.stringify({
        ...snapshot("99"),
        channel: subscriptions[0].channel,
        generation: 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(a.sequence, "2");
  } finally {
    a.close();
    b.close();
    f.device.close();
    await Promise.allSettled([a.done, b.done]);
  }
});
Deno.test("device reauthentication fences a blocked handler and denied proof closes all reads", async () => {
  const f = fixture(), blocked = Promise.withResolvers<void>();
  let entered = false;
  const live = createLiveQuery(f.device, "a", {}, {
    async onChange(_rows, frame) {
      if (frame.t === "batch" && !entered) {
        entered = true;
        await blocked.promise;
      }
    },
  });
  try {
    await until(() => live.sequence === "1");
    f.queues.get("a")!.push(batch());
    await until(() => entered);
    await f.device.reauthenticate();
    blocked.resolve();
    await until(() => f.cursors.length === 2 && live.sequence === "2");
    assertEquals(
      f.cursors[1].checkpoint,
      "s1",
      "fenced handler must not acknowledge the proposed batch",
    );
    assertEquals(f.counts().authenticated, 2);
    f.setCredentials("denied");
    await assertRejects(() => f.device.reauthenticate(), Error);
    await assertRejects(() => live.done, Error);
    assertEquals(live.status, "denied");
    assertEquals(live.rows, []);
  } finally {
    blocked.resolve();
    live.close();
    f.device.close();
    await live.done.catch(() => {});
  }
});
Deno.test("device logical snapshot over frame bound reaches the shared SDK handle", async () => {
  const f = fixture();
  const live = createLiveQuery(f.device, "a", {});
  try {
    await until(() => live.sequence === "1");
    f.queues.get("a")!.push(snapshot("2", "x".repeat(2 * 1024 * 1024)));
    await until(() => live.sequence === "2");
    assertEquals((live.rows[0].text as string).length, 2 * 1024 * 1024);
    assert(f.sockets[0].server.output.some((frame) => frame.t === "fragment"));
  } finally {
    live.close();
    f.device.close();
    await live.done;
  }
});
Deno.test("device applied handler failure detaches only that channel without acknowledging poison output", async () => {
  const f = fixture();
  const bad = createLiveQuery(f.device, "a", {}, {
    onChange(_rows, frame) {
      if (frame.t === "batch") throw new Error("poison");
    },
  });
  const good = createLiveQuery(f.device, "b", {});
  try {
    await until(() => bad.sequence === "1" && good.sequence === "1");
    f.queues.get("a")!.push(batch());
    await assertRejects(() => bad.done, Error, "poison");
    assertEquals(bad.checkpoint, "s1");
    f.queues.get("b")!.push(batch());
    await until(() => good.sequence === "2");
    const badId = f.sockets[0].client.output.find((frame) =>
      frame.collection === "a"
    )!.channel;
    assertEquals(
      f.sockets[0].client.output.filter((frame) =>
        frame.t === "applied" && frame.channel === badId
      ).map((frame) => frame.checkpoint),
      ["s1"],
    );
  } finally {
    bad.close();
    good.close();
    f.device.close();
    await good.done;
  }
});
Deno.test("device client overflow fences a blocked application and resumes only its applied checkpoint", async () => {
  const sockets = pair();
  const requests: Record<string, unknown>[] = [];
  sockets.server.addEventListener("message", (event) => {
    const frame = JSON.parse((event as MessageEvent).data);
    requests.push(frame);
    if (frame.t === "hello") {
      sockets.server.send(
        JSON.stringify({
          t: "welcome",
          version: "1.0",
          capabilities: ["subscriptions"],
        }),
      );
    }
    if (frame.t === "subscribe") {
      sockets.server.send(
        JSON.stringify({
          ...(frame.cursor ? batch("1", "300") : snapshot()),
          channel: frame.channel,
          generation: frame.generation,
        }),
      );
    }
  });
  const device = createDeviceTransport({
    url: "ws://test",
    credentials: () => "session",
    socket() {
      queueMicrotask(() => sockets.client.dispatchEvent(new Event("open")));
      return sockets.client;
    },
  });
  const blocked = Promise.withResolvers<void>();
  let entered = false;
  const a = createLiveQuery(device, "a", {}, {
    async onChange(_rows, frame) {
      if (frame.t === "batch" && !entered) {
        entered = true;
        await blocked.promise;
      }
    },
  });
  const b = createLiveQuery(device, "b", {});
  try {
    await until(() => a.sequence === "1" && b.sequence === "1");
    const channel = requests.find((frame) => frame.collection === "a")!;
    for (let i = 1; i < 280; i++) {
      sockets.server.send(
        JSON.stringify({
          ...batch(String(i), String(i + 1)),
          channel: channel.channel,
          generation: 1,
        }),
      );
    }
    await until(() => entered);
    await until(() =>
      requests.some((frame) =>
        frame.t === "unsubscribe" && frame.channel === channel.channel
      )
    );
    blocked.resolve();
    await until(() => a.sequence === "300");
    assertEquals(
      requests.filter((frame) => frame.collection === "a").map((frame) =>
        frame.cursor
      ),
      [undefined, "s1"],
    );
    assertEquals(b.sequence, "1");
    assertEquals(
      requests.filter((frame) => frame.collection === "b").length,
      1,
    );
  } finally {
    blocked.resolve();
    a.close();
    b.close();
    device.close();
    await Promise.allSettled([a.done, b.done]);
  }
});
Deno.test("device clean EOF drains a blocked final output without reconnecting", async () => {
  const sockets = pair(), blocked = Promise.withResolvers<void>();
  let entered = false, subscriptions = 0;
  sockets.server.addEventListener("message", (event) => {
    const frame = JSON.parse((event as MessageEvent).data);
    if (frame.t === "hello") {
      sockets.server.send(
        JSON.stringify({
          t: "welcome",
          version: "1.0",
          capabilities: ["subscriptions"],
        }),
      );
    }
    if (frame.t === "subscribe") {
      subscriptions++;
      sockets.server.send(
        JSON.stringify({
          ...snapshot(),
          channel: frame.channel,
          generation: 1,
        }),
      );
      sockets.server.send(
        JSON.stringify({ t: "eof", channel: frame.channel, generation: 1 }),
      );
    }
  });
  const device = createDeviceTransport({
    url: "ws://test",
    credentials: () => "session",
    socket() {
      queueMicrotask(() => sockets.client.dispatchEvent(new Event("open")));
      return sockets.client;
    },
  });
  const live = createLiveQuery(device, "a", {}, {
    async onChange() {
      entered = true;
      await blocked.promise;
    },
  });
  try {
    await until(() => entered);
    blocked.resolve();
    await live.done;
    assertEquals(live.sequence, "1");
    assertEquals(subscriptions, 1);
  } finally {
    blocked.resolve();
    live.close();
    device.close();
  }
});
Deno.test("device control revocation clears queued data and fences an in-flight handler", async () => {
  const f = fixture(), blocked = Promise.withResolvers<void>();
  let entered = false;
  const live = createLiveQuery(f.device, "a", {}, {
    async onChange(_rows, frame) {
      if (frame.t === "batch") {
        entered = true;
        await blocked.promise;
      }
    },
  });
  try {
    await until(() => live.sequence === "1");
    f.queues.get("a")!.push(batch());
    await until(() => entered);
    f.queues.get("a")!.push({ t: "revoked", reason: "permission" });
    await until(() =>
      f.sockets[0].server.output.some((frame) => frame.t === "revoked")
    );
    const stale = f.sockets[0].client.output.find((frame) =>
      frame.t === "subscribe"
    )!;
    for (let i = 0; i < 300; i++) {
      f.sockets[0].server.send(
        JSON.stringify({
          ...snapshot("99"),
          channel: stale.channel,
          generation: stale.generation,
        }),
      );
    }
    blocked.resolve();
    await assertRejects(() => live.done, Error, "revoked");
    assertEquals(live.rows, []);
    assertEquals(live.checkpoint, undefined);
    assertEquals(
      f.sockets[0].client.output.filter((frame) => frame.t === "applied").map(
        (frame) => frame.checkpoint,
      ),
      ["s1"],
    );
  } finally {
    blocked.resolve();
    live.close();
    f.device.close();
    await live.done.catch(() => {});
  }
});
Deno.test("device typed content survives bounded logical JSON without changing application fields", async () => {
  const f = fixture();
  const live = createLiveQuery(f.device, "a", {});
  try {
    await until(() => live.sequence === "1");
    f.queues.get("a")!.push({
      t: "snapshot",
      complete: true,
      sequence: "2",
      checkpoint: "s2",
      rows: [
        record({
          id: "a",
          bytes: new Uint8Array([0, 128, 255]),
          nested: { "": new Uint8Array([1]) },
          binaryPaths: "application field",
        }),
      ],
    });
    await until(() => live.sequence === "2");
    assertEquals(live.rows[0].bytes, new Uint8Array([0, 128, 255]));
    assertEquals(
      (live.rows[0].nested as Record<string, unknown>)[""],
      new Uint8Array([1]),
    );
    assertEquals(live.rows[0].binaryPaths, "application field");
  } finally {
    live.close();
    f.device.close();
    await live.done;
  }
});
Deno.test("device server renews the largest queued channel before a revoked control and keeps the socket usable", async () => {
  const sockets = pair(),
    queues = new Map<string, SubscriptionQueue<SubscriptionFrame>>();
  const session = attachDeviceSocket(sockets.server, {
    authenticate: () => ({
      async observe(collection) {
        await Promise.resolve();
        const queue = new SubscriptionQueue<SubscriptionFrame>();
        queues.set(collection, queue);
        return {
          frames: queue,
          detach() {
            queue.end();
          },
        };
      },
    }),
  });
  try {
    sockets.client.send(
      JSON.stringify({
        t: "hello",
        version: "1.0",
        capabilities: ["subscriptions"],
        credentials: "session",
      }),
    );
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "welcome")
    );
    sockets.client.send(
      JSON.stringify({
        t: "subscribe",
        channel: "large",
        generation: 1,
        collection: "large",
        query: {},
      }),
    );
    sockets.client.send(
      JSON.stringify({
        t: "subscribe",
        channel: "small",
        generation: 1,
        collection: "small",
        query: {},
      }),
    );
    await until(() => queues.size === 2);
    queues.get("large")!.push(snapshot("1", "x".repeat(5 * 1024 * 1024)));
    queues.get("small")!.push(snapshot());
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "renew")
    );
    assertEquals(
      sockets.server.output.find((frame) => frame.t === "renew")!.channel,
      "large",
    );
    queues.get("small")!.push({ t: "revoked", reason: "permission" });
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "revoked")
    );
    assertEquals(sockets.server.readyState, 1);
    sockets.client.send(
      JSON.stringify({
        t: "subscribe",
        channel: "small",
        generation: 2,
        collection: "small",
        query: {},
      }),
    );
    await until(() => queues.get("small")!.size === 0);
  } finally {
    session.close();
    sockets.client.close();
  }
});
Deno.test("device lifetime renews upstream and stale detach cannot retire a newer generation", async () => {
  const sockets = pair();
  let detached = 0, attached = 0;
  const session = attachDeviceSocket(sockets.server, {
    lifetimeMs: 25,
    authenticate: () => ({
      async observe() {
        await Promise.resolve();
        attached++;
        const queue = new SubscriptionQueue<SubscriptionFrame>();
        return {
          frames: queue,
          detach() {
            detached++;
            queue.end();
          },
        };
      },
    }),
  });
  try {
    sockets.client.send(
      JSON.stringify({
        t: "hello",
        version: "1.0",
        capabilities: ["subscriptions"],
        credentials: "session",
      }),
    );
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "welcome")
    );
    for (const generation of [1, 2]) {
      sockets.client.send(
        JSON.stringify({
          t: "subscribe",
          channel: "a",
          generation,
          collection: "a",
          query: {},
        }),
      );
    }
    await until(() => attached === 2 && detached === 1);
    sockets.client.send(
      JSON.stringify({ t: "unsubscribe", channel: "a", generation: 1 }),
    );
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "renew")
    );
    assertEquals(
      sockets.server.output.find((frame) => frame.t === "renew")!.generation,
      2,
    );
    assertEquals(detached, 2);
  } finally {
    session.close();
  }
});
Deno.test("device oversized handshake is refused before authentication sees its body", async () => {
  const sockets = pair();
  let authenticated = 0;
  const session = attachDeviceSocket(sockets.server, {
    authenticate() {
      authenticated++;
      throw new Error("Unexpected authentication");
    },
  });
  try {
    sockets.client.send(
      JSON.stringify({
        t: "hello",
        version: "1.0",
        capabilities: ["subscriptions"],
        credentials: "x".repeat(DEVICE_LIMITS.frame),
      }),
    );
    await until(() => sockets.server.readyState === 3);
    assertEquals(authenticated, 0);
    assertEquals(sockets.server.output[0].code, "protocol_error");
  } finally {
    session.close();
  }
});
Deno.test("device revocation interrupts a partial logical snapshot without adopting any fragment checkpoint", async () => {
  const f = fixture(), live = createLiveQuery(f.device, "a", {});
  try {
    await until(() => live.sequence === "1");
    const channel = f.sockets[0].client.output.find((frame) =>
      frame.t === "subscribe"
    )!;
    const parts = fragments({
      ...snapshot("2", "x".repeat(2 * 1024 * 1024)),
      channel: String(channel.channel),
      generation: 1,
    });
    f.sockets[0].server.send(parts.next().value!);
    f.sockets[0].server.send(
      JSON.stringify({
        t: "revoked",
        reason: "permission",
        channel: channel.channel,
        generation: 1,
      }),
    );
    await assertRejects(() => live.done, Error, "revoked");
    assertEquals(live.rows, []);
    assertEquals(live.status, "denied");
    assertEquals(f.cursors.length, 1);
  } finally {
    live.close();
    f.device.close();
    await live.done.catch(() => {});
  }
});
Deno.test("device clean socket EOF preserves complete output pending a successful handler", async () => {
  const sockets = pair(), blocked = Promise.withResolvers<void>();
  let entered = false;
  sockets.server.addEventListener("message", (event) => {
    const frame = JSON.parse((event as MessageEvent).data);
    if (frame.t === "hello") {
      sockets.server.send(
        JSON.stringify({
          t: "welcome",
          version: "1.0",
          capabilities: ["subscriptions"],
        }),
      );
    }
    if (frame.t === "subscribe") {
      sockets.server.send(
        JSON.stringify({
          ...snapshot(),
          channel: frame.channel,
          generation: 1,
        }),
      );
      sockets.server.close();
    }
  });
  const device = createDeviceTransport({
    url: "ws://test",
    credentials: () => "session",
    socket() {
      queueMicrotask(() => sockets.client.dispatchEvent(new Event("open")));
      return sockets.client;
    },
  });
  const live = createLiveQuery(device, "a", {}, {
    async onChange() {
      entered = true;
      await blocked.promise;
    },
  });
  try {
    await until(() => entered);
    blocked.resolve();
    await live.done;
    assertEquals(live.sequence, "1");
  } finally {
    blocked.resolve();
    live.close();
    device.close();
  }
});
Deno.test("device send gate fences queued owner output during permission reauthorization", async () => {
  const sockets = pair(), queue = new SubscriptionQueue<SubscriptionFrame>();
  let publishable = true;
  const session = attachDeviceSocket(sockets.server, {
    authenticate: () => ({
      async observe() {
        await Promise.resolve();
        return {
          frames: queue,
          canPublish: () => publishable,
          detach() {
            queue.end();
          },
        };
      },
    }),
  });
  try {
    sockets.client.send(
      JSON.stringify({
        t: "hello",
        version: "1.0",
        capabilities: ["subscriptions"],
        credentials: "session",
      }),
    );
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "welcome")
    );
    sockets.client.send(
      JSON.stringify({
        t: "subscribe",
        channel: "a",
        generation: 1,
        collection: "a",
        query: {},
      }),
    );
    queue.push(snapshot());
    publishable = false;
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "renew")
    );
    assertEquals(
      sockets.server.output.filter((frame) => frame.t === "snapshot"),
      [],
    );
  } finally {
    session.close();
  }
});
Deno.test("device renews channels and detaches upstream before the host request deadline", async () => {
  const sockets = pair();
  let detached = false;
  const session = attachDeviceSocket(sockets.server, {
    requestDeadline: Date.now() + 1050,
    authenticate: () => ({
      async observe() {
        await Promise.resolve();
        const queue = new SubscriptionQueue<SubscriptionFrame>();
        return {
          frames: queue,
          detach() {
            detached = true;
            queue.end();
          },
        };
      },
    }),
  });
  try {
    sockets.client.send(
      JSON.stringify({
        t: "hello",
        version: "1.0",
        capabilities: ["subscriptions"],
        credentials: "session",
      }),
    );
    await until(() =>
      sockets.server.output.some((frame) => frame.t === "welcome")
    );
    sockets.client.send(
      JSON.stringify({
        t: "subscribe",
        channel: "a",
        generation: 1,
        collection: "a",
        query: {},
      }),
    );
    await until(() => sockets.server.readyState === 3);
    assert(detached);
    assertEquals(
      sockets.server.output.find((frame) => frame.t === "renew")?.reason,
      "request_deadline",
    );
  } finally {
    session.close();
  }
});
Deno.test("device close while session proof is pending never opens a late socket", async () => {
  const proof = Promise.withResolvers<unknown>();
  let opened = 0;
  const device = createDeviceTransport({
    url: "ws://test",
    credentials: () => proof.promise,
    socket() {
      opened++;
      return pair().client;
    },
  });
  const live = createLiveQuery(device, "a", {});
  device.close();
  proof.resolve("session");
  await assertRejects(() => live.done, Error, "closed");
  assertEquals(opened, 0);
  live.close();
});

Deno.test("device forwards progress-only selection without row/content substitution", async () => {
  const sockets = pair();
  let selection: unknown;
  const server = attachDeviceSocket(sockets.server, {
    authenticate: () => ({
      async observe(collection, query, options) {
        await Promise.resolve();
        selection = {
          collection,
          query,
          progressOnly: options.progressOnly,
          content: options.content,
        };
        const queue = new SubscriptionQueue<SubscriptionFrame>();
        queue.push({
          t: "snapshot",
          rows: [],
          sequence: "1",
          complete: true,
          checkpoint: "progress",
        });
        return {
          frames: queue,
          detach() {
            queue.end();
          },
        };
      },
    }),
  });
  const device = createDeviceTransport({
    url: "ws://test",
    credentials: () => "proof",
    socket: () => {
      queueMicrotask(() => sockets.client.dispatchEvent(new Event("open")));
      return sockets.client;
    },
  });
  const live = createLiveQuery(device, "entry", {}, { progressOnly: true });
  try {
    await until(() => live.checkpoint === "progress");
    assertEquals(selection, {
      collection: "entry",
      query: {},
      progressOnly: true,
      content: undefined,
    });
    assertEquals(live.rows, []);
    assertEquals(
      sockets.client.output.find((frame) => frame.t === "subscribe")
        ?.progressOnly,
      true,
    );
  } finally {
    live.close();
    device.close();
    server.close();
  }
});
