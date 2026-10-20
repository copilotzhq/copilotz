import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createDeliveryExecutor } from "./executor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import type {
  DurableEvent,
  EventDelivery,
  EventStore,
} from "../events/index.ts";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Admission stage did not settle")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("owner-local held claim acknowledgement retains shared capacity through actual noncooperative handler drain", async () => {
  const claimed = Promise.withResolvers<void>(),
    acknowledge = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>(),
    drain = Promise.withResolvers<void>();
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
  let delivery = {
    databaseSchema: "test",
    id: "delivery",
    eventId: event.id,
    consumerId: "processor:test",
    settlementScopeId: "scope",
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    availableAt: event.createdAt,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  } as EventDelivery;
  let contexts = 0, executions = 0, claims = 0, probes = 0;
  const store = {
    databaseSchema: "test",
    tables: {},
    executionAuthority: () =>
      Promise.resolve({ epoch: 1, signal: new AbortController().signal }),
    getEvent: () => Promise.resolve(event),
    getDelivery: () => Promise.resolve(delivery),
    async claimDelivery(input: { localExecution?: boolean }) {
      assertEquals(input.localExecution, true);
      claims++;
      delivery = {
        ...delivery,
        status: "leased",
        attempts: claims,
      } as EventDelivery;
      claimed.resolve();
      await acknowledge.promise;
      return delivery;
    },
    failDelivery() {
      delivery = { ...delivery, status: "retry_wait" };
      return Promise.resolve(delivery);
    },
    succeedDelivery() {
      delivery = { ...delivery, status: "succeeded" };
      return Promise.resolve(delivery);
    },
    heartbeatDelivery() {
      throw new Error("Local epoch ownership must never heartbeat");
    },
  } as unknown as EventStore;
  const processor = defineProcessor({
    id: "test",
    on: [{ eventType: "test.created" }],
    async handle() {
      executions++;
      entered.resolve();
      await drain.promise;
    },
  });
  const executor = createDeliveryExecutor({
    store,
    capacity: 1,
    registry: createPluginRegistry({ processors: { test: processor } }),
    createContext(base) {
      contexts++;
      return createTestProcessorContext(base);
    },
    workloads: {
      probe: () => {
        probes++;
      },
    },
  });
  const probeWork = async () => {
    const work = await executor.dispatchWork({
      workload: "probe",
      metadata: { databaseSchema: "test", ownerEpoch: 1 },
    });
    const results = await Promise.allSettled([
      work.started,
      work.completed,
      work.metadata,
      work.output.pipeTo(new WritableStream()),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const terminal = results[1];
    if (
      terminal.status === "fulfilled" &&
      (terminal.value as { status?: string }).status !== "completed"
    ) {
      throw new Error("Probe was refused before execution");
    }
  };
  try {
    const handle = await bounded(executor.dispatchDelivery(delivery));
    void handle.started.catch(() => undefined);
    void handle.done.catch(() => undefined);
    await bounded(claimed.promise);
    assertEquals([claims, contexts, executions, probes], [1, 0, 0, 0]);
    await assertRejects(probeWork);
    assertEquals(
      (await executor.dispatchDelivery(delivery)).operationId,
      handle.operationId,
    );
    assertEquals(claims, 1);
    acknowledge.resolve();
    await bounded(entered.promise);
    assertEquals([contexts, executions], [1, 1]);
    await bounded(handle.cancel("retire while body ignores cancellation"));
    // Durable cancellation can be known while the old worker body still owns
    // the shared execution slot. A separate workload must remain inadmissible.
    await assertRejects(probeWork);
    assertEquals([probes, claims, executions], [0, 1, 1]);
    drain.resolve();
    await bounded((async () => {
      for (;;) {
        try {
          await probeWork();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    })());
    assertEquals(probes, 1);
  } finally {
    acknowledge.resolve();
    drain.resolve();
    await bounded(executor.shutdown());
  }
});

Deno.test("execution registration captures routing and callbacks before held authority while direct targets stay explicit", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
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
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    availableAt: event.createdAt,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  } satisfies EventDelivery;
  const routed: string[] = [];
  let diagnostics = 0;
  const store = {
    databaseSchema: "test",
    getEvent: () => Promise.resolve(event),
    getDelivery: () => Promise.resolve(delivery),
    async executionAuthority() {
      entered.resolve();
      await release.promise;
      return { epoch: 1, signal: new AbortController().signal };
    },
  } as unknown as EventStore;
  const options = {
    store,
    registry: createPluginRegistry(),
    createContext: createTestProcessorContext,
    target: { workerId: "original" },
    workloadTargets: { probe: { workerId: "special" } },
    onDiagnostic: () => {
      diagnostics++;
    },
    dispatcher: {
      dispatch(input: import("./types.ts").ExecutionWorkInput) {
        routed.push(input.target!.workerId);
        return Promise.resolve({
          operationId: crypto.randomUUID(),
          streamId: crypto.randomUUID(),
          started: Promise.resolve(),
          metadata: Promise.resolve({}),
          completed: Promise.resolve({
            operationId: "test",
            workload: input.workload,
            metadata: {},
            status: "completed" as const,
            deliveryCount: 0,
            openedAtMs: 0,
            updatedAtMs: 0,
          }),
          output: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          cancel: () => Promise.reject(new Error("not needed")),
        });
      },
    },
  };
  const executor = createDeliveryExecutor(options);
  try {
    const first = executor.dispatchDelivery(delivery);
    await bounded(entered.promise);
    options.target.workerId = "changed";
    options.workloadTargets.probe.workerId = "changed-special";
    options.onDiagnostic = () => {
      throw new Error("changed callback");
    };
    release.resolve();
    await bounded((await first).done);
    for (
      const input of [{ workload: "probe" }, {
        workload: "probe",
        target: { workerId: "explicit" },
      }]
    ) {
      const work = await executor.dispatchWork(input);
      await Promise.all([
        work.started,
        work.completed,
        work.metadata,
        work.output.pipeTo(new WritableStream()),
      ]);
    }
    assertEquals(routed, ["original", "special", "explicit"]);
    assert(diagnostics > 0);
    assertThrows(
      () => createDeliveryExecutor({ ...options, target: { workerId: "" } }),
      TypeError,
    );
  } finally {
    release.resolve();
    await bounded(executor.shutdown());
  }
});
