import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlSession,
  validateCopilotzSchema,
} from "../events/index.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import {
  ACTION_CHILD_EVENT,
  ACTION_CONTINUATION_CONSUMER,
  scheduleResumptions,
} from "./continuation-work.ts";
import { upgradeActionLifecycle } from "./upgrade.ts";
import { ActionOwnershipLost } from "./ownership.ts";

const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
function runtime(db: SqlSession, schema: string) {
  const catalog = createOperationCatalog(db, schema);
  const store = createEventStore({
    session: db,
    schema,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
  });
  const coordinator = createEventCoordinator({
    store,
    registry: { durableConsumers: () => [] } as never,
    executor: {
      scheduleDelivery() {},
      dispatchDelivery: () => Promise.resolve({ done: Promise.resolve() }),
    } as never,
  });
  return { store, coordinator, catalog };
}
async function fixture(url: string) {
  const db = await createTestDatabase({ url, pgPoolMax: 4 });
  const schema = `continuation_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const r = runtime(db, schema);
  const { store, coordinator } = r;
  const root = await store.append({
    namespace: "test",
    type: "test.root",
    payload: {},
    metadata: { observationKeys: ["thread:test"] },
  }, ["test.start"]);
  const delivery = root.deliveries[0];
  await store.claimDelivery({
    id: delivery.id,
    owner: "current",
    leaseMs: 60000,
  });
  const lifecycle = createActionLifecycleEmitter({
    namespace: "test",
    append: createActionLifecycleAppender({
      store,
      coordinator,
      writer: {
        kind: "delivery",
        deliveryId: delivery.id,
        leaseOwner: "current",
      },
    }),
  });
  const common = {
    actionId: "test.wait",
    actionRunId: `run:${schema}`,
    input: {},
    metadata: {},
    settlementScopeId: delivery.settlementScopeId,
    correlationId: root.event.id,
  };
  await lifecycle.emit({
    ...common,
    status: "invoked",
    deduplicationId: `${common.actionRunId}:action:invoked`,
  });
  const request = {
    action: "child",
    input: { captured: "original" },
    metadata: {},
  };
  const childId = `${common.actionRunId}:child`;
  const register = (operationId = childId) =>
    lifecycle.emit({
      ...common,
      status: "awaiting",
      handoff: { checkpoint: "captured" },
      start: { ...request, operationId },
      progressIndex: 0,
      deduplicationId: `${common.actionRunId}:action:awaiting`,
    });
  const prestart = async (linked = false) => {
    const bodyId = `event-body:test:${childId}:start`;
    const result = await store.commitMutation({
      eventId: childId,
      draft: {
        namespace: "test",
        type: ACTION_CHILD_EVENT,
        settlementScopeId: childId,
        deduplicationId: `${childId}:start`,
        payload: {
          dataRef: {
            eventBodyId: bodyId,
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
      },
      body: { id: bodyId, json: request },
      consumers: [],
    });
    if (linked) {
      await db.query(
        `UPDATE ${createOperationCatalogTables(schema).operations}
      SET parent_operation_id = $2, parent_action_run_id = $3 WHERE operation_id = $1`,
        [childId, root.event.id, common.actionRunId],
      );
    }
    return result;
  };
  async function waiter(operationId?: string) {
    const root = await store.append({
      namespace: "test",
      type: "test.waiter",
      payload: {},
      ...(operationId ? { settlementScopeId: operationId } : {}),
    }, ["test.waiter"]);
    const delivery = root.deliveries[0];
    await store.claimDelivery({
      id: delivery.id,
      owner: "current",
      leaseMs: 60000,
    });
    const lifecycle = createActionLifecycleEmitter({
      namespace: "test",
      append: createActionLifecycleAppender({
        store,
        coordinator,
        writer: {
          kind: "delivery",
          deliveryId: delivery.id,
          leaseOwner: "current",
        },
      }),
    });
    const common = {
      actionId: "test.wait",
      actionRunId: `run:${root.event.id}`,
      input: {},
      metadata: {},
      settlementScopeId: delivery.settlementScopeId,
      correlationId: root.event.id,
    };
    await lifecycle.emit({
      ...common,
      status: "invoked",
      deduplicationId: `${common.actionRunId}:action:invoked`,
    });
    return {
      root,
      delivery,
      common,
      register: (target: string, linked = false) =>
        lifecycle.emit({
          ...common,
          status: "awaiting",
          handoff: { waiter: common.actionRunId },
          ...(linked
            ? { start: { ...request, operationId: target } }
            : { operationId: target }),
          progressIndex: 0,
          deduplicationId: `${common.actionRunId}:action:awaiting`,
        }),
    };
  }
  return {
    db,
    schema,
    r,
    store,
    root,
    delivery,
    common,
    childId,
    register,
    waiter,
    prestart,
    async close() {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
for (const backend of ["memory", "postgres"] as const) {
  const url = backend === "memory" ? ":memory:" : postgres;
  const test = (
    name: string,
    fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ) =>
    Deno.test({
      name: `${backend} continuation: ${name}`,
      ignore: !url,
      async fn() {
        const f = await fixture(url!);
        try {
          await fn(f);
        } finally {
          await f.close();
        }
      },
    });
  test("registration persists handoff and public child atomically; fresh runtime resumes once", async (f) => {
    await f.register();
    const child = await f.r.catalog.get("test", f.childId);
    assertEquals(child?.parent, {
      operationId: f.root.event.id,
      actionRunId: f.common.actionRunId,
    });
    assertEquals(child?.metadata.observationKeys, ["thread:test"]);
    const fresh = runtime(f.db, f.schema);
    const [delivery] = await fresh.store.listDeliveries({
      settlementScopeId: f.childId,
    });
    await fresh.store.claimDelivery({ id: delivery.id, owner: "child" });
    await fresh.store.succeedDelivery(delivery.id, "child");
    await fresh.catalog.reconcile({ operationId: f.childId });
    for (let i = 0; i < 3; i++) await (await scheduleResumptions(fresh))();
    const resumes = await fresh.store.listDeliveries({
      settlementScopeId: f.root.event.id,
      consumerId: ACTION_CONTINUATION_CONSUMER,
    });
    assertEquals(resumes.length, 1);
    const receipt = await fresh.store.getEventByDeduplicationId(
      "test",
      `${f.common.actionRunId}:resume`,
    );
    assertEquals(receipt?.type, "copilotz.action.resume");
    assertEquals(
      (await f.db.query(
        `SELECT state, owner_delivery_id FROM ${f.store.tables.open_actions}`,
      )).rows,
      [{ state: "awaiting", owner_delivery_id: resumes[0].id }],
    );
  });
  test("a child settled before registration schedules immediately", async (f) => {
    await f.prestart(true);
    await f.r.catalog.reconcile({ operationId: f.childId });
    await f.register();
    const child = await f.r.catalog.get("test", f.childId);
    assertEquals(child?.parent, {
      operationId: f.root.event.id,
      actionRunId: f.common.actionRunId,
    });
    assertEquals(
      (await f.db.query<{ observation_keys: string[] }>(
        `SELECT observation_keys FROM ${
          createOperationCatalogTables(f.schema).operations
        } WHERE operation_id = $1`,
        [f.childId],
      )).rows[0].observation_keys,
      ["thread:test"],
    );
    assertEquals(
      (await f.store.listDeliveries({
        consumerId: ACTION_CONTINUATION_CONSUMER,
      })).length,
      1,
    );
  });
  test("stale attempt cannot register or start a child", async (f) => {
    await f.db.query(
      `UPDATE ${f.store.tables.event_deliveries} SET lease_owner = 'successor' WHERE id = $1`,
      [f.delivery.id],
    );
    await assertRejects(() => f.register(), ActionOwnershipLost);
    assertEquals(await f.r.catalog.get("test", f.childId), null);
    assertEquals(
      await f.store.getEventByDeduplicationId(
        "test",
        `${f.common.actionRunId}:action:awaiting`,
      ),
      null,
    );
  });
  test("self and ancestor cycles roll back the entire registration", async (f) => {
    await assertRejects(
      () => f.register(f.root.event.id),
      TypeError,
      "ancestor",
    );
    const operations = createOperationCatalogTables(f.schema).operations;
    await f.prestart();
    await f.db.query(
      `UPDATE ${operations} SET parent_operation_id = $2, parent_action_run_id = 'ancestor' WHERE operation_id = $1`,
      [f.root.event.id, f.childId],
    );
    await assertRejects(() => f.register(), TypeError, "ancestor");
    assertEquals(
      (await f.db.query(`SELECT state FROM ${f.store.tables.open_actions}`))
        .rows,
      [{ state: "invoked" }],
    );
  });
  test("incompatible existing child rolls back the waiter", async (f) => {
    await f.store.commitMutation({
      eventId: f.childId,
      draft: { namespace: "test", type: "unrelated", payload: {} },
      consumers: [],
    });
    await assertRejects(() => f.register());
    assertEquals(
      await f.store.getEventByDeduplicationId(
        "test",
        `${f.common.actionRunId}:action:awaiting`,
      ),
      null,
    );
  });
  test("one observed settlement schedules every waiter once, including after restart", async (f) => {
    const waiters = [];
    // Exceeds the maintenance batch size: one settlement must schedule them all.
    for (let i = 0; i < 101; i++) {
      const waiter = await f.waiter();
      await waiter.register(f.root.event.id);
      await f.store.succeedDelivery(waiter.delivery.id, "current");
      waiters.push(waiter);
    }
    assertEquals(
      (await f.r.catalog.get("test", f.root.event.id))?.parent,
      undefined,
    );
    await f.db.query(
      `DELETE FROM ${f.store.tables.open_actions} WHERE action_run_id = $1`,
      [f.common.actionRunId],
    );
    await f.store.succeedDelivery(f.delivery.id, "current");
    const fresh = runtime(f.db, f.schema);
    await fresh.catalog.reconcile({ operationId: f.root.event.id });
    for (let i = 0; i < 2; i++) {
      await (await scheduleResumptions(fresh, {
        namespace: "test",
        operationId: f.root.event.id,
      }))();
    }
    assertEquals(
      (await fresh.store.listDeliveries({
        consumerId: ACTION_CONTINUATION_CONSUMER,
        limit: 200,
      })).length,
      101,
    );
    for (const waiter of waiters) {
      const receipt = await fresh.store.getEventByDeduplicationId(
        "test",
        `${waiter.common.actionRunId}:resume`,
      );
      assertEquals(
        receipt?.deduplicationId,
        `${waiter.common.actionRunId}:resume`,
      );
    }
  });
  test("observing a settled operation resumes immediately without acquiring ownership", async (f) => {
    await f.prestart();
    await f.r.catalog.reconcile({ operationId: f.childId });
    const waiter = await f.waiter();
    await waiter.register(f.childId);
    assertEquals((await f.r.catalog.get("test", f.childId))?.parent, undefined);
    assertEquals(
      (await f.store.getEventByDeduplicationId(
        "test",
        `${waiter.common.actionRunId}:resume`,
      ))?.type,
      "copilotz.action.resume",
    );
  });
  test("unknown observed identity and indirect wait cycles roll back registration", async (f) => {
    const a = await f.waiter();
    const b = await f.waiter();
    const c = await f.waiter();
    await assertRejects(
      () => a.register("unknown-operation"),
      TypeError,
      "Unknown awaited operation",
    );
    await a.register(b.root.event.id);
    await b.register(c.root.event.id);
    await assertRejects(
      () => c.register(a.root.event.id),
      TypeError,
      "wait cycle",
    );
    assertEquals(
      await f.store.getEventByDeduplicationId(
        "test",
        `${c.common.actionRunId}:action:awaiting`,
      ),
      null,
    );
  });
  test("stale observing attempt cannot register and linked children cannot be shared", async (f) => {
    const waiter = await f.waiter(f.root.event.id);
    await f.register();
    await assertRejects(
      () => waiter.register(f.childId, true),
      TypeError,
      "cannot be shared",
    );
    await f.db.query(
      `UPDATE ${f.store.tables.event_deliveries} SET lease_owner = 'successor' WHERE id = $1`,
      [waiter.delivery.id],
    );
    await assertRejects(() => waiter.register(f.childId), ActionOwnershipLost);
    assertEquals(
      await f.store.getEventByDeduplicationId(
        "test",
        `${waiter.common.actionRunId}:action:awaiting`,
      ),
      null,
    );
  });
  test("lifecycle upgrade refuses open work, then preserves immutable history after drain", async (f) => {
    await f.db.query(
      `UPDATE ${f.store.tables.copilotz_schema_metadata} SET version = 7`,
    );
    const catalog = createOperationCatalogTables(f.schema);
    await f.db.query(`ALTER TABLE ${f.store.tables.open_actions}
      DROP CONSTRAINT open_actions_state_check,
      ADD CONSTRAINT open_actions_state_check CHECK (state IN ('invoked','deferred','resolving')),
      DROP COLUMN child_operation_id,
      ADD COLUMN wait_key TEXT,
      ADD COLUMN wait_signaled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN wait_expires_at TIMESTAMPTZ,
      ADD COLUMN resolve_generation INTEGER NOT NULL DEFAULT 0`);
    await f.db.query(
      `ALTER TABLE ${f.store.tables.open_actions} RENAME COLUMN await_event_id TO deferred_event_id`,
    );
    await f.db.query(
      `ALTER TABLE ${catalog.operations} DROP COLUMN parent_operation_id, DROP COLUMN parent_action_run_id`,
    );
    await f.db.query(
      `ALTER TABLE ${catalog.metadata} DROP CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check`,
    );
    await f.db.query(
      `UPDATE ${catalog.metadata} SET fingerprint = 'action-obligations-v1'`,
    );
    await f.db.query(
      `ALTER TABLE ${catalog.metadata} ADD CONSTRAINT copilotz_operation_catalog_metadata_fingerprint_check CHECK (fingerprint = 'action-obligations-v1')`,
    );

    await assertRejects(
      () => upgradeActionLifecycle(f.db, f.schema),
      Error,
      "Drain",
    );
    await f.db.query(`DELETE FROM ${f.store.tables.open_actions}`);
    await f.store.succeedDelivery(f.delivery.id, "current");
    await f.r.catalog.reconcile();
    const before = (await f.db.query(
      `SELECT * FROM ${f.store.tables.events} ORDER BY position`,
    )).rows;
    await upgradeActionLifecycle(f.db, f.schema);
    await upgradeActionLifecycle(f.db, f.schema);
    await validateCopilotzSchema(f.db, f.schema);
    assertEquals(
      (await f.db.query(
        `SELECT * FROM ${f.store.tables.events} ORDER BY position`,
      )).rows,
      before,
    );
  });
}
