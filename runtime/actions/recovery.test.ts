import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createStreamOutputDescriptor } from "../streams/observation.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleLoader,
} from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { recoverDeliveryActions } from "./recovery.ts";
import { ActionOwnershipLost } from "./ownership.ts";

async function fixture(maxAttempts = 1) {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "action_recovery";
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const catalog = createOperationCatalog(db, schema);
  const published: string[] = [];
  let failRecoveryAt = 0;
  let recoveryWrites = 0;
  const store = createEventStore({
    session: db,
    schema,
    maxAttempts,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEvent: (tx, input) => catalog.indexEvent(tx, input),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
    lockSettlementScope: (tx, scope) => catalog.lockScope(tx, scope),
    settleActionOwners: (tx, delivery) =>
      recoverDeliveryActions(
        {
          store,
          catalog,
          actions: { work: { id: "work", execute: () => null } },
          coordinator: {
            ...coordinator,
            async commitMutation(input) {
              const result = await coordinator.commitMutation(input);
              recoveryWrites++;
              if (recoveryWrites === failRecoveryAt) {
                throw new Error("injected recovery failure");
              }
              return result;
            },
          },
        },
        tx,
        delivery,
      ),
  });
  const coordinator = createEventCoordinator({
    store,
    registry: {
      durableConsumers: (draft: { type: string }) =>
        draft.type.endsWith(".failed")
          ? [{ consumerId: "continuation", settlement: "inherit" }]
          : [],
    } as never,
    executor: { scheduleDelivery() {} } as never,
    publish: (event) => {
      if (event.durable) published.push(event.id);
    },
  });
  const root = await store.append({
    type: "root",
    namespace: "tenant",
    payload: {},
  }, ["worker", "sibling"]);
  const delivery = root.deliveries[0];
  assertExists(
    await store.claimDelivery({
      id: delivery.id,
      owner: "first",
      leaseMs: 60_000,
    }),
  );
  const lifecycle = (owner: string) =>
    createActionLifecycleEmitter({
      namespace: "tenant",
      metadata: { sourceDeliveryId: delivery.id },
      append: createActionLifecycleAppender({
        store,
        coordinator,
        writer: {
          kind: "delivery",
          deliveryId: delivery.id,
          leaseOwner: owner,
        },
      }),
      load: createActionLifecycleLoader({ store }),
    });
  const receipt = (run: string) => ({
    actionId: "work",
    actionRunId: run,
    input: { value: run },
    metadata: { original: true },
    settlementScopeId: root.event.id,
    correlationId: root.event.correlationId,
  });
  return {
    db,
    store,
    catalog,
    root,
    delivery,
    lifecycle,
    receipt,
    published,
    injectFailureAt: (n: number) => {
      failRecoveryAt = n;
      recoveryWrites = 0;
    },
    expire: () =>
      db.query(
        `UPDATE ${store.tables.event_deliveries} SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [delivery.id],
      ),
  };
}

Deno.test("final lease recovery atomically fails Actions and registers continuations before root settlement", async () => {
  const f = await fixture();
  try {
    const worker = f.lifecycle("first");
    for (const run of ["one", "two"]) {
      await worker.emit({
        ...f.receipt(run),
        status: "invoked",
        deduplicationId: `${run}:action:invoked`,
      });
    }
    const descriptor = createStreamOutputDescriptor({
      id: "stream",
      semanticId: "stream",
      mediaType: "text/plain",
      kind: "text",
      role: "output",
      metadata: { sourceDeliveryId: f.delivery.id },
    }, { namespace: "tenant" });
    await f.catalog.openStream({
      namespace: "tenant",
      operationId: f.root.event.id,
      semanticStreamId: "stream",
      bodyId: "stream-body",
      descriptor,
    });
    await f.expire();
    f.injectFailureAt(2);
    const before = f.published.length;
    await assertRejects(
      () => f.store.recoverExpiredDeliveries(),
      Error,
      "injected recovery failure",
    );
    assertEquals(
      f.published.length,
      before,
      "nothing is published from a rolled-back recovery",
    );
    assertEquals((await f.store.getDelivery(f.delivery.id))?.status, "leased");
    assertEquals(await worker.terminal("one"), null);
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.store.tables.open_actions}`)).rows
        .length,
      2,
    );
    f.injectFailureAt(0);
    assertEquals((await f.store.recoverExpiredDeliveries()).length, 1);
    assertEquals((await f.store.recoverExpiredDeliveries()).length, 0);
    for (const run of ["one", "two"]) {
      const terminal = await worker.terminal(run);
      assertEquals(terminal?.status, "failed");
      assertEquals(terminal?.input, { value: run });
      assertEquals(terminal?.metadata, { original: true });
    }
    assertEquals(
      (await f.db.query(`SELECT * FROM ${f.store.tables.open_actions}`)).rows
        .length,
      0,
    );
    const continuations = await f.store.listDeliveries({
      namespace: "tenant",
      consumerId: "continuation",
    });
    assertEquals(continuations.length, 2);
    assertEquals(
      await f.catalog.reconcile(),
      0,
      "sibling, streams and continuations still owe work",
    );
    await assertRejects(() =>
      worker.emit({
        ...f.receipt("one"),
        status: "completed",
        output: "zombie",
        deduplicationId: "one:action:terminal",
      })
    );
    assertEquals((await worker.terminal("one"))?.status, "failed");
    await f.catalog.markStreamUnavailable({
      namespace: "tenant",
      operationId: f.root.event.id,
      streamId: "stream",
      outcome: "failed",
      availability: "missing",
      capture: "truncated",
    });
    for (const delivery of continuations) {
      assertExists(
        await f.store.claimDelivery({
          id: delivery.id,
          owner: "continue",
          leaseMs: 60_000,
        }),
      );
      await f.store.succeedDelivery(delivery.id, "continue");
    }
    assertEquals(
      await f.catalog.reconcile(),
      0,
      "an idle sibling prevents early failure even with no stream open",
    );
    const sibling = f.root.deliveries[1];
    assertExists(
      await f.store.claimDelivery({
        id: sibling.id,
        owner: "sibling",
        leaseMs: 60_000,
      }),
    );
    await f.store.succeedDelivery(sibling.id, "sibling");
    assertEquals(await f.catalog.reconcile(), 1);
    assertEquals(
      (await f.catalog.get("tenant", f.root.event.id))?.state,
      "failed",
    );
    await assertRejects(
      () =>
        f.store.append({
          type: "late",
          namespace: "tenant",
          payload: {},
          settlementScopeId: f.root.event.id,
        }),
      Error,
      "was not inserted",
    );
  } finally {
    await f.db.close();
  }
});

