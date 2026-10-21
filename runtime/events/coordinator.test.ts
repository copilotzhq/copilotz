import { awaitEventPublication } from "./coordinator.ts";
import {
  createOwnerCommands,
  createSchemaCommandRunner,
} from "../engine/commands.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import {
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "./index.ts";

async function createStore() {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_coordinator";
  await provisionCopilotzSchema(session, schema);
  return {
    db,
    session,
    store: createEventStore({ session, schema, random: () => 0 }),
  };
}

Deno.test("event coordinator matches before commit, publishes, then dispatches", async () => {
  const fixture = await createStore();
  const order: string[] = [];
  const processor = defineProcessor({
    id: "widgets.observe",
    on: [{ eventType: "widget.created" }],
    handle(event, context) {
      assert(event.durable);
      assertEquals(context.operationKey, context.identity.deduplicationId);
      order.push("handled");
    },
  });
  const baseRegistry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.widgets",
      version: "1.0.0",
      processors: { observer: processor },
    })],
  });
  const registry = Object.freeze({
    ...baseRegistry,
    durableConsumers(
      draft: Parameters<typeof baseRegistry.durableConsumers>[0],
    ) {
      order.push("matched");
      return baseRegistry.durableConsumers(draft);
    },
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "coordinator-test",
  });
  const coordinator = createEventCoordinator({
    store: fixture.store,
    registry,
    executor,
    publish() {
      order.push("published");
    },
  });

  try {
    const result = await coordinator.commitMutation({
      draft: {
        type: "widget.created",
        namespace: "tenant-a",
        subject: { type: "widget", id: "widget-a" },
        payload: { id: "widget-a", label: "A" },
      },
      mutate: async ({ transaction, tables }) => {
        order.push("mutated");
        await transaction.query(
          `INSERT INTO ${tables.nodes} (id, namespace, type, name, data)
           VALUES ('widget-a', 'tenant-a', 'widget', 'A', '{}')`,
        );
        return { id: "widget-a" };
      },
    });

    assertEquals(result.dispatch.failures, []);
    assertEquals(result.dispatch.handles.length, 1);
    assertEquals(order.slice(0, 3), ["matched", "mutated", "published"]);
    assertEquals(
      (await result.dispatch.handles[0].done).delivery.status,
      "succeeded",
    );
    assertEquals(order, ["matched", "mutated", "published", "handled"]);
    const node = await fixture.session.query<{ id: string }>(
      `SELECT id FROM ${fixture.store.tables.nodes} WHERE id = 'widget-a'`,
    );
    assertEquals(node.rows, [{ id: "widget-a" }]);
  } finally {
    await executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("post-commit publication and placement failures leave delivery recoverable", async () => {
  const fixture = await createStore();
  const processor = defineProcessor({
    id: "audit.observe",
    on: [{ eventType: "audit.created" }],
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.audit",
      version: "1.0.0",
      processors: { observer: processor },
    })],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
    createContext: createTestProcessorContext,
    dispatcher: {
      dispatch: () => Promise.reject(new Error("no worker capacity")),
    },
  });
  const observedFailures: string[] = [];
  const coordinator = createEventCoordinator({
    store: fixture.store,
    registry,
    executor,
    publish: () => {
      throw new Error("observer unavailable");
    },
    onDispatchFailure: (failure) => observedFailures.push(failure.deliveryId),
  });

  try {
    const result = await coordinator.append({
      type: "audit.created",
      namespace: "tenant-a",
      payload: { action: "created" },
    });
    assertExists(result.publishError);
    assertEquals(result.dispatch.handles, []);
    assertEquals(result.dispatch.failures.length, 1);
    assertEquals(observedFailures, [result.deliveries[0].id]);
    assertEquals(
      (await fixture.store.getDelivery(result.deliveries[0].id))?.status,
      "pending",
    );
    assertEquals(
      (await fixture.store.listRecoverable({ namespace: "tenant-a" })).length,
      1,
    );
  } finally {
    await executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("deduplicated settled events do not dispatch a second operation", async () => {
  const fixture = await createStore();
  let calls = 0;
  const processor = defineProcessor({
    id: "once.observe",
    on: [{ eventType: "once.created" }],
    handle: () => {
      calls++;
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.once",
      version: "1.0.0",
      processors: { observer: processor },
    })],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "coordinator-dedupe-test",
  });
  let publications = 0;
  const coordinator = createEventCoordinator({
    store: fixture.store,
    registry,
    executor,
    publish: () => {
      publications++;
    },
  });
  const draft = {
    type: "once.created",
    namespace: "tenant-a",
    payload: { id: "once" },
    deduplicationId: "once:create",
  } as const;

  try {
    const first = await coordinator.append(draft);
    await first.dispatch.handles[0].done;
    const replay = await coordinator.append(draft);
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.event.id, first.event.id);
    assertEquals(replay.dispatch.handles, []);
    assertEquals(calls, 1);
    assertEquals(publications, 1);
  } finally {
    await executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("A55 event coordinator remains factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("coordinator.ts", import.meta.url),
  );
  assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/\bclass\s+\w+/.test(source));
  assert(!/runtime\/cli|server\//.test(source));
});

