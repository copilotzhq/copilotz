import { createShardWorker as createWorker } from "./shard-worker.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { WorkerOptions } from "../../dependencies/oxian-worker.ts";
import { createCopilotz, defineAction } from "../../index.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCopilotzShard,
  shardForActor,
  type ShardPrincipal,
} from "./shard.ts";
import {
  createShardController,
  createShardControllerHandler,
} from "./shard-controller.ts";
const bytes = (s: string) => new TextEncoder().encode(s);
function fixture(
  principals: Record<string, ShardPrincipal>,
  id = "s",
  shardIds = [id],
) {
  let generation = 0;
  const shard = createCopilotzShard({
    id,
    shardIds,
    capacity: 1,
    transports: [{ type: "websocket", config: { path: "/connect" } }],
    config: { dispatchQueueTimeoutMs: 1000 },
    admit(context) {
      const logicalId = context.identity.workerId.startsWith("shard:")
        ? context.identity.workerId.split(":").slice(2).join(":")
        : context.identity.workerId;
      const principal = principals[context.identity.workerId] ??
        principals[logicalId];
      if (
        !principal ||
        context.credential.capability !== logicalId
      ) throw new Error("unauthorized");
      return {
        principal,
        definition: {
          workerId: context.identity.workerId,
          providerId: "test",
          workloads: context.workloads,
          capacity: context.capacity,
          providerConfig: {},
          labels: {},
        },
        sessionGeneration: ++generation,
        authenticatedWith: context.credential.kind,
        resume: {
          credential: { kind: "resume", capability: logicalId },
          expiresAtMs: Date.now() + 60000,
        },
      };
    },
    calls: {
      admit: (binding) =>
        binding.workload === "owner.echo"
          ? async (context) =>
            bytes(
              `${binding.fence.identity.workerId}:${await new Response(
                context.input,
              ).text()}`,
            )
          : undefined,
      admitUnassigned: () => undefined,
    },
  });
  const listener = listen(shard);
  const options = (
    id: string,
    epoch = 1,
  ): Omit<WorkerOptions, "workloads"> & { kind?: ShardPrincipal["kind"] } => ({
    kind: principals[id]?.kind,
    id,
    capacity: 1,
    transport: {
      type: "websocket",
      config: {
        url: `ws://127.0.0.1:${listener.port}/connect`,
        allowInsecureLoopback: true,
      },
    },
    activate: () => ({ workerId: id, attemptId: `attempt-${epoch}`, epoch }),
    register: () => ({
      credential: { kind: "registration", capability: id },
      expiresAtMs: Date.now() + 60000,
    }),
    reconnectDelay: () => 10,
  });
  return { shard, listener, options };
}
for (const kind of ["worker", "computer", "browser", "connector"] as const) {
  Deno.test(`shard dispatches authenticated ${kind} with workload scope and capacity`, async () => {
    const actor = { namespace: "scope", id: "actor" };
    const f = fixture({
      peer: {
        kind,
        workloads: ["echo"],
        ...(kind === "browser" ? { actor } : {}),
      },
    });
    const worker = createWorker({
      ...f.options("peer"),
      workloads: {
        echo: (context) => {
          assertEquals(context.metadata, { exact: true });
          return bytes(kind);
        },
      },
    });
    try {
      await worker.ready;
      const work = await f.shard.dispatch({
        workload: "echo",
        metadata: { exact: true },
        kind,
        target: { workerId: "peer" },
        ...(kind === "browser" ? { actor } : {}),
      });
      await work.started;
      assertEquals(await new Response(work.output).text(), kind);
      assertEquals((await work.completed).status, "completed");
      assertEquals(f.shard.capacity().ready, 1);
      assert(f.shard.capacity().needsMoreShards);
      await assertRejects(
        () =>
          f.shard.dispatch({
            workload: "other",
            kind,
            target: { workerId: "peer" },
            requireConnected: true,
          }),
        Error,
      );
      if (kind === "browser") {
        await assertRejects(() =>
          f.shard.dispatch({
            workload: "echo",
            kind,
            actor: { ...actor, id: "forged" },
            target: { workerId: "peer" },
            requireConnected: true,
          }), Error);
      }
      await assertRejects(
        () =>
          f.shard.dispatch({
            workload: "echo",
            kind: kind === "computer" ? "connector" : "computer",
            target: { workerId: "peer" },
          }),
        Error,
      );
    } finally {
      await worker.stop();
      await f.shard.close();
    }
  });
}
Deno.test("browser actor placement is order stable and refuses the wrong shard", async () => {
  const actor = { namespace: "scope", id: "actor" };
  const assigned = await shardForActor(actor, ["a", "b", "c"]);
  assertEquals(await shardForActor(actor, ["c", "a", "b"]), assigned);
  const f = fixture(
    { peer: { kind: "browser", actor, workloads: ["echo"] } },
    ["a", "b", "c"].find((s) => s !== assigned)!,
    ["a", "b", "c"],
  );
  const worker = createWorker({
    ...f.options("peer"),
    reconnectDelay: false,
    workloads: { echo: () => bytes("bad") },
  });
  try {
    await assertRejects(() => worker.ready);
  } finally {
    await worker.stop();
    await f.shard.close();
  }
});
Deno.test("scoped callHost reaches owner with the authenticated identity", async () => {
  const f = fixture({
    peer: { kind: "computer", workloads: ["echo"], calls: ["owner.echo"] },
  });
  const worker = createWorker({
    ...f.options("peer"),
    workloads: {
      echo: async (context) => {
        const call = await context.callHost({
          workload: "owner.echo",
          body: bytes("hello"),
          metadata: { workerId: "forged" },
        });
        const result = await new Response(call.output).text();
        await call.completed;
        await assertRejects(async () => {
          const refused = await context.callHost({
            workload: "copilotz.owner.v1",
          });
          await refused.started;
        });
        return bytes(result);
      },
    },
  });
  try {
    await worker.ready;
    const work = await f.shard.dispatch({
      workload: "echo",
      target: { workerId: "peer" },
      kind: "computer",
    });
    assertEquals(
      await new Response(work.output).text(),
      "shard:computer:peer:hello",
    );
    assertEquals((await work.completed).status, "completed");
  } finally {
    await worker.stop();
    await f.shard.close();
  }
});
Deno.test("shard fences takeover and drains connections without shutting workers down", async () => {
  const f = fixture({ peer: { kind: "computer", workloads: ["echo"] } });
  const old = createWorker({
    ...f.options("peer"),
    workloads: { echo: () => bytes("old") },
  });
  let next: ReturnType<typeof createWorker> | undefined;
  try {
    await old.ready;
    const pending = f.shard.dispatch({
      workload: "echo",
      kind: "computer",
      epoch: 2,
      target: { workerId: "peer" },
    });
    assertEquals((await old.closed).reason, "shutdown");
    next = createWorker({
      ...f.options("peer", 2),
      workloads: { echo: () => bytes("new") },
    });
    await next.ready;
    const work = await pending;
    assertEquals(await new Response(work.output).text(), "new");
    await work.completed;
    await assertRejects(
      () =>
        f.shard.dispatch({
          workload: "echo",
          kind: "computer",
          epoch: 1,
          target: { workerId: "peer" },
        }),
      Error,
      "stale_epoch",
    );
    const before =
      f.shard.hypervisor.sessions.get("shard:computer:peer")!.connectionId;
    await f.shard.hypervisor.drain("shard:computer:peer");
    const deadline = Date.now() + 3000;
    while (
      f.shard.hypervisor.sessions.get("shard:computer:peer")?.phase !==
        "ready" ||
      f.shard.hypervisor.sessions.get("shard:computer:peer")?.connectionId ===
        before
    ) {
      if (Date.now() > deadline) throw new Error("reconnect timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let stopped = false;
    void next.closed.then(() => {
      stopped = true;
    }, () => {
      stopped = true;
    });
    await f.shard.drain();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(
      stopped,
      false,
      "drain refuses upgrades without revoking credentials",
    );
    assert(f.shard.capacity().draining);
    await assertRejects(
      () => f.shard.dispatch({ workload: "echo", kind: "computer" }),
      Error,
      "shard_draining",
    );
  } finally {
    await old.stop();
    await next?.stop();
    await f.shard.close();
  }
});
Deno.test("stateless shard controller starts before acknowledgement and preserves terminal framing", async () => {
  const f = fixture({ peer: { kind: "computer", workloads: ["echo"] } });
  let started = false;
  const worker = createWorker({
    ...f.options("peer"),
    workloads: {
      echo: () => {
        started = true;
        return bytes("hello\nworld");
      },
    },
  });
  const handler = createShardControllerHandler({
    authenticate: (request) =>
      request.headers.get("authorization") === "Bearer test",
    shard: f.shard,
    authorize: (request, input) =>
      request.headers.get("authorization") === "Bearer test" &&
      input.kind === "computer",
  });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    handler,
  );
  const controller = createShardController({
    url: `http://127.0.0.1:${server.addr.port}`,
    headers: () => ({ authorization: "Bearer test" }),
  });
  try {
    await worker.ready;
    const work = await controller.dispatch({
      workload: "echo",
      kind: "computer",
      epoch: 1,
      target: { workerId: "peer" },
    });
    assert(started);
    assertEquals(await new Response(work.output).text(), "hello\nworld");
    assertEquals((await work.completed).status, "completed");
    await assertRejects(
      () =>
        controller.dispatch({
          workload: "echo",
          kind: "connector",
          target: { workerId: "peer" },
        }),
      Error,
    );
  } finally {
    await worker.stop();
    await f.shard.close();
    await server.shutdown();
  }
});
Deno.test("gateway owner capabilities and receipts cross the shard to a database-free worker", async () => {
  const f = fixture({
    peer: { kind: "worker", workloads: ["copilotz.delivery.v1"] },
    "shard:computer:peer": { kind: "computer", workloads: ["echo"] },
    "shard:browser:peer": {
      kind: "browser",
      actor: { namespace: "scope", id: "actor" },
      workloads: ["echo"],
    },
  });
  const database = await createTestDatabase();
  const databaseSchema = `shard_${crypto.randomUUID().replaceAll("-", "")}`;
  let effects = 0;
  const actions = {
    echo: defineAction({
      id: "shard.echo",
      async execute(input: { value: string }, context) {
        const permission = await context.effect.begin("once");
        if (permission.status === "replay") return permission.outcome;
        assertEquals(permission.status, "proceed");
        effects++;
        await context.effect.confirm("once", input.value);
        return input.value;
      },
    }),
  };
  const gateway = await createCopilotz({
    role: "gateway",
    database,
    databaseSchema,
    namespace: "scope",
    actions,
    dispatcher: (binding) => f.shard.bindOwner(binding),
    target: { workerId: "peer" },
  });
  const worker = await createCopilotz({
    role: "worker",
    ...f.options("peer"),
    databaseSchema,
    namespace: "scope",
    actions,
  });
  try {
    await worker.ready;
    for (let n = 0; n < 2; n++) {
      assertEquals(
        await gateway.actions.echo({ value: "owner" }, {
          idempotencyKey: "same",
        }),
        "owner",
      );
    }
    assertEquals(effects, 1);
  } finally {
    await worker.close();
    await gateway.close();
    await f.shard.close();
    await database.close();
  }
});

Deno.test("queued work cannot cross an epoch takeover", async () => {
  const f = fixture({ peer: { kind: "computer", workloads: ["echo"] } });
  let runs = 0;
  const entered = Promise.withResolvers<void>();
  const old = createWorker({
    ...f.options("peer"),
    reconnectDelay: false,
    workloads: {
      echo: async (context) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
        return bytes("old");
      },
    },
  });
  let replacement: ReturnType<typeof createWorker> | undefined;
  try {
    await old.ready;
    const active = await f.shard.dispatch({
      workload: "echo",
      kind: "computer",
      epoch: 1,
      target: { workerId: "peer" },
    });
    void new Response(active.output).text().catch(() => undefined);
    await entered.promise;
    const queued = f.shard.dispatch({
      workload: "echo",
      kind: "computer",
      epoch: 1,
      target: { workerId: "peer" },
    });
    const rejected = assertRejects(() => queued);
    replacement = createWorker({
      ...f.options("peer", 2),
      workloads: {
        echo: () => {
          runs++;
          return bytes("new");
        },
      },
    });
    await replacement.ready;
    await rejected;
    assertEquals(runs, 0);
    await active.completed;
  } finally {
    await old.stop();
    await replacement?.stop();
    await f.shard.close();
  }
});