Deno.test("retryable lease loss preserves the Action and fences the old attempt", async () => {
  const f = await fixture(2);
  try {
    const first = f.lifecycle("first");
    await first.emit({
      ...f.receipt("retry"),
      status: "invoked",
      deduplicationId: "retry:action:invoked",
    });
    await f.expire();
    assertEquals((await f.store.recoverExpiredDeliveries()).length, 0);
    assertEquals(await first.terminal("retry"), null);
    assertExists(
      await f.store.claimDelivery({
        id: f.delivery.id,
        owner: "second",
        leaseMs: 60_000,
      }),
    );
    const second = f.lifecycle("second");
    await second.emit({
      ...f.receipt("retry"),
      status: "invoked",
      deduplicationId: "retry:action:invoked",
    });
    await assertRejects(
      () =>
        first.emit({
          ...f.receipt("retry"),
          status: "progress",
          progress: "stale",
          progressIndex: 1,
          deduplicationId: "retry:action:progress:1",
        }),
      ActionOwnershipLost,
    );
    await second.emit({
      ...f.receipt("retry"),
      status: "completed",
      output: "success",
      deduplicationId: "retry:action:terminal",
    });
    await f.store.succeedDelivery(f.delivery.id, "second");
    assertEquals((await first.terminal("retry"))?.status, "completed");
  } finally {
    await f.db.close();
  }
});
