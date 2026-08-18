import { assert, assertEquals, assertExists } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
} from "./index.ts";

async function createStore() {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "copilotz_coordinator";
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
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
      assertEquals(
        context.idempotencyKey,
        (context.delivery as { id: string }).id,
      );
      order.push("handled");
    },
  });
  const baseRegistry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.widgets",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const registry = Object.freeze({
    ...baseRegistry,
    durableConsumers(draft: Parameters<typeof baseRegistry.durableConsumers>[0]) {
      order.push("matched");
      return baseRegistry.durableConsumers(draft);
    },
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
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
      manifest: {
        id: "test.audit",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
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
      manifest: {
        id: "test.once",
        version: "1.0.0",
        provides: { processors: [processor.id] },
      },
      resources: { processors: [processor] },
    })],
  });
  const executor = createDeliveryExecutor({
    store: fixture.store,
    registry,
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
