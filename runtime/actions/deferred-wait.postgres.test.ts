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
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import {
  rearmDeferredAction,
  registerDeferredWait,
  signalDeferredWait,
} from "./deferred-wait.ts";
import { advanceDeferredActions } from "./deferred-work.ts";
import { upgradeActionLifecycle } from "./upgrade.ts";
import { ActionOwnershipLost } from "./ownership.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

function waitRuntime(db: SqlSession, schema: string) {
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
      dispatchDelivery: async () => ({ done: Promise.resolve() }),
    } as never,
  });
  return { store, coordinator, catalog };
}

async function fixture() {
  if (!url) throw new Error("PostgreSQL test URL is required.");
  const db = await createTestDatabase({ url, pgPoolMax: 4 });
  const schema = `deferred_wait_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const runtime = waitRuntime(db, schema);
  const { store, coordinator } = runtime;
  const root = await store.append({
    namespace: "tenant",
    type: "test.root",
    payload: {},
  }, ["test.start"]);
  const delivery = root.deliveries[0];
  await store.claimDelivery({
    id: delivery.id,
    owner: "current",
    leaseMs: 60_000,
  });
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
    actionId: "test.wait",
    actionRunId: "waiting-action",
    input: {},
    metadata: {},
    settlementScopeId: delivery.settlementScopeId,
    correlationId: root.event.id,
  };
  await lifecycle.emit({
    ...common,
    status: "invoked",
    deduplicationId: "waiting-action:action:invoked",
  });
  const input = {
    namespace: "tenant",
    actionRunId: common.actionRunId,
    operationId: delivery.settlementScopeId,
    deliveryId: delivery.id,
    leaseOwner: "current",
    waitKey: "checkpoint:synthetic",
    timeoutMs: 60_000,
  };
  return {
    db,
    schema,
    store,
    runtime,
    input,
    delivery,
    common,
    lifecycle,
    async close() {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  ignore: !url,
  name:
    "PostgreSQL durable wait: upgrade preserves in-flight v6 action and immutable history",
  async fn() {
    const f = await fixture();
    try {
      await f.db.query(
        `ALTER TABLE ${f.store.tables.open_actions} DROP COLUMN wait_key, DROP COLUMN wait_signaled, DROP COLUMN wait_expires_at, DROP COLUMN resolve_generation`,
      );
      await f.db.query(
        `UPDATE ${f.store.tables.copilotz_schema_metadata} SET version=6`,
      );
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
      const row = (await f.db.query(
        `SELECT state,owner_delivery_id,wait_key,wait_signaled,resolve_generation FROM ${f.store.tables.open_actions}`,
      )).rows[0];
      assertEquals(row, {
        state: "invoked",
        owner_delivery_id: f.delivery.id,
        wait_key: null,
        wait_signaled: false,
        resolve_generation: 0,
      });
      await registerDeferredWait(f.runtime, f.input);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  ignore: !url,
  name: "PostgreSQL durable wait: a signal before deferral is not lost",
  async fn() {
    const f = await fixture();
    try {
      await registerDeferredWait(f.runtime, f.input);
      assertEquals(
        await signalDeferredWait(f.runtime, "tenant", f.input.waitKey),
        1,
      );
      await f.lifecycle.emit({
        ...f.common,
        status: "deferred",
        work: { checkpointId: "synthetic" },
        progressIndex: 0,
        deduplicationId: "waiting-action:action:deferred",
      });
      await f.store.succeedDelivery(f.delivery.id, "current");
      await (await advanceDeferredActions(f.runtime))();
      assertEquals(
        (await f.store.listDeliveries({
          consumerId: "runtime:action-resolver",
        }))
          .length,
        1,
      );
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  ignore: !url,
  name: "PostgreSQL durable wait: a fresh runtime recovers a persisted wait",
  async fn() {
    const f = await fixture();
    let replacement: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    try {
      await registerDeferredWait(f.runtime, f.input);
      await f.lifecycle.emit({
        ...f.common,
        status: "deferred",
        work: { checkpointId: "synthetic" },
        progressIndex: 0,
        deduplicationId: "waiting-action:action:deferred",
      });
      await f.store.succeedDelivery(f.delivery.id, "current");
      await f.db.close();
      replacement = await createTestDatabase({ url: url!, pgPoolMax: 2 });
      const runtime = waitRuntime(replacement, f.schema);
      await (await advanceDeferredActions(runtime))();
      assertEquals(
        await runtime.store.listDeliveries({
          consumerId: "runtime:action-resolver",
        }),
        [],
      );
      await signalDeferredWait(runtime, "tenant", f.input.waitKey);
      await signalDeferredWait(runtime, "tenant", f.input.waitKey);
      assertEquals(
        (await runtime.store.listDeliveries({
          consumerId: "runtime:action-resolver",
        }))
          .length,
        1,
      );
      assertEquals(
        (await replacement.query(
          `SELECT state, resolve_generation FROM ${runtime.store.tables.open_actions}`,
        )).rows,
        [{ state: "resolving", resolve_generation: 0 }],
      );
    } finally {
      if (replacement) {
        await replacement.query(`DROP SCHEMA "${f.schema}" CASCADE`);
        await replacement.close();
      } else {
        await f.close();
      }
    }
  },
});

Deno.test({
  ignore: !url,
  name:
    "PostgreSQL durable wait: stale lease cannot replace a wait after reclaim",
  async fn() {
    const f = await fixture();
    try {
      await registerDeferredWait(f.runtime, f.input);
      await f.db.query(
        `UPDATE ${f.store.tables.event_deliveries} SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,
        [f.delivery.id],
      );
      await f.store.claimDelivery({
        id: f.delivery.id,
        owner: "replacement",
        leaseMs: 60_000,
      });
      await assertRejects(
        () =>
          registerDeferredWait(f.runtime, {
            ...f.input,
            waitKey: "stale-writer",
          }),
        ActionOwnershipLost,
      );
      assertEquals(
        (await f.db.query(
          `SELECT wait_key FROM ${f.store.tables.open_actions}`,
        )).rows[0].wait_key,
        f.input.waitKey,
      );
      await registerDeferredWait(f.runtime, {
        ...f.input,
        leaseOwner: "replacement",
        waitKey: "current-writer",
      });
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  ignore: !url,
  name:
    "PostgreSQL durable wait: expiry rearm creates one later resolver without holding a lease",
  async fn() {
    const f = await fixture();
    try {
      await registerDeferredWait(f.runtime, f.input);
      await f.lifecycle.emit({
        ...f.common,
        status: "deferred",
        work: { checkpointId: "synthetic" },
        progressIndex: 0,
        deduplicationId: "waiting-action:action:deferred",
      });
      await f.store.succeedDelivery(f.delivery.id, "current");
      await (await advanceDeferredActions(f.runtime))();
      assertEquals(
        await f.store.listDeliveries({ consumerId: "runtime:action-resolver" }),
        [],
      );
      assertEquals(
        await signalDeferredWait(f.runtime, "another-tenant", f.input.waitKey),
        0,
      );
      assertEquals(
        await signalDeferredWait(f.runtime, "tenant", "another-checkpoint"),
        0,
      );
      await f.db.query(
        `UPDATE ${f.store.tables.open_actions} SET wait_expires_at=NOW()-INTERVAL '1 second'`,
      );
      await (await advanceDeferredActions(f.runtime))();
      let resolvers = await f.store.listDeliveries({
        consumerId: "runtime:action-resolver",
      });
      assertEquals(resolvers.length, 1);
      const first = resolvers[0];
      await f.store.claimDelivery({
        id: first.id,
        owner: "resolver",
        leaseMs: 60_000,
      });
      const resolverInput = {
        ...f.input,
        deliveryId: first.id,
        leaseOwner: "resolver",
      };
      await registerDeferredWait(f.runtime, resolverInput);
      await rearmDeferredAction(f.runtime, resolverInput);
      await f.store.succeedDelivery(first.id, "resolver");
      await assertRejects(
        () => rearmDeferredAction(f.runtime, resolverInput),
        ActionOwnershipLost,
      );
      const waiting = (await f.db.query(
        `SELECT state,owner_delivery_id,resolve_generation FROM ${f.store.tables.open_actions}`,
      )).rows[0];
      assertEquals(waiting, {
        state: "deferred",
        owner_delivery_id: null,
        resolve_generation: 1,
      });
      await Promise.all([
        signalDeferredWait(f.runtime, "tenant", f.input.waitKey),
        signalDeferredWait(f.runtime, "tenant", f.input.waitKey),
      ]);
      resolvers = await f.store.listDeliveries({
        consumerId: "runtime:action-resolver",
      });
      assertEquals(
        resolvers.length,
        2,
        "Duplicate signals must admit only one new resolver",
      );
      assertEquals(new Set(resolvers.map((row) => row.id)).size, 2);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  ignore: !url,
  name:
    "PostgreSQL durable wait: v6 upgrade failure rolls back new columns and preserves its owner",
  async fn() {
    const f = await fixture();
    try {
      await f.db.query(
        `ALTER TABLE ${f.store.tables.open_actions} DROP COLUMN wait_key, DROP COLUMN wait_signaled, DROP COLUMN wait_expires_at, DROP COLUMN resolve_generation`,
      );
      await f.db.query(
        `UPDATE ${f.store.tables.copilotz_schema_metadata} SET version=6`,
      );
      const failing: SqlSession = {
        ...f.db,
        transaction: (run) =>
          f.db.transaction((transaction) =>
            run({
              query(sql, params) {
                if (sql.includes("SET version = $1")) {
                  throw new Error("injected schema marker failure");
                }
                return transaction.query(sql, params);
              },
            })
          ),
      };
      await assertRejects(
        () => upgradeActionLifecycle(failing, f.schema),
        Error,
        "injected schema marker failure",
      );
      assertEquals(
        (await f.db.query(
          `SELECT version FROM ${f.store.tables.copilotz_schema_metadata}`,
        )).rows,
        [{ version: 6 }],
      );
      assertEquals(
        (await f.db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='open_actions' AND column_name=ANY($2::text[])`,
          [f.schema, [
            "wait_key",
            "wait_signaled",
            "wait_expires_at",
            "resolve_generation",
          ]],
        )).rows,
        [],
      );
      assertEquals(
        (await f.db.query(
          `SELECT state,owner_delivery_id FROM ${f.store.tables.open_actions}`,
        )).rows,
        [{ state: "invoked", owner_delivery_id: f.delivery.id }],
      );
      await upgradeActionLifecycle(f.db, f.schema);
      await registerDeferredWait(f.runtime, f.input);
    } finally {
      await f.close();
    }
  },
});
