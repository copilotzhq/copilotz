import { assertEquals, assertRejects } from "@std/assert";
import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import type {
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createDeliveryExecutor } from "./executor.ts";
import type { CreateDeliveryExecutorOptions } from "./types.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const event: DurableEvent = {
  durable: true,
  id: "event",
  position: "1",
  seq: "1",
  schemaVersion: 1,
  type: "test.created",
  namespace: "test",
  payload: {},
  metadata: {},
  correlationId: "correlation",
  createdAt: timestamp,
};
const delivery = {
  databaseSchema: "test",
  id: "delivery",
  eventId: event.id,
  consumerId: "processor:test",
  settlementScopeId: "scope",
  status: "succeeded",
  attempts: 1,
  maxAttempts: 1,
  availableAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  settledAt: timestamp,
} as const satisfies EventDelivery;
const terminal = {
  operationId: "operation",
  workload: "copilotz.delivery.v1",
  metadata: {},
  status: "completed" as const,
  deliveryCount: 0,
  openedAtMs: 0,
  updatedAtMs: 0,
};

// The actual executor runs with an injected dispatcher and a data-only store.
// No database, worker, Hypervisor, network, subprocess or filesystem is opened.
function fixture(options: {
  resolveStore?: () => Promise<void>;
  getDelivery?: () => Promise<void>;
  dispatch?: () => Promise<void>;
  recoverExpiredDeliveries?: () => Promise<void>;
  completed?: WorkHandle["completed"];
  cancel?: WorkHandle["cancel"];
  onDeliverySettled?: CreateDeliveryExecutorOptions["onDeliverySettled"];
} = {}) {
  const calls: string[] = [];
  const store = {
    databaseSchema: "test",
    executionAuthority() {
      return Promise.resolve({
        epoch: "1",
        signal: new AbortController().signal,
      });
    },
    getEvent() {
      calls.push("getEvent");
      return Promise.resolve(event);
    },
    async getDelivery() {
      calls.push("getDelivery");
      await options.getDelivery?.();
      return delivery;
    },
    listDeliveries() {
      calls.push("listDeliveries");
      return Promise.resolve([delivery]);
    },
    async recoverExpiredDeliveries() {
      calls.push("recoverExpiredDeliveries");
      await options.recoverExpiredDeliveries?.();
      return [];
    },
    listRecoverable() {
      calls.push("listRecoverable");
      return Promise.resolve([]);
    },
  } as unknown as EventStore;
  const executor = createDeliveryExecutor({
    defaultDatabaseSchema: "test",
    async resolveStore() {
      calls.push("resolveStore");
      await options.resolveStore?.();
      return store;
    },
    registry: createPluginRegistry({ plugins: [] }),
    createContext() {
      throw new Error("The fake dispatcher must never execute a workload.");
    },
    dispatcher: {
      async dispatch() {
        calls.push("dispatch");
        await options.dispatch?.();
        return {
          operationId: terminal.operationId,
          streamId: "stream",
          metadata: Promise.resolve({
            schema: "copilotz.delivery.result.v1",
            deliveryId: delivery.id,
            delivery,
          }),
          output: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          started: Promise.resolve(),
          completed: options.completed ?? Promise.resolve(terminal),
          cancel: options.cancel ?? (() => Promise.resolve(terminal)),
        } satisfies WorkHandle;
      },
    },
    onDeliverySettled: options.onDeliverySettled,
  });
  return { executor, calls };
}

function observe(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(() => settled = true, () => settled = true);
  return () => settled;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

Deno.test("shutdown drains settlement callbacks before store teardown without extending handle.done", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const f = fixture({
    async onDeliverySettled() {
      // Reconciliation can drain handle.done; joining this callback to that
      // promise would recreate the settlement cycle.
      await f.executor.settleOutputs({
        namespace: event.namespace,
        settlementScopeId: delivery.settlementScopeId,
      });
      entered.resolve();
      await release.promise;
      order.push("settlement read");
    },
  });
  const handle = await f.executor.dispatchDelivery(delivery);
  await entered.promise;
  assertEquals((await handle.done).delivery, delivery);
  const shutdown = f.executor.shutdown().then(() =>
    order.push("store teardown")
  );
  const returned = observe(shutdown);
  try {
    await nextTurn();
    assertEquals(returned(), false);
  } finally {
    release.resolve();
    await shutdown;
  }
  assertEquals(order, ["settlement read", "store teardown"]);
});

