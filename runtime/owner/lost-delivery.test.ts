import { recoverDeliveryActions } from "../actions/recovery.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { createEventCoordinator } from "../events/coordinator.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import {
  deferred,
  fixture as executionFixture,
  within,
} from "./execution.fixture.test.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import {
  createEventStore,
  type OwnerLostDeliveryTransition,
} from "../events/store.ts";
import type { EventDelivery } from "../events/types.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCommandContext,
  type OwnerJson,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const start = "2020-01-01T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(start) + ms).toISOString();
const json = (value: unknown): OwnerJson => JSON.parse(JSON.stringify(value));
async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const statement of createCoreSchemaStatements("public")) {
    await db.query(statement);
  }
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const catalog = createOperationCatalog(db, "public");
  const state = {
    time: start,
    rollback: false,
    unknown: false,
    settlementFails: false,
    settlements: [] as string[],
    published: [] as string[],
    locks: [] as string[],
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const result = await db.transaction(async (tx) => {
        const result = await run(tx);
        if (state.rollback) {
          state.rollback = false;
          throw new Error("injected rollback");
        }
        return result;
      });
      if (state.unknown) {
        state.unknown = false;
        throw new Error("lost COMMIT acknowledgement");
      }
      return result;
    },
  };
  const store = createEventStore({ session: db, schema: "public" });
  const commandStore = (context: OwnerCommandContext) =>
    createEventStore({
      session,
      schema: "public",
      ownerCommit: { ...context.ownerCommit, afterCommit: context.afterCommit },
      async lockSettlementScope(tx, scope) {
        state.locks.push(scope);
        await catalog.lockScope(tx, scope);
      },
      admitOperationEventSql: (value, param) =>
        catalog.admitEventSql(value, param),
      indexOperationEventSql: (value, param) =>
        catalog.indexEventSql(value, param),
      indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
      async settleActionOwners(tx, delivery) {
        state.settlements.push(delivery.status);
        if (state.settlementFails) {
          throw new Error("injected settlement refusal");
        }
        // This primitive test records the canonical settlement callback in the
        // same transaction. The lost-Action composition tests use real lifecycle writers.
        await tx.query(
          "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,$2)",
          [`settled:${delivery.id}`, context.commandTime],
        );
        return () => {
          state.published.push(delivery.status);
          return Promise.resolve();
        };
      },
    });
  const createBoundary = (epoch: number) =>
    createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId: "owner",
      holderId: `holder-${epoch}`,
      now: () => state.time,
      handlers: {
        async seed(_input, context) {
          const result = await commandStore(context).commitMutation({
            transaction: context.tx,
            draft: {
              type: "requested",
              namespace: "space",
              payload: {},
              deduplicationId: "source",
            },
            consumers: [{
              consumerId: "registered:work",
              settlement: "inherit",
            }],
          });
          return json(result.deliveries[0]);
        },
        async claim(input, context) {
          return json(
            await commandStore(context).claimDelivery(
              input as { id: string; owner: string; leaseMs: number },
            ),
          );
        },
        async recover(input, context) {
          return json(
            await commandStore(context).recoverLostDelivery(
              input as OwnerLostDeliveryTransition,
            ),
          );
        },
      },
      authorize(_tx, caller) {
        if (caller.principal.kind !== "owner-control") {
          throw new Error("control required");
        }
      },
      authenticateReceipt() {
        throw new Error("no ambient receipt authority");
      },
    });
  const caller = (epoch: number) => ({
    principal: {
      kind: "owner-control" as const,
      ownerId: "owner",
      epoch,
      holderId: `holder-${epoch}`,
    },
    ownerEpoch: epoch,
  });
  const first = createBoundary(1);
  await first.acquire(0);
  const delivery = (await first.execute(caller(1), {
    kind: "seed",
    domain: "logical",
    key: "seed",
    intent: {},
  })).result as unknown as EventDelivery;
  const claimed = (await first.execute(caller(1), {
    kind: "claim",
    domain: "incarnation",
    key: "claim:first",
    intent: { id: delivery.id, owner: "attempt-1", leaseMs: 10_000 },
  })).result as unknown as EventDelivery;
  const transition: OwnerLostDeliveryTransition = {
    namespace: "space",
    id: delivery.id,
    eventId: delivery.eventId,
    consumerId: delivery.consumerId,
    settlementScopeId: delivery.settlementScopeId,
    leaseOwner: "attempt-1",
    leaseExpiresAt: claimed.leaseExpiresAt!,
    attempts: claimed.attempts,
    maxAttempts: claimed.maxAttempts,
    disposition: "retry",
  };
  state.time = at(100);
  const second = createBoundary(2);
  await second.acquire(1);
  const command = (
    value: OwnerLostDeliveryTransition = transition,
    key = crypto.randomUUID(),
  ) => ({
    kind: "recover",
    domain: "occurrence" as const,
    key,
    intent: json(value),
  });
  return {
    db,
    store,
    state,
    first,
    second,
    caller,
    claimed,
    transition,
    command,
    recover: (value = transition) => second.execute(caller(2), command(value)),
    createBoundary,
    async close() {
      first.stop();
      second.stop();
      await db.close();
    },
  };
}

