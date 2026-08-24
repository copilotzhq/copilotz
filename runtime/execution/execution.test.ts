import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { createWorker } from "../../dependencies/oxian-worker.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
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
} from "../plugins/index.ts";
import {
  createDeliveryExecutor,
  createDeliveryWorkload,
  type DeliveryContextFactory,
  type DeliveryDispatcher,
} from "./index.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";

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
    async handle(event, context) {
      if (!event.durable) throw new Error("Expected a durable event.");
      assertEquals(
        [
          "databaseSchema",
          "event",
          "delivery",
          "settlementScopeId",
          "idempotencyKey",
          "dispatchAttemptId",
          "createMutationIdentity",
        ].filter((key) => Object.hasOwn(context, key)),
        [],
      );
      const idempotencyKey = context.operationKey;
      await options?.handle?.(event.id, idempotencyKey);
    },
  });
  const createContext: DeliveryContextFactory = (base) => {
    const mutationIdentity = base.createMutationIdentity("effect", {
      custom: "value",
    });
    assert(Object.isFrozen(mutationIdentity));
    assert(Object.isFrozen(mutationIdentity.metadata));
    calls.push(
      Object.freeze({
        eventId: base.event.id,
        idempotencyKey: base.idempotencyKey,
        mutationIdentity,
      }),
    );
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
    if (delivery?.status === status) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Delivery '${id}' did not reach '${status}'.`);
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

Deno.test("delivery failures retry through the same logical consumer and stable key", async () => {
  let attempt = 0;
  const fixture = await createFixture({
    handle() {
      attempt++;
      if (attempt === 1) throw new Error("synthetic first failure");
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
    const result = await (await executor.dispatchDelivery(
      committed.deliveries[0],
    )).done;
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
    const result = await (await executor.dispatchDelivery(
      committed.deliveries[0],
    )).done;
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
