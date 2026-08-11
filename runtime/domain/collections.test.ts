import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  type SqlSession,
} from "../events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../execution/index.ts";
import { defineCollection, relation } from "./index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import {
  type CollectionRecord,
  createEventCollectionRepository,
  createEventCollections,
  type EventCollectionRepository,
  type EventCollections,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_event_collections";

const parentDefinition = defineCollection({
  name: "contract_parent",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      code: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "code"],
  } as const,
});

const hookCalls: string[] = [];
const childDefinition = defineCollection({
  name: "contract_child",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      parentId: { type: "string" },
      label: { type: "string" },
      secret: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "parentId", "label"],
  } as const,
  relations: {
    parent: relation.belongsTo(
      parentDefinition.name,
      "parentId",
      "contract_parent_children",
    ),
  },
  hooks: {
    beforeCreate(data, context) {
      hookCalls.push(`create:${context.namespace}`);
      return {
        ...data,
        label: typeof data.label === "string"
          ? data.label.trim().toUpperCase()
          : data.label,
      };
    },
    beforeUpdate(data, context) {
      hookCalls.push(`update:${context.namespace}`);
      if (data.label === "REJECT") throw new Error("update rejected");
      return { ...data, label: String(data.label).trim().toUpperCase() };
    },
    beforeDelete(_filter, context) {
      hookCalls.push(`delete:${context.namespace}`);
    },
  },
});

const auditDefinition = defineCollection({
  name: "contract_audit",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      eventType: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "eventType"],
  } as const,
});

type ParentRepository = EventCollectionRepository<
  typeof parentDefinition.schema,
  typeof parentDefinition.$inferSelect,
  typeof parentDefinition.$inferInsert
>;
type ChildRepository = EventCollectionRepository<
  typeof childDefinition.schema,
  typeof childDefinition.$inferSelect,
  typeof childDefinition.$inferInsert
>;

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  parents: ParentRepository;
  children: ChildRepository;
  collections: EventCollections;
  handled: Array<{
    type: string;
    id: string;
    loaded: boolean;
    deduplicationId: string;
  }>;
  validationCalls: string[];
  processorAttempts: Array<{ eventId: string; attempt: number; fail: boolean }>;
}>;