test("owner lost transition requeues the exact unexpired attempt without consuming budget or changing availability", async () => {
  const f = await fixture();
  try {
    assert.equal(f.claimed.maxAttempts, 3);
    assert.equal(f.claimed.leaseExpiresAt, at(10_000));
    // Retained scheduling/error fields are not rewritten by loss classification.
    const retainedError = {
      name: "PreviousFailure",
      message: "retained evidence",
    };
    await f.db.query(
      "UPDATE event_deliveries SET available_at=$1,last_error=$2::jsonb WHERE id=$3",
      [at(50), JSON.stringify(retainedError), f.claimed.id],
    );
    const command = f.command();
    const result = (await f.second.execute(f.caller(2), command))
      .result as unknown as EventDelivery;
    assert.equal(result.status, "retry_wait");
    assert.equal(result.availableAt, at(50));
    assert.deepEqual(result.lastError, retainedError);
    assert.equal(result.attempts, 1);
    assert.equal(result.maxAttempts, 3);
    assert.equal(result.leaseOwner, undefined);
    assert.equal(result.leaseExpiresAt, undefined);
    assert.deepEqual(f.state.settlements, []);
    assert.equal(
      (await f.second.execute(f.caller(2), command)).status,
      "duplicate",
    );
    assert.equal(f.state.locks.length, 1);
    const next = (await f.second.execute(f.caller(2), {
      kind: "claim",
      domain: "incarnation",
      key: "claim:second",
      intent: { id: result.id, owner: "attempt-2", leaseMs: 10_000 },
    })).result as unknown as EventDelivery;
    assert.equal(next.attempts, 2);
    assert.equal(next.leaseOwner, "attempt-2");
    assert.equal(
      (await f.recover()).result,
      null,
      "a stale selector cannot recover the successor",
    );
  } finally {
    await f.close();
  }
});

test("lost transition preserves exact coordinates and refuses legacy/local or hookless stores", async () => {
  const f = await fixture();
  try {
    for (
      const changed of [
        { id: "other" },
        { namespace: "other" },
        { eventId: "other" },
        { consumerId: "other" },
        { settlementScopeId: "other" },
        { actionScopeId: "other" },
        { leaseOwner: "other" },
        { leaseExpiresAt: at(9999) },
        { attempts: 2 },
        { maxAttempts: 4 },
        { disposition: "exhausted" as const },
      ]
    ) {
      assert.equal(
        (await f.recover({ ...f.transition, ...changed })).result,
        null,
      );
      assert.deepEqual(await f.store.getDelivery(f.claimed.id), f.claimed);
    }
    await assert.rejects(f.store.recoverLostDelivery(f.transition), {
      code: "event_transaction_unavailable",
    });
    await f.db.transaction(async (tx) => {
      const ownerCommit = {
        transaction: tx,
        ownerId: "owner",
        epoch: 2,
        holderId: "holder-2",
        commandTime: at(100),
        afterCommit() {},
      };
      const local = createEventStore({
        session: f.db,
        ownerCommit: {
          ...ownerCommit,
          localAttempt: { deliveryId: f.claimed.id, attemptId: "attempt-1" },
        },
      });
      await assert.rejects(local.recoverLostDelivery(f.transition), {
        code: "event_transaction_unavailable",
      });
      const hookless = createEventStore({ session: f.db, ownerCommit });
      await assert.rejects(hookless.recoverLostDelivery(f.transition), {
        code: "event_transaction_unavailable",
      });
    });
    await assert.rejects(f.first.execute(f.caller(1), f.command()), {
      code: "ActionOwnershipLost",
    });
  } finally {
    await f.close();
  }
});

