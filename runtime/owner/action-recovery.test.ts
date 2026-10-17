import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlSession } from "../events/session.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createOperationCatalog } from "../streams/catalog.ts";
import { createOwnerOperationSettlement } from "./settlement.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCommandContext,
} from "./boundary.ts";
import {
  createOwnerActionRecovery,
  OWNER_ACTION_RECOVERY,
  ownerActionRecoveryKey,
} from "./action-recovery.ts";
import { ownerEffectKey } from "./effects-client.ts";
import {
  at,
  deferred,
  fixture,
  snapshot,
  within,
} from "./execution.fixture.test.ts";

async function recoveryFixture(
  effect: "none" | "begun" | "confirmed" | "not_started" = "none",
  cancelled = false,
) {
  const f = await fixture();
  await f.port().claim(f.hint(), {});
  if (effect !== "none") await f.effects().begin("send");
  if (effect === "confirmed") await f.effects().confirm("send", { id: "safe" });
  if (effect === "not_started") {
    await f.effects().notStarted("send", {
      source: "fixture",
      reference: "verified-no-start",
    });
  }
  await f.db.query(
    "UPDATE event_deliveries SET max_attempts=3,attempts=3 WHERE id=$1",
    [f.reference().deliveryId],
  );
  if (cancelled) {
    await f.db.query(
      "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE namespace='space' AND operation_id=$2",
      [at(500), f.source.event.id],
    );
  }
  const registry = createPluginRegistry({
    plugins: [definePlugin({
      id: "fixture",
      version: "1",
      actions: { work: Object.values(f.registry.actions)[0] },
      processors: {
        continuation: defineProcessor({
          id: "fixture.continuation",
          on: [{ eventType: "fixture.work.failed" }, {
            eventType: "fixture.work.cancelled",
          }],
          handle() {},
        }),
      },
    })],
  });
  const state = {
    time: at(1001),
    rollback: false,
    unknown: false,
    hold: false,
    authorized: true,
    failWakeAt: 0,
    errors: [] as unknown[],
    lateRegistration: undefined as
      | OwnerCommandContext["afterCommit"]
      | undefined,
    publications: [] as string[],
    scheduled: [] as string[],
    wakes: [] as string[],
  };
  const gate = { reached: deferred(), release: deferred() };
  const session: SqlSession = {
    query: f.db.query,
    async transaction(callback) {
      const result = await f.db.transaction(async (tx) => {
        const value = await callback(tx);
        if (state.rollback) {
          state.rollback = false;
          throw new Error("injected outer rollback");
        }
        if (state.hold) {
          state.hold = false;
          gate.reached.resolve();
          await gate.release.promise;
        }
        return value;
      });
      if (state.unknown) {
        state.unknown = false;
        throw new Error("lost COMMIT acknowledgement");
      }
      return result;
    },
  };
  const catalog = createOperationCatalog(f.db, "public");
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session,
    catalog,
    authorizeControl: () => false,
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake: (scope) => {
      state.wakes.push(scope.operationId);
      if (state.wakes.length === state.failWakeAt) {
        throw new Error("injected wake failure");
      }
    },
  });
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "no-business-dispatch",
    workloads: {},
    scheduleDelivery: (delivery) =>
      state.scheduled.push(
        typeof delivery === "string" ? delivery : delivery.id,
      ),
    dispatchWork: () => Promise.reject(new Error("must not dispatch")),
    dispatchDelivery: () => Promise.reject(new Error("must not dispatch")),
    dispatchRecoverable: () => Promise.reject(new Error("must not dispatch")),
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const recovery = createOwnerActionRecovery({
    ownerId: "owner",
    schema: "public",
    session,
    catalog,
    registry,
    executor,
    authorizeControl: (_tx, caller, namespace) =>
      state.authorized && caller.workerId === "owner-control" &&
      namespace === "space",
    async scheduleSettlement(context, scope) {
      await settlement.schedule(context, scope);
      state.lateRegistration = context.afterCommit;
    },
    publish: (event) => {
      state.publications.push(event.type);
    },
  });
  const makeBoundary = (holderId: string) =>
    createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId: "owner",
      holderId,
      now: () => state.time,
      handlers: recovery.handlers,
      authorize: recovery.authorize,
      onPostCommitError: (error) => {
        state.errors.push(error);
      },
      authenticateReceipt: (_tx, caller) => {
        assert.equal(caller.workerId, "owner-control");
      },
    });
  let boundary = makeBoundary("recovery-2");
  await boundary.acquire(1);
  const caller = () => ({
    workerId: "owner-control",
    ownerEpoch: boundary.epoch!,
  });
  const command = (occurrence = "tick-1") => ({
    kind: OWNER_ACTION_RECOVERY,
    domain: "occurrence" as const,
    key: ownerActionRecoveryKey("owner", "space", occurrence),
    intent: { namespace: "space", occurrence },
  });
  return {
    ...f,
    state,
    gate,
    caller,
    command,
    recovery,
    get recoveryBoundary() {
      return boundary;
    },
    recover: (occurrence?: string) =>
      boundary.execute(caller(), command(occurrence)),
    terminal: () =>
      createActionLifecycleLoader({ store: f.store })(
        "space",
        "run:action:terminal",
      ),
    effectsSnapshot: async () =>
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY key",
      )).rows,
    async seedExpiredScope(index: number) {
      await f.db.transaction(async (tx) => {
        const store = createEventStore({
          session: f.db,
          schema: "public",
          ownerCommit: {
            transaction: tx,
            ownerId: "owner",
            epoch: 2,
            holderId: "recovery-2",
            commandTime: at(1001),
            afterCommit() {
              throw new Error("seed must not publish");
            },
          },
          lockSettlementScope: (transaction, scope) =>
            catalog.lockScope(transaction, scope),
          admitOperationEventSql: (input, param) =>
            catalog.admitEventSql(input, param),
          indexOperationEvent: (transaction, input) =>
            catalog.indexEvent(transaction, input),
          indexOperationEventSql: (input, param) =>
            catalog.indexEventSql(input, param),
        });
        const source = await store.commitMutation({
          transaction: tx,
          draft: {
            type: "fixture.extra",
            namespace: "space",
            payload: {},
            deduplicationId: `extra-${index}`,
          },
          consumers: [{ consumerId: "extra", settlement: "inherit" }],
          maxAttempts: 1,
        });
        await store.claimDelivery({
          id: source.deliveries[0].id,
          owner: `extra-${index}`,
          leaseMs: 1,
        });
      });
      state.time = at(1003);
    },
    async successor() {
      const epoch = boundary.epoch!;
      boundary = makeBoundary("recovery-3");
      await boundary.acquire(epoch);
    },
    async close() {
      gate.release.resolve();
      boundary.stop();
      await f.close();
    },
  };
}

