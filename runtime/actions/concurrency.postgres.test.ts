import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { scheduleResumptions } from "./continuation-work.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
function gate() {
  let resolve!: () => void;
  return {
    wait: new Promise<void>((r) => {
      resolve = r;
    }),
    open: () => resolve(),
  };
}

Deno.test({
  name:
    "PostgreSQL settlement rechecks child work admitted while waiting for its lock",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url, pgPoolMax: 4 });
    const schema = `settlement_race_${crypto.randomUUID().replaceAll("-", "")}`;
    const selected = gate();
    const release = gate();
    let pause = false;
    const session: SqlSession = {
      ...db,
      async query<T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) {
        const result = await db.query<T>(sql, params);
        if (
          pause &&
          sql.includes("ORDER BY operation.updated_at, operation.operation_id")
        ) {
          pause = false;
          selected.open();
          await release.wait;
        }
        return result;
      },
    };
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      const catalog = createOperationCatalog(session, schema);
      const store = createEventStore({
        session: db,
        schema,
        admitOperationEventSql: (input, param) =>
          catalog.admitEventSql(input, param),
        indexOperationEventSql: (input, param) =>
          catalog.indexEventSql(input, param),
      });
      const root = await store.append({
        namespace: "tenant",
        type: "test.root",
        payload: {},
      });
      pause = true;
      const settling = catalog.reconcile();
      await selected.wait;
      const child = await store.append({
        namespace: "tenant",
        type: "test.child",
        payload: {},
        settlementScopeId: root.event.id,
      }, ["child"]);
      release.open();
      assertEquals(await settling, 0);
      assertEquals(
        (await catalog.get("tenant", root.event.id))?.state,
        "running",
      );
      const delivery = child.deliveries[0];
      await store.claimDelivery({ id: delivery.id, owner: "current" });
      await store.succeedDelivery(delivery.id, "current");
      assertEquals(await catalog.reconcile(), 1);
      await assertRejects(() =>
        store.append({
          namespace: "tenant",
          type: "test.late",
          payload: {},
          settlementScopeId: root.event.id,
        })
      );
    } finally {
      release.open();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL continuation waits for child work admitted during settlement drain",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url, pgPoolMax: 4 });
    const schema = `detached_race_${crypto.randomUUID().replaceAll("-", "")}`;
    const selected = gate();
    const release = gate();
    let pause = false;
    const session = db;
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      const catalog = createOperationCatalog(db, schema, {
        beforeTerminal: async () => {
          if (pause) {
            pause = false;
            selected.open();
            await release.wait;
          }
        },
      });
      const store = createEventStore({
        session,
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
      const root = await store.commitMutation({
        draft: { namespace: "tenant", type: "test.root", payload: {} },
        consumers: [{ consumerId: "start", settlement: "detached" }],
      });
      const scope = root.deliveries[0].settlementScopeId;
      const delivery = root.deliveries[0];
      await store.claimDelivery({ id: delivery.id, owner: "current" });
      const lifecycle = createActionLifecycleEmitter({
        namespace: "tenant",
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
        actionId: "test.work",
        actionRunId: "work",
        input: {},
        metadata: {},
        settlementScopeId: scope,
        correlationId: root.event.id,
      };
      await lifecycle.emit({
        ...common,
        status: "invoked",
        deduplicationId: "work:action:invoked",
      });
      await lifecycle.emit({
        ...common,
        status: "awaiting",
        handoff: {},
        start: { action: "child", input: {} },
        progressIndex: 0,
        deduplicationId: "work:action:awaiting",
      });
      const childScope = "work:child";
      const [initial] = await store.listDeliveries({
        settlementScopeId: childScope,
      });
      await store.claimDelivery({ id: initial.id, owner: "child" });
      await store.succeedDelivery(initial.id, "child");
      pause = true;
      const settle = catalog.reconcile({ operationId: childScope });
      await selected.wait;
      const child = await store.append({
        namespace: "tenant",
        type: "test.child",
        payload: {},
        settlementScopeId: childScope,
      }, ["child"]);
      release.open();
      await settle;
      await (await scheduleResumptions({ store, coordinator, catalog }))();
      assertEquals(
        (await store.listDeliveries({
          consumerId: "runtime:action-continuation",
          settlementScopeId: scope,
        })).length,
        0,
      );
      await store.claimDelivery({ id: child.deliveries[0].id, owner: "child" });
      await store.succeedDelivery(child.deliveries[0].id, "child");
      await catalog.reconcile({ operationId: childScope });
      await (await scheduleResumptions({ store, coordinator, catalog }))();
      assertEquals(
        (await store.listDeliveries({
          consumerId: "runtime:action-continuation",
          settlementScopeId: scope,
        })).length,
        1,
      );
      await assertRejects(() =>
        store.append({
          namespace: "tenant",
          type: "test.late",
          payload: {},
          settlementScopeId: childScope,
        })
      );
    } finally {
      release.open();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL revoked delivery cannot mutate collections through an old context",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url });
    const schema = `writer_race_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const store = createEventStore({ session: db, schema });
      const root = await store.append({
        namespace: "tenant",
        type: "test.root",
        payload: {},
      }, ["worker"]);
      const id = root.deliveries[0].id;
      await store.claimDelivery({ id, owner: "old", leaseMs: 0 });
      assertExists(
        await store.claimDelivery({ id, owner: "new", leaseMs: 60_000 }),
      );
      let writes = 0;
      const mutate = (owner: string) =>
        store.commitMutation({
          consumers: [],
          draft: {
            namespace: "tenant",
            type: "test.write",
            payload: {},
            settlementScopeId: root.event.id,
            deliveryLease: { deliveryId: id, owner },
          },
          mutate: () => Promise.resolve(++writes),
        });
      await assertRejects(() => mutate("old"));
      assertEquals(writes, 0);
      await mutate("new");
      assertEquals(writes, 1);
      await store.succeedDelivery(id, "new");
      await assertRejects(() => mutate("new"));
      assertEquals(writes, 1);
    } finally {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
