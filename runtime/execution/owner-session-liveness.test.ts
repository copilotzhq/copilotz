import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createHypervisor,
  type WorkerCallContext,
} from "../../dependencies/oxian-hypervisor.ts";
import {
  createCopilotzGateway,
  type CreateCopilotzGatewayOptions,
} from "../application/gateway.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  captureOwnerSessionAuthority,
  createOwnerCapabilityHost,
} from "./owner-capabilities.ts";
import {
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "./owner-capability-wire.ts";

// The pinned Hypervisor's optional subscribe declaration needs no cast or wrapper.
const realDispatcher = ((
  { workerCalls, lifecycle }: Parameters<
    NonNullable<CreateCopilotzGatewayOptions["dispatcher"]>
  >[0],
) =>
  createHypervisor({
    transports: [{
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    }],
    workerCalls,
  }, lifecycle)) satisfies NonNullable<
    CreateCopilotzGatewayOptions["dispatcher"]
  >;

function fixture(unsubscribeFailure = false) {
  let now = 1000;
  const hypervisor = createHypervisor({
    transports: [{
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    }],
    clock: () => now,
  });
  const sessions = hypervisor.sessions;
  const fence = sessions.attach({
    identity: { workerId: "remote", attemptId: "worker-attempt", epoch: 1 },
    connectionId: "connection",
    sessionGeneration: 1,
    transportType: "websocket",
    workloads: ["test"],
    capacity: 256,
    leaseTimeoutMs: 1000,
  }).session;
  sessions.markReady(fence);
  const calls: string[][] = [], writes: string[][] = [], revoked: string[] = [];
  const controls = new Map<string, AbortController>();
  let beforeFence: (() => Promise<void>) | undefined;
  let failure: Error | undefined;
  let admitAttempt = (_attempt: { id: string; owner: string }) => true;
  const store = {
    async heartbeatDeliveries(
      attempts:
        readonly import("../events/store.ts").DeliveryAttemptHeartbeat[],
      accept?: (
        attempt: import("../events/store.ts").DeliveryAttemptHeartbeat,
        epoch: number,
      ) => boolean,
    ) {
      calls.push(attempts.map((a) => a.id));
      await beforeFence?.();
      if (failure) throw failure;
      const renewed = attempts.filter((a) =>
        (!accept || accept(a, 1)) && admitAttempt(a)
      ).map(({ id, owner }) => ({
        id,
        owner,
      }));
      if (renewed.length) writes.push(renewed.map((a) => a.id));
      return renewed;
    },
  };
  let subscriptions = 0;
  const host = createOwnerCapabilityHost({
    sessions: {
      assertCurrent: sessions.assertCurrent,
      subscribe(listener) {
        subscriptions++;
        const unsubscribe = sessions.subscribe!(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          unsubscribe();
          subscriptions--;
          if (unsubscribeFailure) throw new Error("unsubscribe failure");
        };
      },
    },
    registry: createPluginRegistry({}),
    resolveAuthority: () =>
      Promise.resolve({ epoch: 1, signal: new AbortController().signal }),
    createWorkloads: ({ trackAttempt }) => ({
      test: async (work) => {
        const id = String(work.metadata.id);
        const control = new AbortController();
        controls.set(id, control);
        const signal = AbortSignal.any([work.signal, control.signal]);
        const remove = trackAttempt!({
          store,
          heartbeat: {
            id: String(work.metadata.deliveryId),
            owner: `attempt-${id}`,
            ownerEpoch: 1,
            namespace: "space",
            eventId: `event-${id}`,
            operationId: `operation-${id}`,
            leaseMs: 1000,
          },
          signal,
          revoke(reason) {
            revoked.push(id);
            control.abort(reason);
          },
        });
        try {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
          return {};
        } finally {
          remove();
        }
      },
    }),
  });
  const open = async (id: string, current = fence, deliveryId = id) => {
    const binding = {
      workload: OWNER_CAPABILITY_WORKLOAD,
      fence: current,
      parent: {
        streamId: id,
        operationId: id,
        workload: "test",
        metadata: { id, deliveryId, databaseSchema: "public", ownerEpoch: 1 },
      },
      signal: new AbortController().signal,
    } as unknown as WorkerCallContext;
    const handler = await host.workerCalls.admit(binding);
    assert(handler);
    const result = await handler({
      signal: binding.signal,
      input: new ReadableStream({
        start(c) {
          c.enqueue(
            encodeCapability({ kind: "open", value: new Uint8Array() }),
          );
          c.close();
        },
      }),
    } as never) as Uint8Array;
    const response = await readCapability(
      new ReadableStream({
        start(c) {
          c.enqueue(result);
          c.close();
        },
      }),
    ) as { error?: Error };
    if (response.error) throw response.error;
    assert(controls.has(id));
  };
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  return {
    host,
    subscriptions: () => subscriptions,
    sessions,
    fence,
    calls,
    writes,
    revoked,
    controls,
    open,
    flush,
    time(value: number) {
      now = value;
    },
    before(callback: () => Promise<void>) {
      beforeFence = callback;
    },
    admitAttempt(admit: typeof admitAttempt) {
      admitAttempt = admit;
    },
    fail(error: Error) {
      failure = error;
    },
    beat(current = fence) {
      sessions.heartbeat(current, {
        sequence: sessions.assertCurrent(current).nextHeartbeatSequence,
      });
    },
    async close() {
      await host.close();
      await hypervisor.shutdown();
    },
  };
}

Deno.test("remote startup requires the actual accepted session subscriber; real Hypervisors typecheck", async () => {
  const hypervisor = realDispatcher({
    workerCalls: { admit: () => undefined },
    lifecycle: {},
  });
  const actual = await hypervisor;
  assert(captureOwnerSessionAuthority(actual.sessions));
  assertThrows(
    () =>
      captureOwnerSessionAuthority({
        assertCurrent: actual.sessions.assertCurrent,
      }),
    TypeError,
    "accepted session authority",
  );
  await actual.shutdown();
  await assertRejects(
    () =>
      createCopilotzGateway({
        database: { url: ":memory:" },
        dispatcher: () => ({
          dispatch: () => Promise.reject(new Error("must not dispatch")),
          sessions: { assertCurrent: actual.sessions.assertCurrent },
        }),
      }),
    TypeError,
    "accepted session authority",
  );
});

Deno.test("only accepted exact heartbeat sequences produce coalesced renewal", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 256; i++) await f.open(String(i));
    f.sessions.reserve({ workload: "test" });
    f.sessions.release(f.fence);
    assertThrows(() => f.sessions.heartbeat(f.fence, { sequence: 2 }));
    await f.flush();
    assertEquals(f.calls, []);
    for (let i = 0; i < 100; i++) f.beat();
    await f.flush();
    assertEquals(f.calls.length, 1);
    assertEquals(f.calls[0].length, 256);
    assertEquals(f.writes, f.calls);
    assertEquals(f.revoked, []);
    assertThrows(() => f.sessions.heartbeat(f.fence, { sequence: 99 }));
    await f.flush();
    assertEquals(f.calls.length, 1);
    await f.host.close();
    f.beat();
    await f.flush();
    assertEquals(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test("accepted evidence is revalidated after a blocked fence and stale members do not retire current work", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.before(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await f.open("cancelled");
    await f.open("current");
    f.beat();
    await entered.promise;
    f.controls.get("cancelled")!.abort(new Error("cancelled before renewal"));
    release.resolve();
    await f.flush();
    assertEquals(f.calls, [["cancelled", "current"]]);
    assertEquals(f.writes, [["current"]]);
    assertEquals(f.revoked, ["cancelled"]);
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test("expired and replaced accepted sessions cannot renew old attempts", async (t) => {
  for (const change of ["expiry", "replacement"] as const) {
    await t.step(change, async () => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      f.before(async () => {
        entered.resolve();
        await release.promise;
      });
      try {
        await f.open("old");
        f.beat();
        await entered.promise;
        if (change === "expiry") {
          f.time(2000);
        } else {
          const replacement = f.sessions.attach({
            identity: {
              ...f.fence.identity,
              attemptId: "replacement",
              epoch: 2,
            },
            connectionId: "replacement",
            sessionGeneration: 2,
            transportType: "websocket",
            workloads: ["test"],
            capacity: 256,
            leaseTimeoutMs: 1000,
          }).session;
          f.sessions.markReady(replacement);
          await f.open("new", replacement);
          f.beat(replacement);
        }
        release.resolve();
        await f.flush();
        assertEquals(f.revoked, ["old"]);
        assertEquals(f.writes, change === "replacement" ? [["new"]] : []);
      } finally {
        release.resolve();
        await f.close();
      }
    });
  }
});

Deno.test("heartbeat command uncertainty revokes attempts without successful renewal", async () => {
  const f = await fixture();
  try {
    await f.open("uncertain");
    f.fail(new Error("unknown commit"));
    f.beat();
    await f.flush();
    assertEquals(f.writes, []);
    assertEquals(f.revoked, ["uncertain"]);
    f.beat();
    await f.flush();
    assertEquals(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test("subscription and owner-attempt cleanup survive observer and unsubscribe failures", async () => {
  const f = await fixture(true);
  const off = f.sessions.subscribe!(() => {
    throw new Error("unrelated observer");
  });
  try {
    await f.open("aborted");
    f.beat();
    await f.flush();
    assertEquals(f.writes, [["aborted"]]);
    f.controls.get("aborted")!.abort(new Error("owner stopped"));
    f.beat();
    await f.flush();
    assertEquals(f.calls.length, 1);
    assertEquals(f.subscriptions(), 1);
    await assertRejects(() => f.host.close(), Error, "unsubscribe failure");
    assertEquals(f.subscriptions(), 0);

    f.beat();
    await f.flush();
    assertEquals(f.calls.length, 1);
  } finally {
    off();
    await f.close();
  }
});

Deno.test("a mixed batch renews healthy members in one command", async () => {
  const f = await fixture();
  let entered = 0;
  f.before(() => {
    entered++;
    f.controls.get(entered === 1 ? "first" : "second")!.abort(
      new Error("retired"),
    );
    return Promise.resolve();
  });
  try {
    await f.open("first");
    await f.open("second");
    await f.open("last");
    f.beat();
    await f.flush();
    assertEquals(f.calls, [["first", "second", "last"]]);
    assertEquals(f.writes, [["second", "last"]]);
    assertEquals(f.revoked, ["first"]);
  } finally {
    await f.close();
  }
});

Deno.test("accepted pulses during a blocked command coalesce into one following batch", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.before(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await f.open("blocked-work");
    f.beat();
    await entered.promise;
    for (let i = 0; i < 100; i++) f.beat();
    assertEquals(f.calls, [["blocked-work"]]);
    release.resolve();
    await f.flush();
    assertEquals(f.writes, [["blocked-work"], ["blocked-work"]]);
    assertEquals(f.revoked, []);
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test("a replacement renewal for the same delivery never authenticates its old attempt", async () => {
  const f = fixture();
  try {
    await f.open("old", f.fence, "same-delivery");
    await f.open("new", f.fence, "same-delivery");
    f.admitAttempt(({ owner }) => owner === "attempt-new");
    f.beat();
    await f.flush();
    assertEquals(f.calls, [["same-delivery", "same-delivery"]]);
    assertEquals(f.writes, [["same-delivery"]]);
    assertEquals(f.revoked, ["old"]);
    assertEquals(f.controls.get("new")!.signal.aborted, false);
    f.beat();
    await f.flush();
    assertEquals(f.calls[1], ["same-delivery"]);
    assertEquals(f.revoked, ["old"]);
  } finally {
    await f.close();
  }
});