test("exhausted recovery retains effect evidence and atomically registers safe failure and ordinary continuation", async () => {
  for (const effect of ["none", "begun", "confirmed", "not_started"] as const) {
    const f = await recoveryFixture(effect);
    try {
      const evidence = await f.effectsSnapshot();
      assert.deepEqual((await f.recover()).result, {
        deliveryIds: [f.reference().deliveryId],
      });
      const terminal = await f.terminal();
      assert.equal(terminal?.status, "failed");
      if (terminal?.status === "failed") {
        assert.equal(
          terminal.error?.code,
          effect === "begun" ? "effect_indeterminate" : undefined,
        );
      }
      const delivery = await f.store.getDelivery(f.reference().deliveryId);
      assert.equal(delivery?.status, "dead_letter");
      assert.equal(delivery?.attempts, 3);
      assert.equal(delivery?.lastError?.name, "DeliveryLeaseExpired");
      assert.deepEqual(await f.effectsSnapshot(), evidence);
      assert.equal(
        (await f.db.query("SELECT * FROM open_actions")).rows.length,
        0,
      );
      assert.equal(
        (await f.db.query(
          "SELECT * FROM event_deliveries WHERE consumer_id='processor:fixture.continuation'",
        )).rows.length,
        1,
      );
      assert.equal(
        (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
        1,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(f.state.publications, ["fixture.work.failed"]);
      assert.equal(f.state.scheduled.length, 1);
      assert.equal(f.state.wakes.length, 1);
      assert.equal((await f.recover()).status, "duplicate");
      assert.deepEqual((await f.recover("tick-2")).result, { deliveryIds: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(f.state.publications.length, 1);
      assert.equal(f.state.scheduled.length, 1);
      assert.equal(f.state.wakes.length, 1);
    } finally {
      await f.close();
    }
  }
});

test("durable cancellation takes precedence over exhausted effects without changing their receipts", async () => {
  for (const effect of ["none", "begun", "confirmed"] as const) {
    const f = await recoveryFixture(effect, true);
    try {
      const evidence = await f.effectsSnapshot();
      await f.recover();
      const terminal = await f.terminal();
      assert.equal(terminal?.status, "cancelled");
      if (terminal?.status === "cancelled") {
        assert.equal(terminal.error?.name, "AbortError");
      }
      assert.deepEqual(await f.effectsSnapshot(), evidence);
      assert.equal(
        (await f.store.getDelivery(f.reference().deliveryId))?.lastError?.name,
        "DeliveryLeaseExpired",
      );
      assert.equal(
        (await f.db.query(
          "SELECT * FROM events WHERE deduplication_id='run:action:terminal'",
        )).rows.length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("recovery output, publication, ordinary continuation placement and wake wait for outer commit", async () => {
  const f = await recoveryFixture("begun");
  try {
    f.state.hold = true;
    let exposed = false;
    const pending = f.recover().then((value) => {
      exposed = true;
      return value;
    });
    await within(f.gate.reached.promise);
    assert.equal(exposed, false);
    assert.deepEqual(f.state.publications, []);
    assert.deepEqual(f.state.scheduled, []);
    assert.deepEqual(f.state.wakes, []);
    f.gate.release.resolve();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.state.publications.length, 1);
    assert.equal(f.state.wakes.length, 1);
  } finally {
    await f.close();
  }
});

test("recovery reauthorizes host control and epoch before duplicates; workers cannot sweep exhausted work", async () => {
  const f = await recoveryFixture("begun");
  try {
    await assert.rejects(
      f.recoveryBoundary.execute(
        { ...f.caller(), workerId: "worker" },
        f.command(),
      ),
      { code: "ActionOwnershipLost" },
    );
    await assert.rejects(
      f.recoveryBoundary.execute({ ...f.caller(), ownerEpoch: 1 }, f.command()),
      { code: "ActionOwnershipLost" },
    );
    await f.recover();
    f.state.authorized = false;
    await assert.rejects(f.recover(), { code: "ActionOwnershipLost" });
  } finally {
    await f.close();
  }
});

test("unknown recovery commit stays unknown, successor receipts resolve either durable outcome without dispatch", async () => {
  for (const rollback of [false, true]) {
    const f = await recoveryFixture("begun");
    try {
      const before = await snapshot(f.db);
      f.state.rollback = rollback;
      f.state.unknown = !rollback;
      await assert.rejects(f.recover(), { code: "owner_commit_unknown" });
      assert.equal(f.recoveryBoundary.state, "stopped");
      assert.deepEqual(f.state.publications, []);
      assert.deepEqual(f.state.scheduled, []);
      assert.deepEqual(f.state.wakes, []);
      if (rollback) assert.deepEqual(await snapshot(f.db), before);
      await f.successor();
      const receipt = await f.recoveryBoundary.readReceipt(f.caller(), {
        domain: "occurrence",
        key: f.command().key,
      });
      assert.equal(Boolean(receipt), !rollback);
      if (rollback) await f.recover();
      else assert.equal((await f.recover()).status, "duplicate");
      assert.equal((await f.terminal())?.status, "failed");
      assert.equal(
        (await f.db.query(
          "SELECT * FROM event_deliveries WHERE consumer_id='processor:fixture.continuation'",
        )).rows.length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("malformed or oversized effect inventory refuses the entire recovery command without partial terminal", async () => {
  for (const oversized of [false, true]) {
    const f = await recoveryFixture("begun");
    try {
      if (oversized) {
        for (let i = 0; i < 100; i++) {
          const ref = {
            namespace: "space",
            actionRunId: "run",
            step: `extra-${i}`,
          };
          await f.db.query(
            "INSERT INTO owner_receipts(owner,worker_id,domain,key,kind,intent,result) VALUES('owner','worker','logical',$1,'effect.begin',$2::jsonb,$3::jsonb)",
            [
              ownerEffectKey("owner", ref, "begin"),
              JSON.stringify(ref),
              JSON.stringify({ ...ref, status: "begun" }),
            ],
          );
        }
      } else {await f.db.query(
          "UPDATE owner_receipts SET kind='effect.invalid' WHERE kind='effect.begin'",
        );}
      const before = await snapshot(f.db);
      await assert.rejects(f.recover(), {
        code: oversized ? "effect_step_limit" : "effect_state_invalid",
      });
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(await f.terminal(), null);
      assert.deepEqual(f.state.publications, []);
    } finally {
      await f.close();
    }
  }
});

test("default recovery batch coalesces twenty distinct-scope settlement wakes within boundary capacity", async () => {
  const f = await recoveryFixture();
  try {
    for (let index = 0; index < 19; index++) await f.seedExpiredScope(index);
    const outcome = await f.recover();
    assert.equal(
      (outcome.result as { deliveryIds: string[] }).deliveryIds.length,
      20,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      20,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.state.wakes.length, 20);
  } finally {
    await f.close();
  }
});

test("failed wake does not starve other scopes and closed registration cannot add callbacks", async () => {
  const f = await recoveryFixture();
  try {
    await f.seedExpiredScope(1);
    f.state.failWakeAt = 1;
    await f.recover();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.state.wakes.length, 2);
    assert.equal(f.state.errors.length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      2,
    );
    assert.throws(
      () => f.state.lateRegistration!(() => {}),
      /registration is closed/,
    );
    assert.equal(f.state.wakes.length, 2);
  } finally {
    await f.close();
  }
});