Deno.test("concurrent shutdown callers share the settlement drain", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({
    async onDeliverySettled() {
      entered.resolve();
      await release.promise;
    },
  });
  await f.executor.dispatchDelivery(delivery);
  await entered.promise;
  const first = f.executor.shutdown();
  const second = f.executor.shutdown();
  const returned = [observe(first), observe(second)];
  try {
    await nextTurn();
    assertEquals(returned.map((value) => value()), [false, false]);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
});

Deno.test("shutdown drains a rejected settlement callback without leaking its rejection", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({
    async onDeliverySettled() {
      entered.resolve();
      await release.promise;
      throw new Error("settlement failed");
    },
  });
  const handle = await f.executor.dispatchDelivery(delivery);
  await entered.promise;
  const shutdown = f.executor.shutdown();
  const returned = observe(shutdown);
  try {
    await nextTurn();
    assertEquals(returned(), false);
  } finally {
    release.resolve();
    await shutdown;
  }
  assertEquals((await handle.done).delivery, delivery);
  await nextTurn();
});

for (const boundary of ["resolveStore", "getDelivery", "dispatch"] as const) {
  Deno.test(`shutdown includes a late callback from dispatch held at ${boundary}`, async () => {
    const admitted = Promise.withResolvers<void>();
    const releaseDispatch = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const releaseCallback = Promise.withResolvers<void>();
    const f = fixture({
      async [boundary]() {
        admitted.resolve();
        await releaseDispatch.promise;
      },
      async onDeliverySettled() {
        entered.resolve();
        await releaseCallback.promise;
      },
    });
    const dispatch = f.executor.dispatchDelivery(delivery.id);
    await admitted.promise;
    const shutdown = f.executor.shutdown();
    const returned = observe(shutdown);
    try {
      await nextTurn();
      assertEquals(
        returned(),
        false,
        "admitted store/placement work is still held",
      );
      releaseDispatch.resolve();
      await dispatch;
      await entered.promise;
      await nextTurn();
      assertEquals(returned(), false, "late settlement callback is still held");
    } finally {
      releaseDispatch.resolve();
      releaseCallback.resolve();
      const handle = await dispatch;
      await handle.done;
      await shutdown;
      // Also wait for the deliberately detached callback on the red baseline.
      await entered.promise;
    }
  });
}

Deno.test("shutdown still drains settlement when cancellation rejects", async () => {
  const completed = Promise.withResolvers<typeof terminal>();
  const cancelled = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({
    completed: completed.promise,
    cancel() {
      cancelled.resolve();
      return Promise.reject(new Error("cancel failed"));
    },
    async onDeliverySettled() {
      entered.resolve();
      await release.promise;
    },
  });
  const handle = await f.executor.dispatchDelivery(delivery);
  const shutdown = f.executor.shutdown();
  const returned = observe(shutdown);
  try {
    await cancelled.promise;
    await nextTurn();
    assertEquals(returned(), false, "delivery completion is still held");
    completed.resolve(terminal);
    await entered.promise;
    await nextTurn();
    assertEquals(returned(), false, "settlement callback is still held");
  } finally {
    completed.resolve(terminal);
    release.resolve();
    await handle.done;
    await entered.promise;
    await shutdown;
  }
});

Deno.test("shutdown includes admitted recovery reads and rejects recovery after closure", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({
    async recoverExpiredDeliveries() {
      entered.resolve();
      await release.promise;
    },
  });
  const recovery = f.executor.dispatchRecoverable();
  await entered.promise;
  const shutdown = f.executor.shutdown();
  const returned = observe(shutdown);
  try {
    await nextTurn();
    assertEquals(returned(), false);
  } finally {
    release.resolve();
    await recovery;
    await shutdown;
  }
  const before = [...f.calls];
  await assertRejects(
    () => f.executor.dispatchRecoverable(),
    Error,
    "shut down",
  );
  assertEquals(
    f.calls,
    before,
    "closed recovery must not start any store read",
  );
});

Deno.test("shutdown drains rejected admitted calls without running settlement callbacks", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let settlements = 0;
  const f = fixture({
    async dispatch() {
      entered.resolve();
      await release.promise;
      throw new Error("placement failed");
    },
    onDeliverySettled() {
      settlements++;
    },
  });
  const dispatch = f.executor.dispatchDelivery(delivery);
  const rejected = assertRejects(() => dispatch, Error, "placement failed");
  await entered.promise;
  const shutdown = f.executor.shutdown();
  const returned = observe(shutdown);
  try {
    await nextTurn();
    assertEquals(returned(), false);
  } finally {
    release.resolve();
    await rejected;
    await shutdown;
  }
  assertEquals(settlements, 0);
  await nextTurn();
});