async function createFixture(): Promise<Fixture> {
  hookCalls.length = 0;
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(TEST_SCHEMA)) {
    await session.query(statement);
  }
  const store = createEventStore({
    session,
    schema: TEST_SCHEMA,
    random: () => 0,
    retryBaseMs: 0,
  });
  const handled: Fixture["handled"] = [];
  let children!: ChildRepository;
  let collections!: EventCollections;
  const projectionAttempts = new Map<string, number>();
  const processorAttempts: Fixture["processorAttempts"] = [];
  const processor = defineProcessor({
    id: "contract.child.observe",
    on: [
      "contract_child.created",
      "contract_child.updated",
      "contract_child.deleted",
    ],
    delivery: "durable",
    async handle(event, context) {
      assert(event.durable);
      const id = event.subject!.id;
      const scoped = context.collections as Record<
        string,
        {
          create(input: Record<string, unknown>): Promise<CollectionRecord>;
        }
      >;
      const attempt = (projectionAttempts.get(event.id) ?? 0) + 1;
      projectionAttempts.set(event.id, attempt);
      processorAttempts.push({
        eventId: event.id,
        attempt,
        fail: event.metadata.failAfterProjection === true,
      });
      await scoped.contract_audit.create({
        id: `audit:${event.id}`,
        eventType: event.type,
      });
      if (event.metadata.failAfterProjection === true && attempt === 1) {
        throw new Error("synthetic failure after collection projection");
      }
      const loaded = event.type.endsWith(".deleted")
        ? false
        : Boolean(await children.get(event.namespace, id));
      const createMutationIdentity = context.createMutationIdentity as (
        key: string,
      ) => { deduplicationId: string };
      handled.push({
        type: event.type,
        id,
        loaded,
        deduplicationId: createMutationIdentity("projection").deduplicationId,
      });
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      manifest: {
        id: "test.event-collections",
        version: "1.0.0",
        provides: {
          processors: [processor.id],
          collections: [
            parentDefinition.name,
            childDefinition.name,
            auditDefinition.name,
          ],
        },
      },
      resources: {
        processors: [processor],
        collections: [parentDefinition, childDefinition, auditDefinition],
      },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "event-collections-test",
    createContext: (base) => ({
      collections: collections.withScope({
        namespace: base.event.namespace,
        createMutationIdentity: base.createMutationIdentity,
      }),
    }),
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  const common = {
    coordinator,
    session,
    eventStore: store,
    createId: () => `collection-${++nextId}`,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  };
  const validationCalls: string[] = [];
  const validate = (input: {
    definition: Readonly<{ name: string }>;
    operation: "create" | "update";
    record: Readonly<Record<string, unknown>>;
  }) => {
    validationCalls.push(`${input.definition.name}:${input.operation}`);
    if (
      input.definition.name === childDefinition.name &&
      typeof input.record.label !== "string"
    ) {
      throw new Error("child label is required");
    }
  };
  const parents = createEventCollectionRepository({
    ...common,
    definition: parentDefinition,
    validate,
  });
  children = createEventCollectionRepository({
    ...common,
    definition: childDefinition,
    validate,
  });
  collections = createEventCollections({
    ...common,
    registry,
    validate,
  });
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    parents,
    children,
    collections,
    handled,
    validationCalls,
    processorAttempts,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

Deno.test("custom collection mutations write graph, compact events, relations, and deliveries", async () => {
  const fixture = await createFixture();
  try {
    await fixture.parents.create({ id: "parent-a", code: "PARENT-A" }, {
      namespace: "tenant-a",
    });
    const created = await fixture.children.create({
      id: "child-a",
      parentId: "parent-a",
      label: "  child one  ",
      secret: "body-must-not-be-in-event",
    }, {
      namespace: "tenant-a",
      identity: {
        correlationId: "collection-run",
        deduplicationId: "child:create:a",
      },
    });
    assertEquals(created.value?.label, "CHILD ONE");
    assertEquals(created.event.type, "contract_child.created");
    assertEquals(created.event.payload, { id: "child-a" });
    assertEquals(created.event.delta, {
      fields: ["createdAt", "id", "label", "parentId", "secret", "updatedAt"],
    });
    assert(
      !JSON.stringify(created.event).includes("body-must-not-be-in-event"),
    );
    assertEquals(created.deliveries.length, 1);
    assertEquals(
      (await created.dispatch.handles[0].done).delivery.status,
      "succeeded",
    );
    assertEquals(fixture.handled, [{
      type: "contract_child.created",
      id: "child-a",
      loaded: true,
      deduplicationId: `delivery:${created.deliveries[0].id}:projection`,
    }]);

    const edge = await fixture.session.query<{
      source_node_id: string;
      target_node_id: string;
      type: string;
    }>(
      `SELECT source_node_id, target_node_id, type
       FROM ${fixture.store.tables.edges}`,
    );
    assertEquals(edge.rows, [{
      source_node_id: "parent-a",
      target_node_id: "child-a",
      type: "contract_parent_children",
    }]);
    assertEquals(hookCalls, ["create:tenant-a"]);
    assertEquals(fixture.validationCalls, [
      "contract_parent:create",
      "contract_child:create",
      "contract_audit:create",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("before hooks replace post-write hooks while update/delete emit independent facts", async () => {
  const fixture = await createFixture();
  try {
    await fixture.parents.create({ id: "parent-a", code: "A" }, {
      namespace: "tenant-a",
    });
    await fixture.parents.create({ id: "parent-b", code: "B" }, {
      namespace: "tenant-a",
    });
    const created = await fixture.children.create({
      id: "child-a",
      parentId: "parent-a",
      label: "first",
    }, { namespace: "tenant-a" });
    await created.dispatch.handles[0].done;

    const updated = await fixture.children.update("child-a", {
      parentId: "parent-b",
      label: "second",
    }, {
      namespace: "tenant-a",
      identity: { deduplicationId: "child:update:a" },
    });
    assertEquals(updated.value?.label, "SECOND");
    assertEquals(updated.event.type, "contract_child.updated");
    assertEquals(updated.event.delta, { fields: ["label", "parentId"] });
    await updated.dispatch.handles[0].done;

    const edge = await fixture.session.query<{ source_node_id: string }>(
      `SELECT source_node_id FROM ${fixture.store.tables.edges}
       WHERE target_node_id = 'child-a'`,
    );
    assertEquals(edge.rows, [{ source_node_id: "parent-b" }]);

    const deleted = await fixture.children.delete("child-a", {
      namespace: "tenant-a",
      identity: { deduplicationId: "child:delete:a" },
    });
    assertEquals(deleted.value, { id: "child-a", deleted: true });
    assertEquals(deleted.event.type, "contract_child.deleted");
    await deleted.dispatch.handles[0].done;
    assertEquals(await fixture.children.get("tenant-a", "child-a"), null);
    assertEquals(
      fixture.handled.map((entry) => [entry.type, entry.loaded]),
      [
        ["contract_child.created", true],
        ["contract_child.updated", true],
        ["contract_child.deleted", false],
      ],
    );
    assertEquals(hookCalls, [
      "create:tenant-a",
      "update:tenant-a",
      "delete:tenant-a",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("collection validation, hooks, and missing relations roll back the full mutation", async () => {
  const fixture = await createFixture();
  try {
    const counts = async () => {
      const result = await fixture.session.query<{
        nodes: string | number;
        events: string | number;
        deliveries: string | number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM ${fixture.store.tables.nodes}) AS nodes,
           (SELECT COUNT(*) FROM ${fixture.store.tables.events}) AS events,
           (SELECT COUNT(*) FROM ${fixture.store.tables.event_deliveries}) AS deliveries`,
      );
      return {
        nodes: Number(result.rows[0].nodes),
        events: Number(result.rows[0].events),
        deliveries: Number(result.rows[0].deliveries),
      };
    };

    await assertRejects(() =>
      fixture.children.create({
        id: "missing-parent-child",
        parentId: "missing-parent",
        label: "orphan",
      }, { namespace: "tenant-a" })
    );
    assertEquals(await counts(), { nodes: 0, events: 0, deliveries: 0 });

    await fixture.parents.create({ id: "parent-a", code: "A" }, {
      namespace: "tenant-a",
    });
    await assertRejects(() =>
      fixture.children.create(
        {
          id: "invalid-child",
          parentId: "parent-a",
        } as typeof childDefinition.$inferInsert,
        { namespace: "tenant-a" },
      )
    );
    assertEquals(await fixture.children.get("tenant-a", "invalid-child"), null);

    const created = await fixture.children.create({
      id: "child-a",
      parentId: "parent-a",
      label: "initial",
    }, { namespace: "tenant-a" });
    await created.dispatch.handles[0].done;
    const beforeRejectedUpdate = await counts();
    await assertRejects(
      () =>
        fixture.children.update("child-a", { label: "REJECT" }, {
          namespace: "tenant-a",
        }),
      Error,
      "update rejected",
    );
    assertEquals(
      (await fixture.children.get("tenant-a", "child-a"))?.label,
      "INITIAL",
    );
    assertEquals(await counts(), beforeRejectedUpdate);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("collection deduplication, cursors, and reads are namespace scoped", async () => {
  const fixture = await createFixture();
  try {
    await fixture.parents.create({ id: "parent-a", code: "A" }, {
      namespace: "tenant-a",
    });
    await fixture.parents.create({ id: "parent-b", code: "B" }, {
      namespace: "tenant-b",
    });
    const input = {
      id: "child-a",
      parentId: "parent-a",
      label: "one",
    };
    const options = {
      namespace: "tenant-a",
      identity: { deduplicationId: "child:once" },
    };
    const first = await fixture.children.create(input, options);
    await first.dispatch.handles[0].done;
    const replay = await fixture.children.create(input, options);
    assertEquals(replay.deduplicated, true);
    assertEquals(replay.event.id, first.event.id);
    assertEquals(replay.dispatch.handles, []);

    const second = await fixture.children.create({
      id: "child-b",
      parentId: "parent-a",
      label: "two",
    }, { namespace: "tenant-a" });
    await second.dispatch.handles[0].done;
    assertEquals(
      (await fixture.children.list("tenant-a")).map((record) => record.id),
      ["child-a", "child-b"],
    );
    assertEquals(
      (await fixture.children.list("tenant-a", { after: "child-a" })).map(
        (record) => record.id,
      ),
      ["child-b"],
    );
    assertEquals(
      (await fixture.children.list("tenant-a", {
        where: { label: "ONE", parentId: "parent-a" },
      })).map((record) => record.id),
      ["child-a"],
    );
    assertEquals(await fixture.children.get("tenant-b", "child-a"), null);
    assertEquals(fixture.handled.length, 2);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("delivery-scoped collections deduplicate a committed projection across processor retry", async () => {
  const fixture = await createFixture();
  try {
    await fixture.parents.create({ id: "parent-a", code: "A" }, {
      namespace: "tenant-a",
    });
    const created = await fixture.children.create({
      id: "child-retry",
      parentId: "parent-a",
      label: "retry",
    }, {
      namespace: "tenant-a",
      identity: {
        correlationId: "retry-scope",
        metadata: { failAfterProjection: true },
      },
    });
    assertEquals(created.event.metadata.failAfterProjection, true);
    const first = await created.dispatch.handles[0].done;
    assertEquals(fixture.processorAttempts, [{
      eventId: created.event.id,
      attempt: 1,
      fail: true,
    }]);
    assertEquals(first.delivery.status, "retry_wait");
    assertEquals(first.delivery.attempts, 1);

    const auditId = `audit:${created.event.id}`;
    assertExists(
      await fixture.collections.withScope({ namespace: "tenant-a" })
        .contract_audit.get(auditId),
    );
    const retry = await fixture.executor.dispatchDelivery(
      created.deliveries[0].id,
    );
    const settled = await retry.done;
    assert(retry.operationId !== created.dispatch.handles[0].operationId);
    assertEquals(fixture.processorAttempts, [{
      eventId: created.event.id,
      attempt: 1,
      fail: true,
    }, {
      eventId: created.event.id,
      attempt: 2,
      fail: true,
    }]);
    assertEquals(settled.delivery.status, "succeeded");
    assertEquals(settled.delivery.attempts, 2);

    const auditEvents = (await fixture.store.listEvents({
      namespace: "tenant-a",
    })).filter((event) => event.type === "contract_audit.created");
    assertEquals(auditEvents.length, 1);
    assertEquals(auditEvents[0].causationId, created.event.id);
    assertEquals(auditEvents[0].correlationId, created.event.correlationId);
    assertEquals(
      auditEvents[0].deduplicationId,
      `delivery:${created.deliveries[0].id}:contract_audit.create:${auditId}`,
    );
    const audits = await fixture.session.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${fixture.store.tables.nodes}
       WHERE namespace = 'tenant-a' AND type = 'contract_audit'`,
    );
    assertEquals(Number(audits.rows[0].count), 1);
    assertEquals(
      fixture.handled.filter((entry) => entry.id === "child-retry").length,
      1,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 event-native collection core is factory-first and runtime-neutral", async () => {
  for (const module of ["collection-types.ts", "collections.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/runtime\/cli|server\//.test(source), module);
    assert(
      !/afterCreate\?\s*\(|afterUpdate\?\s*\(|afterDelete\?\s*\(/.test(source),
    );
    assert(!/unsafeGraph|producedEvents/.test(source));
  }
});