Deno.test("controller never treats a proxy failure or truncated output as safe replay", async () => {
  const proxy = createShardController({
    url: "https://shard.example",
    fetch: () =>
      Promise.resolve(new Response("upstream gone", { status: 502 })),
  });
  const error = await assertRejects(() => proxy.dispatch({ workload: "echo" }));
  assertEquals((error as { started?: boolean }).started, undefined);
  const lost = createShardController({
    url: "https://shard.example",
    fetch: () =>
      Promise.resolve(new Response('{"type":"data","value":"eA=="}\n')),
  });
  const work = await lost.dispatch({ workload: "echo" });
  await assertRejects(
    () => new Response(work.output).text(),
    Error,
    "without a terminal",
  );
  await assertRejects(() => work.completed);
});

Deno.test("a remote shard relays accepted sessions and callHost to its gateway owner", async () => {
  const { createShardDispatcher, connectShardDispatcher } = await import(
    "./shard-relay.ts"
  );
  const f = fixture({
    peer: { kind: "worker", workloads: ["copilotz.delivery.v1"] },
    "shard:computer:peer": { kind: "computer", workloads: ["echo"] },
    "shard:browser:peer": {
      kind: "browser",
      actor: { namespace: "scope", id: "actor" },
      workloads: ["echo"],
    },
  });
  const database = await (await import("../testing/owner-database.ts"))
    .createOwnerTestDatabase();
  const databaseSchema = `relay_${crypto.randomUUID().replaceAll("-", "")}`;
  const actions = {
    echo: defineAction({ id: "relay.echo", execute: (input: string) => input }),
  };
  const handler = createShardControllerHandler({
    authenticate: (request) =>
      request.headers.get("authorization") === "Bearer controller",
    shard: f.shard,
    authorize: (request, input) =>
      request.headers.get("authorization") === "Bearer controller" &&
      input.kind === undefined,
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  let dispatcher!: ReturnType<typeof createShardDispatcher>;
  const gateway = await createCopilotz({
    role: "gateway",
    database,
    databaseSchema,
    namespace: "scope",
    actions,
    target: { workerId: "peer" },
    dispatcher: (binding) =>
      dispatcher = createShardDispatcher({
        binding,
        shardId: "s",
        controller: {
          url: `http://127.0.0.1:${server.addr.port}`,
          headers: () => ({ authorization: "Bearer controller" }),
        },
        transports: [{ type: "websocket", config: { path: "/shard" } }],
        admit(context) {
          if (
            context.credential.capability !== "trusted-shard"
          ) throw new Error("unauthorized shard");
          return {
            definition: {
              workerId: "s",
              providerId: "shard",
              workloads: context.workloads,
              capacity: context.capacity,
              labels: {},
              providerConfig: {},
            },
            sessionGeneration: Date.now(),
            authenticatedWith: context.credential.kind,
            resume: {
              credential: { kind: "resume", capability: "trusted-shard" },
              expiresAtMs: Date.now() + 60000,
            },
          };
        },
      }),
  });
  const ownerListener = listen({ hypervisor: dispatcher.hypervisor });
  const relay = connectShardDispatcher({
    shard: f.shard,
    worker: {
      id: "s",
      activate: () => ({ workerId: "s", attemptId: "relay", epoch: 1 }),
      transport: {
        type: "websocket",
        config: {
          url: `ws://127.0.0.1:${ownerListener.port}/shard`,
          allowInsecureLoopback: true,
        },
      },
      register: () => ({
        credential: { kind: "registration", capability: "trusted-shard" },
        expiresAtMs: Date.now() + 60000,
      }),
    },
  });
  const otherPeers = ["computer", "browser"].map((kind) =>
    createWorker({
      ...f.options("peer"),
      kind: kind as "computer" | "browser",
      workloads: { echo: () => bytes(kind) },
    })
  );
  let worker:
    | { ready: Promise<void>; close(reason?: string): Promise<void> }
    | undefined;
  try {
    await Promise.all(otherPeers.map((peer) => peer.ready));
    await relay.ready;
    worker = await createCopilotz({
      role: "worker",
      ...f.options("peer"),
      databaseSchema,
      namespace: "scope",
      actions,
    });
    await worker.ready;
    const deadline = Date.now() + 3000;
    while (
      !dispatcher.sessions.list?.().some((session) => session.phase === "ready")
    ) {
      if (Date.now() > deadline) throw new Error("session replication timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(dispatcher.sessions.list?.().map((s) => s.identity.workerId), [
      "peer",
    ]);
    assertEquals(
      await gateway.actions.echo("remote owner", { idempotencyKey: "once" }),
      "remote owner",
    );
    const disconnected = Promise.withResolvers<void>();
    const unsubscribe = dispatcher.sessions.subscribe!((session) => {
      if (session.phase === "closed") disconnected.resolve();
    });
    await relay.close();
    await disconnected.promise;
    unsubscribe();
    assertEquals(dispatcher.sessions.list?.().length, 0);
  } finally {
    for (const peer of otherPeers) await peer.stop();
    await worker?.close();
    await relay.close();
    await gateway.close();
    await dispatcher.close();
    await ownerListener.shutdown();
    await f.shard.close();
    await server.shutdown();
    await database.close();
  }
});

Deno.test("SEC3 shard authenticates before pulling a 16 MiB body and bounds authenticated streaming", async () => {
  let pulls = 0, authorized = 0;
  const handler = createShardControllerHandler({
    shard: {
      dispatch() {
        throw new Error("must not dispatch");
      },
    },
    authenticate: (request) => {
      assertEquals(request.body, null);
      return request.headers.has("authorization");
    },
    authorize() {
      authorized++;
      return true;
    },
  });
  const request = (authenticated: boolean) =>
    new Request("http://localhost/_copilotz/shard/work", {
      method: "POST",
      headers: authenticated ? { authorization: "token" } : {},
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        },
      }, { highWaterMark: 0 }),
    });
  assertEquals((await handler(request(false))).status, 403);
  assertEquals(pulls, 0);
  assertEquals(authorized, 0);
  assertEquals((await handler(request(true))).status, 503);
  assertEquals(pulls, 2, "stop reading as soon as the body limit is exceeded");
  assertEquals(authorized, 0);
});

