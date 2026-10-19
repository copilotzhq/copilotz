import {
  createOwnerCapabilityHost,
  type OwnerCapabilityHost,
} from "./owner-capabilities.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import {
  type DatabaseOwner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { registerDeliveryAlarms } from "./alarms.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  createEventStore,
  createSqlSession,
  type EventStore,
  provisionCopilotzSchema,
} from "../events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  isNonRetryableError,
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
  owner: DatabaseOwner;
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
        actionScopeId?: string;
        deliveryLease?: Readonly<{ deliveryId: string; owner: string }>;
        metadata: Readonly<Record<string, unknown>>;
      }>;
    }>
  >;
}>;
async function createFixture(options?: {
  handle?: (eventId: string, idempotencyKey: string) => void | Promise<void>;
  onError?: Processor["onError"];
}): Promise<Fixture> {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const session = createSqlSession(db);
  const schema = `execution_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(session, schema);
  const owner = await openDatabaseOwner(session, schema);
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
  return Object.freeze({ db, owner, store, registry, createContext, calls });
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
  releaseDatabaseOwner(fixture.owner);
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await fixture.db.query(
      `DROP SCHEMA "${fixture.store.databaseSchema}" CASCADE`,
    );
  }
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
Deno.test("direct local execution recovers and executes a durable delivery", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-private-test",
  });
  try {
    assertEquals(executor.ownership, "local");
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
    const lease = fixture.calls[0].mutationIdentity.deliveryLease;
    assertExists(lease);
    assertEquals(lease.deliveryId, committed.deliveries[0].id);
    assertEquals(lease.owner.length > 0, true);
    assertEquals(fixture.calls, [{
      eventId: committed.event.id,
      idempotencyKey: committed.deliveries[0].id,
      mutationIdentity: {
        causationId: committed.event.id,
        correlationId: committed.event.correlationId,
        deduplicationId: `delivery:${committed.deliveries[0].id}:effect`,
        settlementScopeId: committed.event.id,
        actionScopeId: undefined,
        deliveryLease: lease,
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
  let reads = 0, eventReads = 0;
  const store: EventStore = {
    ...fixture.store,
    getEvent: (id) => {
      eventReads++;
      return fixture.store.getEvent(id);
    },
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
    assertEquals(
      eventReads,
      1,
      "placement carries the owner-resolved event into execution",
    );
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
Deno.test("a filtered recovery never dispatches another namespace", async () => {
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
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "copilotz-filtered-recovery-test",
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
  registerDeliveryAlarms(fixture.owner, fixture.store, executor);
  fixture.owner.activate();
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
  registerDeliveryAlarms(fixture.owner, fixture.store, executor);
  fixture.owner.activate();
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
        // Owner capabilities transport error data, not the worker's prototype/stack.
        assert(cause instanceof Error);
        assertEquals(cause.name, error.name);
        assertEquals(cause.message, error.message);
        assertEquals(
          isNonRetryableError(cause),
          disposition === "non-retryable",
        );
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
    registerDeliveryAlarms(fixture.owner, fixture.store, executor);
    fixture.owner.activate();
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
  registerDeliveryAlarms(fixture.owner, fixture.store, executor);
  fixture.owner.activate();
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
      localExecution: true,
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
      callHost: () =>
        Promise.reject(new Error("owner test has no reverse callback")),
      metadata: {
        schema: "copilotz.delivery.dispatch.v1",
        ownerEpoch: 1,
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
Deno.test("A53 remote dispatch contains serializable identities and resolves on the worker", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.remote.${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transport],
    workerCalls: { admit: (binding) => ownerHost.workerCalls.admit(binding) },
  }, {
    onDisconnect: (event) => ownerHost.lifecycle?.onDisconnect?.(event),
    onComplete: (event) => ownerHost.lifecycle?.onComplete?.(event),
  });
  const ownerHost: OwnerCapabilityHost = createOwnerCapabilityHost({
    sessions: hypervisor.sessions,
    registry: fixture.registry,
    resolveAuthority: () => fixture.store.executionAuthority(),
    createWorkloads: ({ registry, trackAttempt }) => ({
      "copilotz.delivery.v1": createDeliveryWorkload({
        trackAttempt,
        store: fixture.store,
        registry,
        createContext: fixture.createContext,
      }),
    }),
  });
  const worker = createWorker({
    id: "external-copilotz",
    transport,
    hostCalls: {},
    workloads: createOwnerWorkerWorkloads({ registry: fixture.registry }),
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
      ownerEpoch: 1,
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
    await ownerHost.close();
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

Deno.test("a stale owner dispatch cannot claim a delivery under the new epoch", async () => {
  const fixture = await createFixture();
  try {
    const { event, deliveries: [delivery] } = await appendMessage(fixture);
    const authority = await fixture.store.executionAuthority();
    const workload = createDeliveryWorkload({
      localExecution: true,
      store: fixture.store,
      registry: fixture.registry,
      createContext: fixture.createContext,
    });
    await assertRejects(
      async () =>
        await workload({
          streamId: "stale",
          workload: "copilotz.delivery.v1",
          input: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          sendMetadata: () => Promise.resolve(),
          callHost: () =>
            Promise.reject(new Error("owner test has no reverse callback")),
          metadata: {
            schema: "copilotz.delivery.dispatch.v1",
            ownerEpoch: authority.epoch + 1,
            databaseSchema: fixture.store.databaseSchema,
            namespace: event.namespace,
            eventId: event.id,
            deliveryId: delivery.id,
            consumerId: delivery.consumerId,
            dispatchAttemptId: "stale",
            idempotencyKey: delivery.id,
          },
          signal: new AbortController().signal,
        }),
      Error,
      "stale owner epoch",
    );
    assertEquals(
      (await fixture.store.getDelivery(delivery.id))?.status,
      "pending",
    );
    assertEquals(fixture.calls.length, 0);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("owner alarm recovers an expired remote lease without an executor recovery timer", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const delivery = committed.deliveries[0];
  await fixture.store.claimDelivery({
    id: delivery.id,
    owner: "remote-lost",
    leaseMs: 50,
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "owner-remote-recovery",
  });
  registerDeliveryAlarms(fixture.owner, fixture.store, executor);
  try {
    fixture.owner.activate();
    const completed = await waitForDeliveryStatus(
      fixture.store,
      delivery.id,
      "succeeded",
    );
    assertEquals(completed.attempts, 2);
    assertEquals(fixture.calls.length, 1);
    assertEquals(
      (await fixture.db.query(
        `SELECT * FROM ${
          createCoreTableNames(fixture.store.databaseSchema).owner_deadlines
        } WHERE source='deliveries'`,
      )).rows,
      [],
    );
  } finally {
    fixture.owner.pauseAlarms();
    await fixture.owner.drainAlarms();
    await executor.shutdown();
    await closeFixture(fixture);
  }
});

Deno.test("owner retry alarm retains the original backoff across executor and owner restart", async () => {
  const fixture = await createFixture();
  const delivery = (await appendMessage(fixture)).deliveries[0];
  await fixture.store.claimDelivery({ id: delivery.id, owner: "remote-first" });
  const retry = await fixture.store.failDelivery({
    id: delivery.id,
    owner: "remote-first",
    error: new Error("retry"),
    backoffMs: 500,
  });
  assertExists(retry);
  const table =
    createCoreTableNames(fixture.store.databaseSchema).owner_deadlines;
  const before = (await fixture.db.query<{ due_at: Date | string }>(
    `SELECT due_at FROM ${table} WHERE source='deliveries' AND key=$1`,
    [delivery.id],
  )).rows[0];
  assertEquals(new Date(before.due_at).toISOString(), retry.availableAt);
  releaseDatabaseOwner(fixture.owner);
  const owner = await openDatabaseOwner(
    fixture.store.session,
    fixture.store.databaseSchema,
  );
  const store = createEventStore({
    session: fixture.store.session,
    schema: fixture.store.databaseSchema,
    random: () => 0,
  });
  const executor = createDeliveryExecutor({
    store,
    registry: fixture.registry,
    createContext: fixture.createContext,
    workerId: "owner-retry-restart",
  });
  registerDeliveryAlarms(owner, store, executor);
  try {
    const after = (await fixture.db.query<{ due_at: Date | string }>(
      `SELECT due_at FROM ${table} WHERE source='deliveries' AND key=$1`,
      [delivery.id],
    )).rows[0];
    assertEquals(
      new Date(after.due_at).toISOString(),
      new Date(before.due_at).toISOString(),
    );
    owner.activate();
    const completed = await waitForDeliveryStatus(
      store,
      delivery.id,
      "succeeded",
    );
    assertEquals(completed.attempts, 2);
    assertEquals(fixture.calls.length, 1);
  } finally {
    owner.pauseAlarms();
    await owner.drainAlarms();
    await executor.shutdown();
    releaseDatabaseOwner(owner);
    if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
      await fixture.db.query(
        `DROP SCHEMA "${fixture.store.databaseSchema}" CASCADE`,
      );
    }
    await fixture.db.close();
  }
});
