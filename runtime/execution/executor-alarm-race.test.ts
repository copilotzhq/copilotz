import { assertEquals, assertRejects } from "@std/assert";
import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import type {
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createDeliveryExecutor } from "./executor.ts";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Consumed alarm wake was lost.")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (
  const phase of [
    "dispatching",
    "active",
    "rejected placement",
    "scheduled placement",
  ] as const
) {
  Deno.test(`consumed retry alarm arriving during ${phase} survives the previous attempt completion`, async () => {
    const event = {
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
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies DurableEvent;
    const delivery = {
      databaseSchema: "test",
      id: "delivery",
      eventId: event.id,
      consumerId: "processor:test",
      settlementScopeId: "scope",
      status: "retry_wait",
      attempts: 1,
      maxAttempts: 3,
      availableAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    } satisfies EventDelivery;
    const terminal = (index: number) => ({
      operationId: `operation:${index}`,
      workload: "copilotz.delivery.v1",
      metadata: {},
      status: "completed" as const,
      deliveryCount: 0,
      openedAtMs: 0,
      updatedAtMs: 0,
    });
    const firstDispatched = Promise.withResolvers<void>(),
      secondDispatched = Promise.withResolvers<void>(),
      allowFirstDispatch = Promise.withResolvers<void>();
    const completed = [
      Promise.withResolvers<ReturnType<typeof terminal>>(),
      Promise.withResolvers<ReturnType<typeof terminal>>(),
    ];
    let dispatches = 0;
    const store = {
      databaseSchema: "test",
      executionAuthority: () =>
        Promise.resolve({ epoch: 1, signal: new AbortController().signal }),
      getEvent: () => Promise.resolve(event),
      getDelivery: () => Promise.resolve(delivery),
    } as unknown as EventStore;
    const executor = createDeliveryExecutor({
      store,
      registry: createPluginRegistry(),
      createContext() {
        throw new Error("No workload executes in this pure scheduling test.");
      },
      dispatcher: {
        async dispatch() {
          const index = dispatches++;
          if (index === 0) {
            firstDispatched.resolve();
            await allowFirstDispatch.promise;
            if (phase === "rejected placement") {
              throw new Error("placement rejected");
            }
          } else secondDispatched.resolve();
          return {
            operationId: `operation:${index}`,
            streamId: `stream:${index}`,
            metadata: Promise.resolve({}),
            output: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            started: Promise.resolve(),
            completed: completed[index].promise,
            cancel() {
              completed[index].resolve(terminal(index));
              return Promise.resolve(terminal(index));
            },
          } satisfies WorkHandle;
        },
      },
    });
    try {
      const first = phase === "scheduled placement"
        ? (executor.scheduleDelivery(delivery), Promise.resolve(undefined))
        : executor.dispatchDelivery(delivery);
      void first.catch(() => undefined);
      await firstDispatched.promise;
      if (phase === "active") {
        allowFirstDispatch.resolve();
        await first;
      }
      // The durable alarm has already been consumed. No polling timer or future
      // deadline exists to rescue this wake once scheduleDelivery accepts it.
      executor.scheduleDelivery(delivery);
      executor.scheduleDelivery(delivery);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(dispatches, 1);
      allowFirstDispatch.resolve();
      if (phase === "rejected placement") {
        await assertRejects(() => first, Error, "placement rejected");
      } else {
        const handle = await first;
        completed[0].resolve(terminal(0));
        await handle?.done;
      }
      await bounded(secondDispatched.promise);
      assertEquals(dispatches, 2);
    } finally {
      allowFirstDispatch.resolve();
      completed.forEach((value, index) => value.resolve(terminal(index)));
      await executor.shutdown();
    }
  });
}