test("exhausted and cancelled lost transitions use atomic settlement and do not alter retry counters", async () => {
  for (const disposition of ["exhausted", "cancelled"] as const) {
    const f = await fixture();
    try {
      if (disposition === "exhausted") {
        await f.db.query(
          "UPDATE event_deliveries SET attempts=max_attempts WHERE id=$1",
          [f.claimed.id],
        );
      }
      const transition = {
        ...f.transition,
        disposition,
        attempts: disposition === "exhausted" ? 3 : 1,
      };
      const result = (await f.recover(transition))
        .result as unknown as EventDelivery;
      assert.equal(
        result.status,
        disposition === "exhausted" ? "dead_letter" : "cancelled",
      );
      assert.equal(result.attempts, transition.attempts);
      assert.equal(result.maxAttempts, 3);
      assert.equal(result.availableAt, f.claimed.availableAt);
      assert.equal(result.settledAt, at(100));
      assert.deepEqual(f.state.settlements, [result.status]);
      assert.equal(
        (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
        1,
      );
      if (disposition === "exhausted") {
        assert.equal(
          (result.lastError as { name: string }).name,
          "DeliveryLeaseExpired",
        );
      }
    } finally {
      await f.close();
    }
  }
});

test("outer rollback and settlement refusal retain the exact lost row and publish nothing", async () => {
  for (const failure of ["rollback", "settlement"] as const) {
    const f = await fixture();
    try {
      if (failure === "rollback") f.state.rollback = true;
      else f.state.settlementFails = true;
      await assert.rejects(
        f.recover({ ...f.transition, disposition: "cancelled" }),
      );
      assert.deepEqual(await f.store.getDelivery(f.claimed.id), f.claimed);
      assert.deepEqual(f.state.published, []);
      assert.equal(
        (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
        0,
      );
      if (failure === "rollback") assert.equal(f.second.state, "stopped");
      else assert.equal(f.second.state, "acquired");
    } finally {
      await f.close();
    }
  }
});

test("lost transition COMMIT uncertainty stops the boundary and leaves committed retry state discoverable", async () => {
  const f = await fixture();
  let third: ReturnType<typeof createOwnerCommandBoundary> | undefined;
  try {
    const command = f.command();
    f.state.unknown = true;
    await assert.rejects(f.second.execute(f.caller(2), command), {
      code: "owner_commit_unknown",
    });
    assert.equal(f.second.state, "stopped");
    third = f.createBoundary(3);
    await third.acquire(2);
    const current = await f.store.getDelivery(f.claimed.id);
    assert.equal(current?.status, "retry_wait");
    assert.equal(current?.attempts, 1);
    assert.equal(current?.availableAt, f.claimed.availableAt);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_receipts WHERE key=$1", [
        command.key,
      ])).rows.length,
      1,
    );
  } finally {
    third?.stop();
    await f.close();
  }
});

