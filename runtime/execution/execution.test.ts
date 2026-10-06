import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
  createEventStore,
  createSqlSession,
  type EventStore,
} from "../events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  markNonRetryable,
  type PluginRegistry,
  type Processor,
} from "../plugins/index.ts";
import {
  createDeliveryExecutor,
  createDeliveryWorkload,
  type DeliveryContextFactory,
  type DeliveryDispatcher,
} from "./index.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import { summarizeDeliveryError } from "./diagnostics.ts";
type Fixture = Readonly<{
  db: TestDatabase;
  store: EventStore;
  registry: PluginRegistry;
  createContext: DeliveryContextFactory;
  calls: Array<
    Readonly<{
      eventId: string;
      idempotencyKey: string;
      mutationIdentity: Readonly<{
        causationId: string;
        correlationId: string;
        deduplicationId: string;
        settlementScopeId: string;
        metadata: Readonly<Record<string, unknown>>;
      }>;
    }>
  >;
}>;
async function createFixture(options?: {
  handle?: (eventId: string, idempotencyKey: string) => void | Promise<void>;
  onError?: Processor["onError"];
}): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_execution";
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({
    session,
    schema,
    random: () => 0,
  });
  const calls: Fixture["calls"] = [];
  const processor = defineProcessor({
    id: "messages.observe",
    on: [{ eventType: "message.created" }],
    ...(options?.onError ? { onError: options.onError } : {}),
    async handle(event, context) {
      if (!event.durable) {
        throw new Error("Expected a durable event.");
      }
      assertEquals(
        [
          "event",
          "delivery",
          "settlementScopeId",
          "idempotencyKey",
          "dispatchAttemptId",
          "createMutationIdentity",
        ].filter((key) => Object.hasOwn(context, key)),
        [],
      );
      assertEquals(context.databaseSchema, schema);
      const idempotencyKey = context.operationKey;
      await options?.handle?.(event.id, idempotencyKey);
    },
  });
  const createContext: DeliveryContextFactory = (base) => {
    const mutationIdentity = base.createMutationIdentity("effect", {
      custom: "value",
    });

    calls.push(Object.freeze({
      eventId: base.event.id,
      idempotencyKey: base.idempotencyKey,
      mutationIdentity,
    }));
    return createTestProcessorContext(base);
  };
  const plugin = definePlugin({
    id: "test.execution",
    version: "1.0.0",
    processors: { observer: processor },
  });
  const registry = await createPluginRegistry({ plugins: [plugin] });
  return Object.freeze({ db, store, registry, createContext, calls });
}
async function appendMessage(fixture: Fixture) {
  const draft = {
    type: "message.created",
    namespace: "tenant-a",
    threadId: "thread-a",
    payload: { content: "hello" },
  } as const;
  return await fixture.store.append(
    draft,
    fixture.registry.durableConsumers(draft).map((item) => item.consumerId),
  );
}
async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.db.close();
}
async function waitForDeliveryStatus(
  store: EventStore,
  id: string,
  status: "succeeded" | "dead_letter",
): Promise<NonNullable<Awaited<ReturnType<EventStore["getDelivery"]>>>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const delivery = await store.getDelivery(id);
    if (delivery?.status === status) {
      return delivery;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Delivery '${id}' did not reach '${status}'.`);
}
async function waitForScheduledCallback(
  callbacks: readonly (() => void)[],
): Promise<() => void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const callback = callbacks.at(-1);
    if (callback) {
      return callback;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Expected a delivery recovery callback to be scheduled.");
}
Deno.test("A24 private in-process Oxian recovers and executes a durable delivery", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-private-test",
  });
  try {
    assertEquals(executor.ownership, "private_hypervisor");
    const recovery = await executor.dispatchRecoverable({
      namespace: "tenant-a",
    });
    assertEquals(recovery.failures, []);
    assertEquals(recovery.handles.length, 1);
    const handle = recovery.handles[0];
    await handle.started;
    const result = await handle.done;
    assertEquals(result.operationStatus, "completed");
    assertEquals(result.delivery.status, "succeeded");
    assertEquals(result.delivery.attempts, 1);
    assertEquals(fixture.calls, [{
      eventId: committed.event.id,
      idempotencyKey: committed.deliveries[0].id,
      mutationIdentity: {
        causationId: committed.event.id,
        correlationId: committed.event.correlationId,
        deduplicationId: `delivery:${committed.deliveries[0].id}:effect`,
        settlementScopeId: committed.event.id,
        metadata: {
          custom: "value",
          sourceEventId: committed.event.id,
          sourceDeliveryId: committed.deliveries[0].id,
          sourceConsumerId: committed.deliveries[0].consumerId,
        },
      },
    }]);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("a settled delivery reports its row, so success is not read back", async () => {
  const failing = { current: false };
  const fixture = await createFixture({
    handle: () => {
      if (failing.current) throw new Error("boom");
    },
  });
  let reads = 0;
  const store: EventStore = {
    ...fixture.store,
    getDelivery: (id) => {
      reads++;
      return fixture.store.getDelivery(id);
    },
  };
  const executor = createDeliveryExecutor({
    store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-settled-row-test",
  });
  try {
    await appendMessage(fixture);
    const [handle] = (await executor.dispatchRecoverable({
      namespace: "tenant-a",
    })).handles;
    const result = await handle.done;
    assertEquals(result.delivery.status, "succeeded");
    assertEquals(reads, 0, "success reports its own row");
    // The reported row is what the database holds.
    assertEquals(
      result.delivery,
      await fixture.store.getDelivery(handle.deliveryId),
    );

    // A failed run has no settled row to report, so it is read back.
    failing.current = true;
    await appendMessage(fixture);
    reads = 0;
    const [failed] = (await executor.dispatchRecoverable({
      namespace: "tenant-a",
    })).handles;
    assertEquals((await failed.done).delivery.status, "retry_wait");
    assert(reads > 0);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("recovery owner automatically reclaims a lease that expires after its first sweep", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const delivery = committed.deliveries[0];
  const callbacks: Array<() => void> = [];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-expired-lease-recovery-test",
    continuousRecovery: true,
    scheduler: {
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      cancel() {},
    },
  });
  try {
    assertExists(
      await fixture.store.claimDelivery({
        id: delivery.id,
        owner: "crashed",
        leaseMs: 60000,
      }),
    );
    const initial = await executor.dispatchRecoverable();
    assertEquals(initial.handles, []);
    const recoverExpiredLease = await waitForScheduledCallback(callbacks);
    const tables = createCoreTableNames("copilotz_execution");
    await fixture.db.query(
      `UPDATE ${tables.event_deliveries}
       SET lease_expires_at = NOW() - INTERVAL '1 millisecond'
       WHERE id = $1`,
      [delivery.id],
    );
    // The timer is the only second recovery trigger: no caller invokes
    // dispatchRecoverable again after the lease becomes expired.
    recoverExpiredLease();
    const settled = await waitForDeliveryStatus(
      fixture.store,
      delivery.id,
      "succeeded",
    );
    assertEquals(settled.attempts, 2);
    assertEquals(fixture.calls.length, 1);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("a filtered recovery cannot activate a cross-tenant continuous sweep", async () => {
  const fixture = await createFixture();
  const consumer = "processor:messages.observe";
  const tenantA = await fixture.store.append({
    type: "message.created",
    namespace: "tenant-a",
    payload: { content: "tenant A" },
    metadata: {
      core: {
        threadId: "thread-a",
      },
    },
  }, [consumer]);
  const tenantB = await fixture.store.append({
    type: "message.created",
    namespace: "tenant-b",
    payload: { content: "tenant B" },
    metadata: {
      core: {
        threadId: "thread-b",
      },
    },
  }, [consumer]);
  const deliveryA = tenantA.deliveries[0];
  const deliveryB = tenantB.deliveries[0];
  const callbacks: Array<() => void> = [];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-filtered-recovery-test",
    continuousRecovery: true,
    scheduler: {
      schedule(callback) {
        callbacks.push(callback);
        return callback;
      },
      cancel() {},
    },
  });
  try {
    for (const delivery of [deliveryA, deliveryB]) {
      assertExists(
        await fixture.store.claimDelivery({
          id: delivery.id,
          owner: "crashed",
          leaseMs: 60000,
        }),
      );
    }
    const recovered = await executor.dispatchRecoverable({
      namespace: "tenant-a",
    });
    assertEquals(recovered.handles, []);
    // Filtered recovery is an ordinary targeted operation, not a Gateway
    // recovery-owner activation. It therefore cannot later sweep tenant B.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(callbacks, []);
    assertEquals((await fixture.store.getDelivery(deliveryA.id))?.attempts, 1);
    assertEquals((await fixture.store.getDelivery(deliveryB.id))?.attempts, 1);
    assertEquals(
      (await fixture.store.getDelivery(deliveryB.id))?.status,
      "leased",
    );
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("delivery failures retry through the same logical consumer and stable key", async () => {
  let attempt = 0;
  const fixture = await createFixture({
    handle() {
      attempt++;
      if (attempt === 1) {
        throw new Error("synthetic first failure");
      }
    },
  });
  const committed = await appendMessage(fixture);
  const delivery = committed.deliveries[0];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-retry-test",
  });
  try {
    const first = await executor.dispatchDelivery(delivery);
    assertEquals((await first.done).delivery.status, "retry_wait");
    const settled = await waitForDeliveryStatus(
      fixture.store,
      delivery.id,
      "succeeded",
    );
    assertEquals(settled.status, "succeeded");
    assertEquals(settled.attempts, 2);
    assertEquals(fixture.calls.length, 2);
    assertEquals(
      new Set(fixture.calls.map((call) => call.idempotencyKey)),
      new Set([delivery.id]),
    );
    assertEquals(
      new Set(
        fixture.calls.map((call) => call.mutationIdentity.deduplicationId),
      ),
      new Set([`delivery:${delivery.id}:effect`]),
    );
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("retryable failures automatically exhaust into a dead letter", async () => {
  let calls = 0;
  const fixture = await createFixture({
    handle() {
      calls += 1;
      throw new Error("persistent transient failure");
    },
  });
  const committed = await appendMessage(fixture);
  const delivery = committed.deliveries[0];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-retry-exhaustion-test",
  });
  try {
    const first = await executor.dispatchDelivery(delivery);
    assertEquals((await first.done).delivery.status, "retry_wait");
    const terminal = await waitForDeliveryStatus(
      fixture.store,
      delivery.id,
      "dead_letter",
    );
    assertEquals(terminal.attempts, terminal.maxAttempts);
    assertEquals(calls, terminal.maxAttempts);
    assertEquals(terminal.lastError?.retryable, true);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("marked non-retryable Processor errors dead-letter immediately", async () => {
  let calls = 0;
  const fixture = await createFixture({
    handle() {
      calls += 1;
      throw markNonRetryable(new TypeError("invalid processor configuration"));
    },
  });
  const committed = await appendMessage(fixture);
  const delivery = committed.deliveries[0];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-non-retryable-test",
  });
  try {
    const handle = await executor.dispatchDelivery(delivery);
    const terminal = await handle.done;
    assertEquals(terminal.delivery.status, "dead_letter");
    assertEquals(terminal.delivery.attempts, 1);
    assertEquals(terminal.delivery.lastError?.retryable, false);
    assertEquals(calls, 1);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});

for (
  const disposition of [
    "handled",
    "declined",
    "rejected",
    "non-retryable",
  ] as const
) {
  Deno.test(`terminal Processor error recovery: ${disposition}`, async () => {
    let attempts = 0, recoveries = 0;
    const error = new TypeError("persistent preparation failure");
    const fixture = await createFixture({
      handle() {
        attempts++;
        throw disposition === "non-retryable" ? markNonRetryable(error) : error;
      },
      onError(cause, event, context) {
        recoveries++;
        assertEquals(cause, error);
        assertEquals(event.namespace, "tenant-a");
        assertEquals(context.signal.aborted, false);
        if (disposition === "rejected") {
          throw new Error("failure persistence unavailable");
        }
        return disposition !== "declined";
      },
    });
    const committed = await appendMessage(fixture);
    const delivery = committed.deliveries[0];
    const executor = createDeliveryExecutor({
      store: fixture.store,
      registry: fixture.registry,
      createContext: fixture.createContext,
    });
    try {
      const handle = await executor.dispatchDelivery(delivery);
      await handle.done;
      const status =
        disposition === "handled" || disposition === "non-retryable"
          ? "succeeded"
          : "dead_letter";
      const terminal = await waitForDeliveryStatus(
        fixture.store,
        delivery.id,
        status,
      );
      assertEquals(
        attempts,
        disposition === "non-retryable" ? 1 : delivery.maxAttempts,
      );
      assertEquals(terminal.attempts, attempts);
      assertEquals(recoveries, 1);
    } finally {
      await executor.shutdown();
      await closeFixture(fixture);
    }
  });
}

Deno.test("successful retry never invokes terminal Processor recovery", async () => {
  let attempts = 0, recoveries = 0;
  const fixture = await createFixture({
    handle() {
      if (++attempts === 1) throw new Error("temporary preparation failure");
    },
    onError() {
      recoveries++;
      return true;
    },
  });
  const committed = await appendMessage(fixture);
  const delivery = committed.deliveries[0];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
  });
  try {
    const handle = await executor.dispatchDelivery(delivery);
    await handle.done;
    await waitForDeliveryStatus(fixture.store, delivery.id, "succeeded");
    assertEquals(attempts, 2);
    assertEquals(recoveries, 0);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});

Deno.test("cancelled execution never invokes terminal Processor recovery", async () => {
  const abort = new AbortController();
  let recoveries = 0;
  const fixture = await createFixture({
    handle() {
      abort.abort(new Error("execution cancelled"));
      throw markNonRetryable(new Error("interrupted preparation"));
    },
    onError() {
      recoveries++;
      return true;
    },
  });
  try {
    const { event, deliveries } = await appendMessage(fixture);
    const delivery = deliveries[0];
    const workload = createDeliveryWorkload({
      store: fixture.store,
      registry: fixture.registry,
      createContext: fixture.createContext,
    });
    await workload({
      streamId: "cancelled-stream",
      workload: "copilotz.delivery.v1",
      input: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      sendMetadata: async () => {},
      metadata: {
        schema: "copilotz.delivery.dispatch.v1",
        databaseSchema: fixture.store.databaseSchema,
        namespace: event.namespace,
        eventId: event.id,
        deliveryId: delivery.id,
        consumerId: delivery.consumerId,
        dispatchAttemptId: "cancelled-attempt",
        idempotencyKey: delivery.id,
      },
      signal: abort.signal,
    });
    assertEquals(recoveries, 0);
    assertEquals(
      (await fixture.store.getDelivery(delivery.id))?.status,
      "dead_letter",
    );
  } finally {
    await closeFixture(fixture);
  }
});
Deno.test("concurrent local dispatch calls share one physical delivery attempt", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-dedup-test",
  });
  try {
    const [first, second] = await Promise.all([
      executor.dispatchDelivery(committed.deliveries[0].id),
      executor.dispatchDelivery(committed.deliveries[0].id),
    ]);
    assertEquals(first.operationId, second.operationId);
    assertEquals((await first.done).delivery.status, "succeeded");
    assertEquals((await second.done).delivery.attempts, 1);
    assertEquals(fixture.calls.length, 1);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("scope progress resolves when local work for the scope finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const fixture = await createFixture({ handle: () => gate });
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-progress-test",
  });
  const scope = {
    namespace: "tenant-a",
    settlementScopeId: committed.deliveries[0].settlementScopeId,
  };
  try {
    assertEquals(await executor.awaitScopeProgress(scope), false);
    const handle = await executor.dispatchDelivery(committed.deliveries[0].id);
    let progressed = false;
    const progress = executor.awaitScopeProgress(scope).then((value) => {
      progressed = value;
    });
    await handle.started;
    assertEquals(progressed, false);
    release();
    await progress;
    assertEquals(progressed, true);
    assertEquals((await handle.done).delivery.status, "succeeded");
    assertEquals(await executor.awaitScopeProgress(scope), false);
  } finally {
    release();
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("A52 a shared Hypervisor survives Copilotz worker shutdown", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.shared.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transport],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    hypervisor,
    transport,
    workerId: "shared-copilotz",
  });
  let applicationWorker: ReturnType<typeof createWorker> | undefined;
  try {
    assertEquals(executor.ownership, "shared_hypervisor");
    const result =
      await (await executor.dispatchDelivery(committed.deliveries[0])).done;
    assertEquals(result.delivery.status, "succeeded");
    await executor.shutdown();
    assertEquals(hypervisor.snapshot().inProcessWorkers, 0);
    applicationWorker = createWorker({
      id: "application-worker",
      transport,
      workloads: {
        "application.probe.v1": () => ({ metadata: { alive: true } }),
      },
    });
    await applicationWorker.ready;
    const probe = await hypervisor.dispatch({
      workload: "application.probe.v1",
    });
    assertEquals(await probe.metadata, { alive: true });
    assertEquals((await probe.completed).status, "completed");
  } finally {
    await executor.shutdown();
    await applicationWorker?.stop();
    await applicationWorker?.closed;
    await hypervisor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("A53 remote dispatch contains serializable identities and resolves on the worker", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.remote.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transport],
  });
  const worker = createWorker({
    id: "external-copilotz",
    transport,
    workloads: {
      "copilotz.delivery.v1": createDeliveryWorkload({
        store: fixture.store,
        registry: fixture.registry,
        createContext: fixture.createContext,
      }),
    },
  });
  await worker.ready;
  const captured: unknown[] = [];
  const dispatcher: DeliveryDispatcher = {
    dispatch(input) {
      assertEquals(input.body, undefined);
      const encoded = JSON.stringify(input.metadata);
      assert(!encoded.includes("function"));
      captured.push(JSON.parse(encoded));
      return hypervisor.dispatch(input);
    },
  };
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    dispatcher,
    target: { workerId: "external-copilotz" },
  });
  try {
    assertEquals(executor.ownership, "injected_dispatcher");
    const result =
      await (await executor.dispatchDelivery(committed.deliveries[0])).done;
    assertEquals(result.delivery.status, "succeeded");
    assertEquals(captured.length, 1);
    assertEquals(captured[0], {
      schema: "copilotz.delivery.dispatch.v1",
      databaseSchema: fixture.store.databaseSchema,
      deliveryId: committed.deliveries[0].id,
      eventId: committed.event.id,
      consumerId: "processor:messages.observe",
      namespace: "tenant-a",
      dispatchAttemptId: (captured[0] as Record<string, unknown>)
        .dispatchAttemptId,
      idempotencyKey: committed.deliveries[0].id,
    });
    await executor.shutdown();
    assertEquals(hypervisor.snapshot().inProcessWorkers, 1);
    assertExists(hypervisor.sessions.get("external-copilotz"));
  } finally {
    await executor.shutdown();
    await worker.stop();
    await worker.closed;
    await hypervisor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("shared Hypervisors require their explicit event-fabric transport", async () => {
  const fixture = await createFixture();
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.explicit.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({ transports: [transport] });
  try {
    assertThrows(
      () =>
        createDeliveryExecutor({
          store: fixture.store,
          registry: fixture.registry,
          createContext: fixture.createContext,
          hypervisor,
        }),
      TypeError,
      "requires its declared in-process transport",
    );
  } finally {
    await hypervisor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("delivery diagnostics correlate placement and worker settlement without affecting a throwing sink", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const diagnostics: Array<Record<string, unknown>> = [];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "diagnostic-worker",
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
      if (diagnostic.phase === "placement_accepted") {
        throw new Error("observation must be isolated");
      }
      return Promise.resolve();
    },
  });
  try {
    const handle = await executor.dispatchDelivery(committed.deliveries[0]);
    assertEquals((await handle.done).delivery.status, "succeeded");
    const requested = diagnostics.find((item) =>
      item.phase === "placement_requested"
    );
    const accepted = diagnostics.find((item) =>
      item.phase === "placement_accepted"
    );
    const claimed = diagnostics.find((item) => item.phase === "worker_claimed");
    const settled = diagnostics.find((item) =>
      item.phase === "worker_handler_settled"
    );
    assertExists(requested);
    assertExists(accepted);
    assertExists(claimed);
    assertExists(settled);
    assertEquals(requested.eventId, committed.event.id);
    assertEquals(requested.deliveryId, committed.deliveries[0].id);
    assertEquals(requested.dispatchAttemptId, accepted.dispatchAttemptId);
    assertEquals(accepted.operationId, handle.operationId);
    assertEquals(claimed.workerId, "diagnostic-worker");
    assertEquals(settled.status, "succeeded");
    for (const diagnostic of diagnostics) {
      assertEquals(
        Object.keys(diagnostic).every((key) =>
          [
            "phase",
            "timestampMs",
            "eventId",
            "deliveryId",
            "consumerId",
            "dispatchAttemptId",
            "operationId",
            "workerId",
            "databaseSchema",
            "namespace",
            "status",
            "error",
            "capacity",
            "activeCount",
            "queuedCount",
            "origin",
          ].includes(key)
        ),
        true,
      );
    }
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("a failed handler reports a bounded, credential-masked error in its diagnostic", async () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const fixture = await createFixture({
    handle: () => {
      const error = new TypeError(
        `upstream rejected the call with Authorization: Bearer ${secret} ${
          "x".repeat(2_000)
        }`,
      );
      error.stack = `TypeError: leaked-in-stack ${secret}`;
      (error as Error & { cause?: unknown }).cause = new Error(
        `cause ${secret}`,
      );
      throw error;
    },
  });
  const committed = await appendMessage(fixture);
  const settled: Array<Record<string, unknown>> = [];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    onDiagnostic(diagnostic) {
      if (diagnostic.phase === "worker_handler_settled") {
        settled.push(diagnostic);
      }
    },
  });
  try {
    const handle = await executor.dispatchDelivery(committed.deliveries[0]);
    assertEquals((await handle.done).delivery.status, "retry_wait");
    assertEquals(settled.length, 1);
    assertEquals(settled[0].status, "retry_wait");
    const error = settled[0].error as { name: string; message: string };
    assertEquals(Object.keys(error).sort(), ["message", "name"]);
    assertEquals(error.name, "TypeError");
    assert(error.message.startsWith("upstream rejected the call with"));
    assert(error.message.length <= 501, "the message is bounded");
    const encoded = JSON.stringify(settled);
    assertEquals(encoded.includes(secret), false);
    assertEquals(encoded.includes("leaked-in-stack"), false);
    assertEquals(encoded.includes("cause"), false);
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("a successful or dead-lettered handler diagnostic is consistent about its error", async () => {
  const fixture = await createFixture({
    handle: () => {
      throw markNonRetryable(new Error("configuration is invalid"));
    },
  });
  const committed = await appendMessage(fixture);
  const settled: Array<Record<string, unknown>> = [];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    onDiagnostic(diagnostic) {
      if (diagnostic.phase === "worker_handler_settled") {
        settled.push(diagnostic);
      }
    },
  });
  try {
    const handle = await executor.dispatchDelivery(committed.deliveries[0]);
    assertEquals((await handle.done).delivery.status, "dead_letter");
    assertEquals(settled.map((item) => item.status), ["dead_letter"]);
    assertEquals(settled[0].error, {
      name: "Error",
      message: "configuration is invalid",
    });
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
  const ok = await createFixture();
  const okCommitted = await appendMessage(ok);
  const okSettled: Array<Record<string, unknown>> = [];
  const okExecutor = createDeliveryExecutor({
    store: ok.store,
    registry: ok.registry,
    createContext: ok.createContext,
    onDiagnostic(diagnostic) {
      if (diagnostic.phase === "worker_handler_settled") {
        okSettled.push(diagnostic);
      }
    },
  });
  try {
    await (await okExecutor.dispatchDelivery(okCommitted.deliveries[0])).done;
    assertEquals(okSettled.map((item) => item.status), ["succeeded"]);
    assertEquals("error" in okSettled[0], false);
  } finally {
    await okExecutor.shutdown();
    await closeFixture(ok);
  }
});
Deno.test("summarizeDeliveryError bounds and masks whatever is thrown", () => {
  assertEquals(summarizeDeliveryError(new RangeError("out of range")), {
    name: "RangeError",
    message: "out of range",
  });
  // Values that are not errors never expose their own properties or string form.
  assertEquals(summarizeDeliveryError({ apiKey: "sk-live-0123456789abcdef" }), {
    name: "Error",
    message: "A non-Error value was thrown.",
  });
  assertEquals(
    summarizeDeliveryError(undefined).message,
    "A non-Error value was thrown.",
  );
  assertEquals(summarizeDeliveryError("plain failure"), {
    name: "Error",
    message: "plain failure",
  });
  // A name cannot smuggle text into the summary.
  const named = new Error("m");
  named.name = "Not a name\nwith text sk-abcdefghijklmnopqrstuvwxyz";
  assertEquals(summarizeDeliveryError(named).name, "Error");
  // An empty message falls back to the name.
  assertEquals(
    summarizeDeliveryError(new SyntaxError("")).message,
    "SyntaxError",
  );
  // A hostile message accessor cannot break settlement.
  const hostile = new Error("x");
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("no");
    },
  });
  assertEquals(
    summarizeDeliveryError(hostile).message,
    "The error message could not be read.",
  );

  const masked = (text: string) =>
    summarizeDeliveryError(new Error(text)).message;
  assertEquals(
    masked("connect to postgres://app:hunter2@db.internal:5432/x failed"),
    "connect to postgres://[redacted]@db.internal:5432/x failed",
  );
  assertEquals(
    masked("401 from api with Bearer abcdEFGH1234567890"),
    "401 from api with Bearer [redacted]",
  );
  assertEquals(
    masked('bad config {"apiKey": "abc123", "region": "eu"}'),
    'bad config {"apiKey": "[redacted]", "region": "eu"}',
  );
  assertEquals(
    masked("password=hunter2&user=me"),
    "password=[redacted]&user=me",
  );
  assertEquals(
    masked(
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF12345 rejected",
    ),
    "jwt [redacted] rejected",
  );
  assertEquals(
    masked("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz was revoked"),
    "key [redacted] was revoked",
  );
  // Ordinary, useful text is left alone, including ids and colons.
  assertEquals(
    masked(
      "Event '01J8ZQ9K4X' was not found in asset 6c2b1e0a-1111-4222-8333-944455556666: timeout",
    ),
    "Event '01J8ZQ9K4X' was not found in asset 6c2b1e0a-1111-4222-8333-944455556666: timeout",
  );
  // The bound applies after masking, so a secret cannot straddle it.
  const straddle = summarizeDeliveryError(
    new Error(`${"a".repeat(495)} sk-abcdefghijklmnopqrstuvwxyz0123`),
  ).message;
  assertEquals(straddle.includes("sk-"), false);
  assert(straddle.length <= 501);
  assert(
    summarizeDeliveryError(new Error("z".repeat(10_000))).message.endsWith("…"),
  );
});
Deno.test("delivery diagnostics report placement failure and capacity transitions only when enabled", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const failed: string[] = [];
  const failing = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    dispatcher: { dispatch: () => Promise.reject(new Error("unavailable")) },
    onDiagnostic: (diagnostic) => {
      failed.push(diagnostic.phase);
    },
  });
  try {
    await assertRejects(
      () => failing.dispatchDelivery(committed.deliveries[0]),
      Error,
      "unavailable",
    );
    assertEquals(failed, ["placement_requested", "placement_failed"]);
  } finally {
    await failing.shutdown();
  }
  let release!: () => void;
  let begin!: () => void;
  let blockFirst = true;
  const started = new Promise<void>((resolve) => begin = resolve);
  const blocked: string[] = [];
  const capacityFixture = await createFixture({
    handle: () => {
      if (!blockFirst) {
        return;
      }
      blockFirst = false;
      begin();
      return new Promise<void>((resolve) => release = resolve);
    },
  });
  const first = await appendMessage(capacityFixture);
  const second = await appendMessage(capacityFixture);
  const executor = createDeliveryExecutor({
    store: capacityFixture.store,
    registry: capacityFixture.registry,
    createContext: capacityFixture.createContext,
    workerId: "capacity-worker",
    capacity: 1,
    onDiagnostic: (diagnostic) => {
      blocked.push(diagnostic.phase);
    },
  });
  try {
    const firstHandle = await executor.dispatchDelivery(first.deliveries[0]);
    await started;
    executor.scheduleDelivery(second.deliveries[0]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert(blocked.includes("capacity_blocked"));
    release();
    await firstHandle.done;
    await waitForDeliveryStatus(
      capacityFixture.store,
      second.deliveries[0].id,
      "succeeded",
    );
    assert(blocked.includes("capacity_unblocked"));
  } finally {
    await executor.shutdown();
    await closeFixture(capacityFixture);
    await closeFixture(fixture);
  }
});
Deno.test("delivery diagnostics are disabled by default", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
  });
  try {
    assertEquals(
      (await (await executor.dispatchDelivery(committed.deliveries[0])).done)
        .delivery.status,
      "succeeded",
    );
  } finally {
    await executor.shutdown();
    await closeFixture(fixture);
  }
});
Deno.test("A55 delivery execution core is factory-first and runtime-neutral", async () => {
  for (const module of ["executor.ts", "index.ts", "types.ts", "workload.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\b(?:Deno|Bun|process)\./.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
    assert(
      !/serializedClosure|producedEvents|shouldProcess/.test(source),
      module,
    );
  }
});