Deno.test("SEC3 browser and computer cannot replace a worker with the same logical ID", async () => {
  const principals: Record<string, ShardPrincipal> = {
    peer: { kind: "worker", workloads: ["echo"] },
    "shard:computer:peer": { kind: "computer", workloads: ["echo"] },
    "shard:browser:peer": {
      kind: "browser",
      actor: { namespace: "scope", id: "actor" },
      workloads: ["echo"],
    },
  };
  const f = fixture(principals);
  const worker = createWorker({
    ...f.options("peer"),
    workloads: { echo: () => bytes("worker") },
  });
  const others: ReturnType<typeof createWorker>[] = [];
  try {
    await worker.ready;
    const original = f.shard.hypervisor.sessions.get("peer")!;
    for (const kind of ["computer", "browser"] as const) {
      const peer = createWorker({
        ...f.options("peer"),
        kind,
        workloads: { echo: () => bytes(kind) },
      });
      others.push(peer);
      await peer.ready;
      assertEquals(
        f.shard.hypervisor.sessions.get("peer")?.connectionId,
        original.connectionId,
      );
      const work = await f.shard.dispatch({
        workload: "echo",
        target: { workerId: "peer" },
        kind,
        ...(kind === "browser"
          ? { actor: { namespace: "scope", id: "actor" } }
          : {}),
      });
      // Browsers additionally require a bound actor on dispatch.
      await work.started;
      assertEquals(await new Response(work.output).text(), kind);
      await work.completed;
    }
    // A forged unqualified ID is rejected before the registry can replace it.
    principals.peer = { kind: "computer", workloads: ["echo"] };
    const forged = createWorker({
      ...f.options("peer"),
      kind: "worker",
      reconnectDelay: false,
      workloads: { echo: () => bytes("forged") },
    });
    void forged.closed.catch(() => undefined);
    others.push(forged);
    await assertRejects(() => forged.ready);
    assertEquals(
      f.shard.hypervisor.sessions.get("peer")?.connectionId,
      original.connectionId,
    );
    const work = await f.shard.dispatch({
      workload: "echo",
      target: { workerId: "peer" },
    });
    assertEquals(await new Response(work.output).text(), "worker");
    await work.completed;
  } finally {
    for (const other of others) await other.stop();
    await worker.stop();
    await f.shard.close();
  }
});