Deno.test("a rejected placement is retried from the queue without a recovery sweep", async () => {
  const fixture = await createStore();
  const handled = Promise.withResolvers<void>();
  let calls = 0;
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "placement-retry",
      version: "1",
      processors: {
        observe: defineProcessor({
          id: "placement-retry.observe",
          on: [{ eventType: "placement.request" }],
          handle() {
            calls++;
            handled.resolve();
          },
        }),
      },
    })],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({
    store: fixture.store,
    registry,
    executor: {
      ...executor,
      dispatchDelivery: () => Promise.reject(new Error("capacity occupied")),
    },
  });
  const deadline = setTimeout(
    () => handled.reject(new Error("Queue did not retry")),
    5_000,
  );
  try {
    const result = await coordinator.append({
      type: "placement.request",
      namespace: "tenant-a",
      payload: {},
    });
    assertEquals(result.dispatch.failures.length, 1);
    await handled.promise;
    // Joining the active attempt waits for the durable lease settlement too.
    const execution = await executor.dispatchDelivery(result.deliveries[0]);
    const outcome = await execution.done;
    assertEquals(outcome.delivery.status, "succeeded");
    assertEquals(outcome.delivery.attempts, 1);
    assertEquals(calls, 1);
  } finally {
    clearTimeout(deadline);
    await executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("joined events publish only after confirmed outer commit", async () => {
  const fixture = await createStore();
  const registry = await createPluginRegistry();
  const published: string[] = [];
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "commit-gate-test",
  });
  const coordinator = createEventCoordinator({
    store: fixture.store,
    registry,
    executor,
    publish: (event) => {
      assert(event.durable);
      published.push(event.id);
    },
  });
  try {
    const committed = await createSchemaCommandRunner(
      fixture.session,
      fixture.store.databaseSchema,
    )("test.mutation", {}, async (_input, { transaction }) => {
      const result = await coordinator.commitMutation({
        draft: { type: "note.created", namespace: "notes", payload: {} },
        transaction,
      });
      assertEquals(published, []);
      return result;
    });
    await Promise.all([
      awaitEventPublication(committed),
      awaitEventPublication(committed),
    ]);
    assertEquals(published, [committed.event.id]);

    let rolledBack!: typeof committed;
    await assertRejects(() =>
      createSchemaCommandRunner(fixture.session, fixture.store.databaseSchema)(
        "test.mutation",
        {},
        async (_input, { transaction }) => {
          rolledBack = await coordinator.commitMutation({
            draft: { type: "note.created", namespace: "notes", payload: {} },
            transaction,
          });
          throw new Error("rollback");
        },
      )
    );
    assertEquals(published, [committed.event.id]);
    assertEquals(await fixture.store.getEvent(rolledBack.event.id), null);

    let uncertain!: typeof committed;
    let loseAcknowledgement = false;
    const schema = fixture.store.databaseSchema;
    const uncertainOwner = createOwnerCommands({
      session: {
        query: fixture.session.query,
        async transaction(operation) {
          const result = await fixture.session.transaction(operation);
          if (loseAcknowledgement) {
            throw new Error("commit acknowledgement lost");
          }
          return result;
        },
      },
      schema,
      handlers: {
        append: {
          authorize() {},
          async execute(_input: Record<never, never>, { transaction }) {
            uncertain = await coordinator.commitMutation({
              draft: { type: "note.created", namespace: "notes", payload: {} },
              transaction,
              body: { id: "uncertain-body", json: { text: "recorded" } },
            });
            return uncertain;
          },
        },
      },
    });
    const current = await fixture.session.query<{ epoch: string }>(
      `SELECT epoch FROM ${fixture.store.tables.owner_epochs}`,
    );
    await uncertainOwner.acquire(Number(current.rows[0].epoch));
    loseAcknowledgement = true;
    await assertRejects(() =>
      uncertainOwner.execute("append", {
        principal: "runtime",
        epoch: uncertainOwner.epoch!,
      }, { input: {} })
    );
    assertEquals(uncertainOwner.state, "stopped");
    assertEquals(published, [committed.event.id]);
    assertEquals(
      fixture.store.recentEventBody?.(uncertain.event.id, "uncertain-body"),
      undefined,
    );
    assertExists(await fixture.store.getEvent(uncertain.event.id));
  } finally {
    await executor.shutdown();
    await fixture.db.close();
  }
});

Deno.test("shutdown finishes a held publication and parks its durable delivery for recovery", async () => {
  const fixture = await createStore();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let handled = false;
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.shutdown-publication",
      version: "1",
      processors: {
        retained: defineProcessor({
          id: "shutdown.retained",
          on: [{ eventType: "shutdown.retained" }],
          handle() {
            handled = true;
          },
        }),
      },
    })],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({
    store: fixture.store,
    registry,
    executor,
    async publish() {
      entered.resolve();
      await release.promise;
    },
  });
  const committing = coordinator.append({
    type: "shutdown.retained",
    namespace: "test",
    payload: {},
    metadata: { sourceDeliveryId: "earlier-delivery" },
  });
  try {
    await entered.promise;
    coordinator.close();
    await executor.shutdown();
    release.resolve();
    const result = await committing;
    assertEquals(result.dispatch, { handles: [], failures: [] });
    assertEquals(handled, false);
    assertEquals(
      (await fixture.store.getDelivery(result.deliveries[0].id))?.status,
      "pending",
    );
    const successor = createDeliveryExecutor({
      store: fixture.store,
      registry,
      createContext: createTestProcessorContext,
    });
    try {
      const handle = await successor.dispatchDelivery(result.deliveries[0]);
      assertEquals((await handle.done).delivery.status, "succeeded");
      assert(handled);
    } finally {
      await successor.shutdown();
    }
  } finally {
    release.resolve();
    await committing;
    await executor.shutdown();
    await fixture.db.close();
  }
});
