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
  type PluginRegistry,
} from "../plugins/index.ts";
import {
  createDeliveryExecutor,
  createDeliveryWorkload,
  type DeliveryDispatcher,
} from "./index.ts";

type Fixture = Readonly<{
  db: TestDatabase;
  store: EventStore;
  registry: PluginRegistry;
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
    on: ["message.created"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable) throw new Error("Expected a durable event.");
      const idempotencyKey = String(context.idempotencyKey);
      const createMutationIdentity = context.createMutationIdentity as (
        key: string,
        metadata?: Record<string, unknown>,
      ) => Fixture["calls"][number]["mutationIdentity"];
      const mutationIdentity = createMutationIdentity("effect", {
        custom: "value",
      });
      assert(Object.isFrozen(mutationIdentity));
      assert(Object.isFrozen(mutationIdentity.metadata));
      calls.push(
        Object.freeze({ eventId: event.id, idempotencyKey, mutationIdentity }),
      );
      await options?.handle?.(event.id, idempotencyKey);
    },
  });
  const plugin = definePlugin({
    manifest: {
      id: "test.execution",
      version: "1.0.0",
      provides: { processors: [processor.id] },
    },
    resources: { processors: [processor] },
  });
  const registry = await createPluginRegistry({ plugins: [plugin] });
  return Object.freeze({ db, store, registry, calls });
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

Deno.test("A24 private in-process Oxian recovers and executes a durable delivery", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
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
    workerId: "copilotz-retry-test",
  });
  try {
    const first = await executor.dispatchDelivery(delivery);
    assertEquals((await first.done).delivery.status, "retry_wait");
    const second = await executor.dispatchDelivery(delivery.id);
    const settled = await second.done;

    assertEquals(settled.delivery.status, "succeeded");
    assertEquals(settled.delivery.attempts, 2);
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

Deno.test("concurrent local dispatch calls share one physical delivery attempt", async () => {
  const fixture = await createFixture();
  const committed = await appendMessage(fixture);
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry: fixture.registry,
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