test("lost exhausted/cancelled settlement preserves canonical Action terminals, consumers and begun effects", async () => {
  for (const cancelled of [false, true]) {
    const f = await executionFixture({ allowRecovery: () => true });
    let boundary: ReturnType<typeof createOwnerCommandBoundary> | undefined;
    try {
      await f.port().claim(f.hint(), {});
      await f.effects().begin("send");
      await f.db.query(
        "UPDATE event_deliveries SET attempts=3,max_attempts=3 WHERE id=$1",
        [f.reference().deliveryId],
      );
      if (cancelled) {
        await f.db.query(
          "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE namespace='space' AND operation_id=$2",
          [at(100), f.source.event.id],
        );
      }
      const catalog = createOperationCatalog(f.db, "public");
      const registry = createPluginRegistry({
        actions: f.registry.actions,
        processors: {
          after: defineProcessor({
            id: "after",
            on: [{ eventType: "fixture.work.failed" }, {
              eventType: "fixture.work.cancelled",
            }],
            handle() {},
          }),
        },
      });
      const scheduled: string[] = [];
      const publicationErrors: unknown[] = [];
      const observed = deferred();
      const executor: DeliveryExecutor = {
        ownership: "injected_dispatcher",
        workload: "schedule-only",
        workloads: {},
        scheduleDelivery(delivery) {
          scheduled.push(typeof delivery === "string" ? delivery : delivery.id);
        },
        dispatchWork: () => Promise.reject(new Error("must not execute")),
        dispatchDelivery: () => Promise.reject(new Error("must not execute")),
        dispatchRecoverable: () =>
          Promise.reject(new Error("must not execute")),
        settleOutputs: () => Promise.resolve(),
        awaitScopeProgress: () => Promise.resolve(false),
        shutdown: () => Promise.resolve(),
      };
      boundary = createOwnerCommandBoundary({
        session: f.db,
        schema: "public",
        ownerId: "owner",
        holderId: "recovery",
        now: () => at(100),
        onPostCommitError: (error) => publicationErrors.push(error),
        handlers: {
          async recover(_intent, context) {
            const store = createEventStore({
              session: f.db,
              schema: "public",
              ownerCommit: {
                ...context.ownerCommit,
                afterCommit: context.afterCommit,
              },
              lockSettlementScope: (tx, scope) => catalog.lockScope(tx, scope),
              admitOperationEventSql: (value, param) =>
                catalog.admitEventSql(value, param),
              indexOperationEventSql: (value, param) =>
                catalog.indexEventSql(value, param),
              indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
              settleActionOwners: async (tx, delivery) => {
                const publish = await recoverDeliveryActions(
                  {
                    store,
                    coordinator,
                    catalog,
                    actions: registry.actions,
                    commandTime: context.commandTime,
                    ...(cancelled
                      ? {
                        deliveryCancellation: {
                          namespace: "space",
                          operationId: delivery.settlementScopeId,
                        },
                      }
                      : {}),
                    async hasUnresolvedEffect(transaction, reference) {
                      return (await readOwnerEffectInventory(transaction, {
                        ...reference,
                        ownerId: "owner",
                        schema: "public",
                      })).some((effect) => effect.status === "begun");
                    },
                  },
                  tx,
                  delivery,
                );
                return async () => {
                  await publish();
                  observed.resolve();
                };
              },
            });
            const coordinator = createEventCoordinator({
              store,
              registry,
              executor,
              scheduleOnly: true,
            });
            const delivery =
              (await store.getDelivery(f.reference().deliveryId))!;
            const transition: OwnerLostDeliveryTransition = {
              namespace: "space",
              id: delivery.id,
              eventId: delivery.eventId,
              consumerId: delivery.consumerId,
              settlementScopeId: delivery.settlementScopeId,
              ...(delivery.actionScopeId
                ? { actionScopeId: delivery.actionScopeId }
                : {}),
              leaseOwner: delivery.leaseOwner!,
              leaseExpiresAt: delivery.leaseExpiresAt!,
              attempts: delivery.attempts,
              maxAttempts: delivery.maxAttempts,
              disposition: cancelled ? "cancelled" : "exhausted",
            };
            return json(await store.recoverLostDelivery(transition));
          },
        },
        authorize(_tx, caller) {
          if (caller.principal.kind !== "owner-control") {
            throw new Error("control required");
          }
        },
        authenticateReceipt() {
          throw new Error("no ambient receipt authority");
        },
      });
      await boundary.acquire(1);
      const caller = {
        principal: {
          kind: "owner-control" as const,
          ownerId: "owner",
          epoch: 2,
          holderId: "recovery",
        },
        ownerEpoch: 2,
      };
      const command = {
        kind: "recover",
        domain: "occurrence" as const,
        key: "recover",
        intent: {},
      };
      const recovered = await boundary.execute(caller, command);
      assert.equal(
        (recovered.result as unknown as EventDelivery | null)?.status,
        cancelled ? "cancelled" : "dead_letter",
      );
      assert.deepEqual(publicationErrors, []);
      const terminal = await createActionLifecycleLoader({ store: f.store })(
        "space",
        "run:action:terminal",
      );
      assert.equal(terminal?.status, cancelled ? "cancelled" : "failed");
      if (terminal?.status === "failed") {
        assert.equal(terminal.error.code, "effect_indeterminate");
      }
      if (terminal?.status === "cancelled") {
        assert.equal(terminal.error.name, "AbortError");
      }
      assert.deepEqual(
        await readOwnerEffectInventory(f.db, {
          ownerId: "owner",
          schema: "public",
          namespace: "space",
          actionRunId: "run",
        }),
        [{ step: "send", status: "begun" }],
      );
      assert.equal(
        (await f.db.query("SELECT * FROM open_actions")).rows.length,
        0,
      );
      const consumers = await f.db.query<
        { id: string; status: string; settlement_scope_id: string }
      >("SELECT id,status,settlement_scope_id FROM event_deliveries WHERE consumer_id='processor:after'");
      assert.equal(consumers.rows.length, 1);
      assert.equal(
        consumers.rows[0].status,
        cancelled ? "cancelled" : "pending",
      );
      assert.equal(consumers.rows[0].settlement_scope_id, f.source.event.id);
      await within(observed.promise);
      assert.deepEqual(publicationErrors, []);
      const expectedScheduled = cancelled ? [] : [consumers.rows[0].id];
      assert.deepEqual(scheduled, expectedScheduled);
      assert.equal(
        (await boundary.execute(caller, command)).status,
        "duplicate",
      );
      assert.deepEqual(scheduled, expectedScheduled);
    } finally {
      boundary?.stop();
      await f.close();
    }
  }
});
