import {
  insertTestOwnerBody,
  insertTestOwnerStream,
} from "../testing/owner-catalog.ts";
import { provisionOwnerContentCatalog } from "../streams/owner-catalog-schema.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlSession } from "../events/session.ts";
import {
  createOwnerOperationCatalogCore,
  type OperationSettlementScope,
} from "../streams/catalog.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandContext,
  type OwnerJson,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerOperationSettlement,
  OWNER_OPERATION_READINESS,
  OWNER_OPERATION_SETTLED_EVENT,
  OWNER_OPERATION_SETTLEMENT,
  ownerOperationSettlementKey,
  type OwnerSettlementDrain,
} from "./settlement.ts";

const start = "2099-01-01T00:00:00.000Z";
const end = "2099-01-02T00:00:00.000Z";
const unavailable: SqlSession = {
  query() {
    throw new Error("ambient query forbidden");
  },
  transaction() {
    throw new Error("ambient transaction forbidden");
  },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
async function within(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(
  limits: {
    contentLifecycle?: "owner";
    drainTimeoutMs?: number;
    maxOutstandingDrains?: number;
    maxConcurrentChecks?: number;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOwnerContentCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const state = {
    time: start,
    allowed: true,
    mutateCallbacks: false,
    callbackViews: [] as {
      stage: string;
      target: OperationSettlementScope;
      caller?: OwnerCaller;
      ref?: OwnerSettlementDrain;
    }[],
    drainAllowed: true,
    refs: [] as OwnerSettlementDrain[],
    drained: [] as string[],
    publications: [] as { type: string; gated: boolean; seq?: string }[],
    wakes: [] as OperationSettlementScope[],
    duringDrain: async () => {},
    rejectOuter: false,
    rejectSavepoint: false,
    loseReply: false,
    gateNext: false,
    gated: false,
    gateReached: deferred(),
    gateRelease: deferred(),
    published: deferred(),
    statements: [] as string[],
    streamRace: undefined as OperationSettlementScope | undefined,
    bodyRace: false,
    rejectProtection: false,
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(operation) {
      const result = await db.transaction(async (tx) => {
        const value = await operation({
          async query(sql, params) {
            state.statements.push(sql);
            if (state.rejectSavepoint && sql.startsWith("RELEASE SAVEPOINT")) {
              state.rejectSavepoint = false;
              throw new Error("savepoint rollback");
            }
            if (
              state.streamRace &&
              sql.includes(
                'UPDATE "public"."copilotz_operations" AS operation SET state=$3',
              )
            ) {
              const target = state.streamRace;
              state.streamRace = undefined;
              await insertTestOwnerStream(tx, target, {
                revocation: "revoked",
              });
            }
            if (
              state.bodyRace &&
              sql.includes(
                'UPDATE "public"."copilotz_operations" AS operation SET state=$3',
              )
            ) {
              state.bodyRace = false;
              await tx.query("UPDATE copilotz_operation_bodies SET digest=$1", [
                `sha256:${"b".repeat(64)}`,
              ]);
            }
            if (
              state.rejectProtection &&
              sql.includes(
                'UPDATE "public"."copilotz_operation_bodies" AS body SET',
              )
            ) {
              state.rejectProtection = false;
              throw new Error("protection update rejected");
            }
            return await tx.query(sql, params);
          },
        });
        if (state.rejectOuter) {
          state.rejectOuter = false;
          throw new Error("outer rollback");
        }
        if (state.gateNext) {
          state.gateNext = false;
          state.gated = true;
          state.gateReached.resolve();
          await state.gateRelease.promise;
          state.gated = false;
        }
        return value;
      });
      if (state.loseReply) {
        state.loseReply = false;
        throw Object.assign(new Error("lost COMMIT reply"), {
          indeterminate: true,
        });
      }
      return result;
    },
  };
  function observeCallback(
    stage: string,
    target: OperationSettlementScope,
    caller?: OwnerCaller,
    ref?: OwnerSettlementDrain,
  ) {
    if (!state.mutateCallbacks) return;
    state.callbackViews.push(
      structuredClone({
        stage,
        target,
        ...(caller ? { caller } : {}),
        ...(ref ? { ref } : {}),
      }),
    );
    Object.assign(target, {
      namespace: "substitute",
      operationId: "substitute",
    });
    if (caller) Object.assign(caller.principal, { holderId: "substitute" });
    if (ref) {
      Object.assign(ref, {
        deliveryId: "substitute",
        dispatchAttemptId: "substitute",
      });
    }
  }
  const catalog = createOwnerOperationCatalogCore(unavailable, "public");
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session: unavailable,
    catalog,
    ...limits,
    authorizeControl(_tx, caller, target) {
      observeCallback("control", target, caller);
      return state.allowed;
    },
    selectDrains(_tx, caller, target) {
      observeCallback("select", target, caller);
      return state.refs.filter((ref) => !ref.deliveryId.startsWith("other:"));
    },
    authorizeDrain(_tx, caller, target, ref) {
      observeCallback("authorize-drain", target, caller, ref);
      return state.drainAllowed;
    },
    async drain(target, ref) {
      assert.equal(state.gated, false);
      state.drained.push(ref.deliveryId);
      observeCallback("drain", target, undefined, ref);
      await state.duringDrain();
      return state.drainAllowed;
    },
    wake(target) {
      state.wakes.push({ ...target });
      observeCallback("wake", target);
    },
    publish(event) {
      state.publications.push({
        type: event.type,
        gated: state.gated,
        ...(event.durable ? { seq: event.seq } : {}),
      });
      state.published.resolve();
    },
  });
  const store = (ctx: OwnerCommandContext, deliveryId?: string) =>
    createEventStore({
      session: unavailable,
      ownerCommit: {
        ...ctx.ownerCommit,
        afterCommit: ctx.afterCommit,
        ...(deliveryId === undefined ? {} : {
          ownerAttempt: { deliveryId, attemptId: `attempt:${deliveryId}` },
        }),
      },
      assertOperationCatalog: catalog.assertFormat,
      admitOperationEventSql: catalog.admitEventSql,
      indexOperationEventSql: catalog.indexEventSql,
      indexOperationEvent: catalog.indexEvent,
    });
  function boundary(holder = "first") {
    return createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId: "owner",
      holderId: holder,
      now: () => state.time,
      handlers: {
        ...settlement.handlers,
        seed: async (data, ctx): Promise<OwnerJson> => {
          const input = data as {
            namespace: string;
            parent?: string;
            status?: string;
          };
          const runtime = store(ctx);
          const result = await runtime.commitMutation({
            transaction: ctx.tx,
            draft: {
              type: "test.root",
              namespace: input.namespace,
              payload: {},
              metadata: { threadId: "thread" },
              ...(input.parent ? { settlementScopeId: input.parent } : {}),
              deduplicationId: ctx.command.key,
            },
            consumers: [{ consumerId: "test.action", settlement: "inherit" }],
          });
          const target = {
            namespace: input.namespace,
            operationId: input.parent ?? result.event.id,
          };
          const delivery = result.deliveries[0];
          if (input.status !== "pending") {
            const deliveryRuntime = store(ctx, delivery.id);
            await deliveryRuntime.claimDelivery({
              id: delivery.id,
              owner: `attempt:${delivery.id}`,
            });
            if (input.status === "failed") {
              await deliveryRuntime.failDelivery({
                id: delivery.id,
                owner: `attempt:${delivery.id}`,
                error: { name: "Failure", message: "failed" },
                retryable: false,
              });
            } else if (input.status === "cancelled") {
              await deliveryRuntime.cancelDelivery(
                delivery.id,
                `attempt:${delivery.id}`,
              );
            } else {
              await deliveryRuntime.succeedDelivery(
                delivery.id,
                `attempt:${delivery.id}`,
              );
            }
          }
          await settlement.schedule(ctx, target);
          return {
            ...target,
            eventId: result.event.id,
            deliveryId: delivery.id,
          };
        },
        succeed: async (data, ctx) => {
          const input = data as {
            namespace: string;
            operationId: string;
            deliveryId: string;
          };
          const runtime = store(ctx, input.deliveryId);
          await runtime.claimDelivery({
            id: input.deliveryId,
            owner: `attempt:${input.deliveryId}`,
          });
          await runtime.succeedDelivery(
            input.deliveryId,
            `attempt:${input.deliveryId}`,
          );
          await settlement.schedule(ctx, {
            namespace: input.namespace,
            operationId: input.operationId,
          });
          return null;
        },
        cancel: async (data, ctx) => {
          const target = data as OperationSettlementScope;
          await catalog.assertFormat(ctx.tx);
          await ctx.tx.query(
            "UPDATE copilotz_operations SET cancellation_requested_at=$3::timestamptz,updated_at=$3::timestamptz WHERE namespace=$1 AND operation_id=$2",
            [target.namespace, target.operationId, ctx.commandTime],
          );
          await settlement.schedule(ctx, target);
          return null;
        },
      },
      projections: settlement.projections,
      authorize(tx, caller, command, time) {
        if (command.kind.startsWith("operation.")) {
          return settlement.authorize(tx, caller, command, time);
        }
      },
      authenticateReceipt() {},
    });
  }
  const owner = boundary();
  await owner.acquire(0);
  const caller: OwnerCaller = {
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "first",
    },
    ownerEpoch: 1,
  };
  let count = 0;
  async function seed(
    input: { namespace?: string; parent?: string; status?: string } = {},
  ) {
    const result = await owner.execute(caller, {
      kind: "seed",
      domain: "occurrence",
      key: `seed:${++count}`,
      intent: { namespace: "space", ...input },
    });
    return result.result as {
      namespace: string;
      operationId: string;
      eventId: string;
      deliveryId: string;
    };
  }
  async function run(
    target: OperationSettlementScope,
    occurrence = `check:${++count}`,
  ) {
    state.time = end;
    return await settlement.run({
      boundary: owner,
      caller,
      target: { namespace: target.namespace, operationId: target.operationId },
      occurrence,
    });
  }
  async function status(target: OperationSettlementScope) {
    return (await db.query(
      "SELECT state,updated_at,completed_at FROM copilotz_operations WHERE namespace=$1 AND operation_id=$2",
      [target.namespace, target.operationId],
    )).rows[0];
  }
  const events = () =>
    db.query("SELECT * FROM events WHERE type=$1", [
      OWNER_OPERATION_SETTLED_EVENT,
    ]);
  return {
    db,
    state,
    owner,
    caller,
    settlement,
    catalog,
    seed,
    run,
    status,
    events,
    boundary,
  };
}

test("owner settlement drains outside command loop and terminalizes with catalog event, sequence and receipt behind outer commit", async () => {
  const f = await fixture();
  try {
    const root = await f.seed();
    f.state.refs = [{
      deliveryId: root.deliveryId,
      dispatchAttemptId: "attempt",
    }];
    const ready = await f.owner.project(f.caller, OWNER_OPERATION_READINESS, {
      namespace: root.namespace,
      operationId: root.operationId,
    }) as { ticket: OwnerJson };
    assert.equal((await f.status(root)).state, "accepted");
    f.state.time = end;
    f.state.gateNext = true;
    const command: OwnerCommand = {
      kind: OWNER_OPERATION_SETTLEMENT,
      domain: "occurrence",
      key: ownerOperationSettlementKey("owner", root, "once"),
      intent: { occurrence: "once", ticket: ready.ticket },
    };
    const pending = f.owner.execute(f.caller, command);
    await within(f.state.gateReached.promise);
    assert.equal(f.state.publications.length, 0);
    f.state.gateRelease.resolve();
    assert.deepEqual((await pending).result, {
      status: "terminal",
      state: "completed",
    });
    await within(f.state.published.promise);
    assert.equal(f.state.publications.length, 1);
    assert.equal(f.state.publications[0].gated, false);
    assert.equal(
      new Date((await f.status(root)).completed_at as string).toISOString(),
      end,
    );
    assert.equal((await f.events()).rows.length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      0,
    );
    assert.equal(
      (await f.owner.execute(f.caller, command)).status,
      "duplicate",
    );
    assert.equal((await f.events()).rows.length, 1);
    assert.deepEqual(
      (await f.db.query("SELECT seq::text FROM events ORDER BY seq")).rows.map(
        (r) => r.seq,
      ),
      ["1", "2"],
    );
    assert.ok(
      !f.state.statements.some((s) => /NOW\(\)/i.test(s)),
      "all owner lifecycle SQL uses commandTime",
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("owner settlement retains newly admitted work during drain, including work that also finishes", async () => {
  for (const childStatus of ["pending", "succeeded"]) {
    const f = await fixture();
    try {
      const root = await f.seed();
      f.state.refs = [{
        deliveryId: root.deliveryId,
        dispatchAttemptId: "attempt",
      }];
      let child: Awaited<ReturnType<typeof f.seed>> | undefined;
      f.state.duringDrain = async () => {
        if (!child) {
          child = await f.seed({
            parent: root.operationId,
            status: childStatus,
          });
        }
      };
      assert.deepEqual(await f.run(root), { status: "pending" });
      assert.equal((await f.events()).rows.length, 0);
      assert.ok(
        ["accepted", "running"].includes(
          (await f.status(root)).state as string,
        ),
      );
      if (childStatus === "pending") {
        await f.owner.execute(f.caller, {
          kind: "succeed",
          domain: "occurrence",
          key: "child:done",
          intent: {
            namespace: child!.namespace,
            operationId: child!.operationId,
            deliveryId: child!.deliveryId,
          },
        });
      }
      f.state.duringDrain = async () => {};
      f.state.refs.push({
        deliveryId: child!.deliveryId,
        dispatchAttemptId: "child",
      });
      assert.deepEqual(await f.run(root), {
        status: "terminal",
        state: "completed",
      });
      assert.ok(f.state.drained.includes(child!.deliveryId));
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  }
});

test("owner settlement keeps failed-child and cancellation precedence while draining successful siblings", async () => {
  for (const scenario of ["failed", "child-cancelled", "scope-cancelled"]) {
    const f = await fixture();
    try {
      const root = await f.seed();
      await f.seed({
        parent: root.operationId,
        status: scenario === "failed" ? "failed" : "cancelled",
      });
      f.state.refs = [{
        deliveryId: root.deliveryId,
        dispatchAttemptId: "attempt",
      }];
      if (scenario === "scope-cancelled") {
        await f.owner.execute(f.caller, {
          kind: "cancel",
          domain: "occurrence",
          key: "cancel",
          intent: { namespace: root.namespace, operationId: root.operationId },
        });
      }
      assert.deepEqual(await f.run(root), {
        status: "terminal",
        state: scenario === "scope-cancelled" ? "cancelled" : "failed",
      });
      assert.deepEqual(f.state.drained, [root.deliveryId]);
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  }
});

test("owner settlement drain failure, revocation and takeover cannot terminalize or publish", async () => {
  for (
    const scenario of [
      "drain-failure",
      "control-revocation",
      "attempt-revocation",
      "takeover",
    ]
  ) {
    const f = await fixture();
    let successor: ReturnType<typeof f.boundary> | undefined;
    try {
      const root = await f.seed();
      f.state.refs = [{
        deliveryId: root.deliveryId,
        dispatchAttemptId: "attempt",
      }];
      f.state.duringDrain = async () => {
        if (scenario === "drain-failure") {
          throw new Error("output drain failed");
        }
        if (scenario === "control-revocation") f.state.allowed = false;
        if (scenario === "attempt-revocation") f.state.drainAllowed = false;
        if (scenario === "takeover") {
          successor = f.boundary("second");
          await successor.acquire(1);
        }
      };
      await assert.rejects(f.run(root));
      assert.equal((await f.events()).rows.length, 0);
      assert.equal((await f.status(root)).state, "accepted");
      assert.equal(f.state.publications.length, 0);
      assert.equal(
        (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
        1,
      );
    } finally {
      f.owner.stop();
      successor?.stop();
      await f.db.close();
    }
  }
});

test("owner settlement savepoint/outer rollback and lost COMMIT preserve atomic catalog/event/receipt/sequence", async () => {
  for (const scenario of ["savepoint", "rollback", "lost"]) {
    const f = await fixture();
    let successor: ReturnType<typeof f.boundary> | undefined;
    try {
      const root = await f.seed();
      const target = {
        namespace: root.namespace,
        operationId: root.operationId,
      };
      const prepared = await f.owner.project(
        f.caller,
        OWNER_OPERATION_READINESS,
        target,
      ) as { ticket: OwnerJson };
      const command: OwnerCommand = {
        kind: OWNER_OPERATION_SETTLEMENT,
        domain: "occurrence",
        key: ownerOperationSettlementKey("owner", target, "commit"),
        intent: { occurrence: "commit", ticket: prepared.ticket },
      };
      f.state.time = end;
      if (scenario === "savepoint") f.state.rejectSavepoint = true;
      else if (scenario === "rollback") f.state.rejectOuter = true;
      else f.state.loseReply = true;
      await assert.rejects(f.owner.execute(f.caller, command));
      assert.equal(f.state.publications.length, 0);
      assert.equal((await f.events()).rows.length, scenario === "lost" ? 1 : 0);
      assert.equal(
        (await f.status(root)).state,
        scenario === "lost" ? "completed" : "accepted",
      );
      assert.equal(
        (await f.db.query("SELECT last_seq::text AS seq FROM owner_epochs"))
          .rows[0].seq,
        scenario === "lost" ? "2" : "1",
      );
      if (scenario === "savepoint") {
        await f.owner.execute(f.caller, command);
      } else {
        // The adapter did not attest an outer rollback. Both outcomes stop the
        // holder; a successor resolves the durable fact through receipts.
        assert.equal(f.owner.state, "stopped");
        successor = f.boundary("second");
        await successor.acquire(1);
        const successorCaller: OwnerCaller = {
          principal: {
            kind: "owner-control",
            ownerId: "owner",
            epoch: 2,
            holderId: "second",
          },
          ownerEpoch: 2,
        };
        await assert.rejects(
          successor.readReceipt(successorCaller, {
            domain: "occurrence",
            key: command.key,
          }),
          { code: "owner_receipt_principal_refused" },
        );
        // SQL is a fixture witness only. Successor settlement uses its named control route.
        const receipt = (await f.db.query<{ result: OwnerJson }>(
          "SELECT result FROM owner_receipts WHERE owner='owner' AND domain='occurrence' AND key=$1",
          [command.key],
        )).rows[0];
        if (scenario === "lost") {
          assert.deepEqual(receipt?.result, {
            status: "terminal",
            state: "completed",
          });
        } else {
          assert.equal(receipt, undefined);
          assert.deepEqual(
            await f.settlement.run({
              boundary: successor,
              caller: successorCaller,
              target,
              occurrence: "successor-check",
            }),
            { status: "terminal", state: "completed" },
          );
        }
      }
      assert.equal((await f.events()).rows.length, 1);
      assert.equal(
        (await f.db.query("SELECT last_seq::text AS seq FROM owner_epochs"))
          .rows[0].seq,
        "2",
      );
    } finally {
      f.owner.stop();
      successor?.stop();
      await f.db.close();
    }
  }
});

test("owner drain waits coalesce and stay charged after timeout until real settlement", async () => {
  const f = await fixture({ drainTimeoutMs: 200, maxOutstandingDrains: 1 });
  const gate = deferred();
  try {
    const root = await f.seed();
    f.state.refs = [{
      deliveryId: root.deliveryId,
      dispatchAttemptId: "attempt",
    }];
    f.state.duringDrain = () => gate.promise;
    const one = f.run(root, "one");
    const two = f.run(root, "two");
    await Promise.all([
      assert.rejects(one, { code: "owner_settlement_timeout" }),
      assert.rejects(two, { code: "owner_settlement_timeout" }),
    ]);
    assert.deepEqual(f.state.drained, [root.deliveryId]);
    assert.equal((await f.events()).rows.length, 0);
    const other = await f.seed();
    f.state.refs = [{
      deliveryId: other.deliveryId,
      dispatchAttemptId: "other",
    }];
    await assert.rejects(f.run(other), { code: "owner_admission_refused" });
    assert.equal(f.state.drained.length, 1);
    f.state.refs = [{
      deliveryId: root.deliveryId,
      dispatchAttemptId: "attempt",
    }];
    gate.resolve();
    assert.deepEqual(await f.run(root), {
      status: "terminal",
      state: "completed",
    });
    assert.equal(
      f.state.drained.length,
      1,
      "the completed reservation remains identifiable and reused through terminalization",
    );
    f.state.refs = [{
      deliveryId: other.deliveryId,
      dispatchAttemptId: "other",
    }];
    assert.deepEqual(await f.run(other), {
      status: "terminal",
      state: "completed",
    });
    assert.equal(f.state.drained.length, 2);
  } finally {
    gate.resolve();
    f.owner.stop();
    await f.db.close();
  }
});

test("owner drain caller abort is bounded and does not free a noncooperative reservation", async () => {
  const f = await fixture({ maxConcurrentChecks: 1, maxOutstandingDrains: 1 });
  const entered = deferred();
  const gate = deferred();
  try {
    const root = await f.seed();
    const target = { namespace: root.namespace, operationId: root.operationId };
    f.state.refs = [{
      deliveryId: root.deliveryId,
      dispatchAttemptId: "attempt",
    }];
    f.state.duringDrain = () => {
      entered.resolve();
      return gate.promise;
    };
    const controller = new AbortController();
    const pending = f.settlement.run({
      boundary: f.owner,
      caller: f.caller,
      target,
      occurrence: "abort",
      signal: controller.signal,
    });
    await within(entered.promise);
    await assert.rejects(f.run(root), { code: "owner_admission_refused" });
    controller.abort(new Error("caller detached"));
    await assert.rejects(pending, /caller detached/);
    assert.equal(f.state.drained.length, 1);
    assert.equal((await f.events()).rows.length, 0);
    gate.resolve();
    assert.deepEqual(await f.run(root), {
      status: "terminal",
      state: "completed",
    });
    assert.equal(f.state.drained.length, 1);
  } finally {
    gate.resolve();
    f.owner.stop();
    await f.db.close();
  }
});

test("owner settlement waits for delivery and open Action obligations", async () => {
  const f = await fixture();
  try {
    const root = await f.seed({ status: "pending" });
    assert.deepEqual(await f.run(root), { status: "pending" });
    for (const status of ["leased", "retry_wait"]) {
      await f.db.query("UPDATE event_deliveries SET status=$2 WHERE id=$1", [
        root.deliveryId,
        status,
      ]);
      assert.deepEqual(await f.run(root), { status: "pending" });
    }
    await f.db.query(
      "UPDATE event_deliveries SET status='succeeded' WHERE id=$1",
      [root.deliveryId],
    );
    await f.db.query(
      "INSERT INTO open_actions(namespace,action_run_id,action_id,scope_id,invoked_event_id,state) VALUES($1,'open-run','work',$2,$3,'invoked')",
      [root.namespace, root.operationId, root.eventId],
    );
    assert.deepEqual(await f.run(root), { status: "pending" });
    await f.db.query("DELETE FROM open_actions WHERE action_run_id='open-run'");
    assert.deepEqual(await f.run(root), {
      status: "terminal",
      state: "completed",
    });
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("owner settlement refuses every stream state before live and terminal shortcuts", async () => {
  for (
    const state of ["reserving", "open", "terminating", "terminal"] as const
  ) {
    for (const operationTerminal of [false, true]) {
      const f = await fixture();
      try {
        const root = await f.seed();
        if (operationTerminal) await f.run(root);
        await insertTestOwnerStream(f.db, root, {
          state,
          revocation: "revoked",
        });
        const before =
          (await f.db.query("SELECT * FROM copilotz_operation_streams")).rows;
        const operation = await f.status(root);
        const events = (await f.events()).rows;
        const receipts =
          (await f.db.query("SELECT * FROM owner_receipts")).rows;
        await assert.rejects(
          f.run(root),
          /Owner content settlement is not yet supported/,
        );
        assert.deepEqual(
          (await f.db.query("SELECT * FROM copilotz_operation_streams")).rows,
          before,
        );
        assert.deepEqual(await f.status(root), operation);
        assert.deepEqual((await f.events()).rows, events);
        assert.deepEqual(
          (await f.db.query("SELECT * FROM owner_receipts")).rows,
          receipts,
        );
      } finally {
        f.owner.stop();
        await f.db.close();
      }
    }
  }
});

test("owner final settlement guard rolls back lifecycle, sequence and receipt if a hidden stream appears", async () => {
  const f = await fixture();
  try {
    const root = await f.seed();
    const before = (await f.db.query("SELECT * FROM copilotz_operations")).rows;
    const receipts = (await f.db.query("SELECT * FROM owner_receipts")).rows;
    f.state.streamRace = root;
    await assert.rejects(f.run(root), /admitted work inside terminalization/);
    assert.equal(f.state.streamRace, undefined);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM copilotz_operations")).rows,
      before,
    );
    assert.deepEqual(
      (await f.db.query("SELECT * FROM owner_receipts")).rows,
      receipts,
    );
    assert.equal((await f.events()).rows.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM copilotz_operation_streams")).rows
        .length,
      0,
    );
    assert.equal(f.state.publications.length, 0);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("owner settlement rejects wrong-namespace and non-successful drain references", async () => {
  const f = await fixture();
  try {
    const root = await f.seed();
    const other = await f.seed({ namespace: "another" });
    f.state.refs = [{
      deliveryId: other.deliveryId,
      dispatchAttemptId: "other",
    }];
    await assert.rejects(f.run(root), { code: "ActionOwnershipLost" });
    assert.deepEqual(f.state.drained, []);
    f.state.refs = [{ deliveryId: root.deliveryId, dispatchAttemptId: "root" }];
    await f.db.query(
      "UPDATE event_deliveries SET status='dead_letter' WHERE id=$1",
      [root.deliveryId],
    );
    await assert.rejects(f.run(root), { code: "ActionOwnershipLost" });
    assert.deepEqual(f.state.drained, []);
    assert.equal((await f.events()).rows.length, 0);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("rejected ambiguous output drain is never reinvoked for the same reservation", async () => {
  const f = await fixture();
  try {
    const root = await f.seed();
    f.state.refs = [{
      deliveryId: root.deliveryId,
      dispatchAttemptId: "attempt",
    }];
    f.state.duringDrain = () =>
      Promise.reject(Object.assign(new Error("lost during flush"), {
        indeterminate: true,
      }));
    for (const occurrence of ["first-flush", "retry-flush"]) {
      await assert.rejects(f.run(root, occurrence), /lost during flush/);
    }
    assert.deepEqual(f.state.drained, [root.deliveryId]);
    assert.equal((await f.events()).rows.length, 0);
    assert.equal((await f.status(root)).state, "accepted");
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("settlement deadline bounds a noncooperative readiness call and keeps its check slot charged", async () => {
  const f = await fixture({ drainTimeoutMs: 50, maxConcurrentChecks: 1 });
  let resume!: (value: OwnerJson) => void;
  const held = new Promise<OwnerJson>((resolve) => resume = resolve);
  try {
    const root = await f.seed();
    const target = { namespace: root.namespace, operationId: root.operationId };
    const prepared = await f.owner.project(
      f.caller,
      OWNER_OPERATION_READINESS,
      target,
    );
    const pending = f.settlement.run({
      boundary: {
        project: () => held,
        execute: () => {
          throw new Error("must not submit after timeout");
        },
      },
      caller: f.caller,
      target,
      occurrence: "read-hung",
    });
    await assert.rejects(pending, { code: "owner_settlement_timeout" });
    await assert.rejects(f.run(root), { code: "owner_admission_refused" });
    assert.equal((await f.events()).rows.length, 0);
    resume(prepared);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await f.run(root), {
      status: "terminal",
      state: "completed",
    });
  } finally {
    resume({ status: "pending" });
    f.owner.stop();
    await f.db.close();
  }
});

test("settlement deadline during noncooperative COMMIT is unknown and retains check capacity until resolution", async () => {
  const f = await fixture({ drainTimeoutMs: 200, maxConcurrentChecks: 1 });
  try {
    const root = await f.seed();
    const target = { namespace: root.namespace, operationId: root.operationId };
    const pending = f.settlement.run({
      boundary: {
        project: f.owner.project,
        execute: (caller, command, options) => {
          f.state.gateNext = true;
          return f.owner.execute(caller, command, options);
        },
      },
      caller: f.caller,
      target,
      occurrence: "commit-hung",
    });
    await within(f.state.gateReached.promise);
    await assert.rejects(pending, {
      code: "owner_settlement_unknown",
      indeterminate: true,
    });
    await assert.rejects(f.run(root), { code: "owner_admission_refused" });
    assert.equal(f.state.publications.length, 0);
    f.state.gateRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(
      f.owner.readReceipt(f.caller, {
        domain: "occurrence",
        key: ownerOperationSettlementKey("owner", target, "commit-hung"),
      }),
      { code: "owner_receipt_principal_refused" },
    );
    const receipt = (await f.db.query<{ result: OwnerJson }>(
      "SELECT result FROM owner_receipts WHERE owner='owner' AND domain='occurrence' AND key=$1",
      [ownerOperationSettlementKey("owner", target, "commit-hung")],
    )).rows[0];
    assert.deepEqual(receipt?.result, {
      status: "terminal",
      state: "completed",
    });
    assert.equal((await f.events()).rows.length, 1);
  } finally {
    f.state.gateRelease.resolve();
    f.owner.stop();
    await f.db.close();
  }
});

test("settlement requires tagged control even with permissive host policy", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.settlement.authorize(f.db, {
        principal: { kind: "worker", workerId: "owner:owner" },
        ownerEpoch: 1,
      }, {
        kind: OWNER_OPERATION_READINESS,
        domain: "occurrence",
        key: "read",
        intent: { namespace: "space", operationId: "root" },
      }, end),
      { code: "ActionOwnershipLost" },
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("settlement callbacks cannot redirect actual catalog drain event or receipt scope", async () => {
  const f = await fixture();
  try {
    f.state.mutateCallbacks = true;
    const root = await f.seed();
    const target = { namespace: root.namespace, operationId: root.operationId };
    const ref = {
      deliveryId: root.deliveryId,
      dispatchAttemptId: `attempt:${root.deliveryId}`,
    };
    f.state.refs = [ref];
    assert.deepEqual(await f.run(target, "isolated"), {
      status: "terminal",
      state: "completed",
    });
    await within(f.state.published.promise);
    assert.equal((await f.status(target)).state, "completed");
    assert.deepEqual(f.state.drained, [root.deliveryId]);
    assert.deepEqual(f.state.wakes, [target]);
    assert.deepEqual(
      new Set(f.state.callbackViews.map((view) => view.stage)),
      new Set(["control", "select", "authorize-drain", "drain", "wake"]),
    );
    for (const view of f.state.callbackViews) {
      assert.deepEqual(view.target, target, view.stage);
      if (view.caller) assert.deepEqual(view.caller, f.caller, view.stage);
      if (view.ref) assert.deepEqual(view.ref, ref, view.stage);
    }
    const events = (await f.events()).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].namespace, "space");
    assert.deepEqual(
      (await f.db.query(
        "SELECT result FROM owner_receipts WHERE owner='owner' AND key=$1",
        [ownerOperationSettlementKey("owner", target, "isolated")],
      )).rows[0].result,
      { status: "terminal", state: "completed" },
    );
    assert.equal(
      (await f.db.query(
        "SELECT * FROM copilotz_operations WHERE namespace='substitute'",
      )).rows.length,
      0,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

// Structural settlement fixtures: physical sealing itself is exercised through
// the actual coordinator suite, not synthesized by this helper.
async function acceptedBody(
  f: Awaited<ReturnType<typeof fixture>>,
  root: Awaited<ReturnType<typeof f.seed>>,
) {
  await insertTestOwnerStream(f.db, root, {
    state: "terminal",
    revocation: "revoked",
  });
  const binding = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "first",
    attemptId: `attempt:${root.deliveryId}`,
    namespace: root.namespace,
    sourceEventId: root.eventId,
    deliveryId: root.deliveryId,
    kind: "processor",
    processorId: "fixture",
    consumerId: "test.action",
  };
  const digest =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  await f.db.query(
    'UPDATE copilotz_operation_streams SET outcome=\'completed\',capture=\'complete\',digest=$1,committed_offset=0,asset_retention=\'observation\',placement_binding=$2::jsonb,descriptor=descriptor || \'{"mediaType":"text/plain","kind":"text","role":"assistant","metadata":{}}\'::jsonb',
    [digest, JSON.stringify(binding)],
  );
  await insertTestOwnerBody(f.db, root);
  await f.db.query(
    "UPDATE copilotz_operation_bodies SET producer_stream_id='unsupported-stream',producer=$1::jsonb,protected_until=$2,pending_descriptor=pending_descriptor||'{\"metadata\":{}}'::jsonb",
    [
      JSON.stringify({
        kind: "processor",
        processorId: "fixture",
        sourceEventId: root.eventId,
        deliveryId: root.deliveryId,
        deliveryAttempt: 1,
      }),
      start,
    ],
  );
  await f.db.query(
    "UPDATE copilotz_operations SET next_stream_ordinal=2 WHERE operation_id=$1",
    [root.operationId],
  );
}
async function protection(f: Awaited<ReturnType<typeof fixture>>) {
  const row = (await f.db.query(
    "SELECT protected_until::text AS deadline FROM copilotz_operation_bodies WHERE logical_body_id='logical-fixture'",
  )).rows[0];
  return new Date(String(row.deadline)).toISOString();
}
test("owner content settlement extends pending protection from actual completion for every outcome", async () => {
  for (const outcome of ["completed", "failed", "cancelled"]) {
    const f = await fixture({ contentLifecycle: "owner" });
    try {
      const root = await f.seed(
        outcome === "failed" ? { status: "failed" } : {},
      );
      await acceptedBody(f, root);
      if (outcome === "cancelled") {
        await f.db.query(
          "UPDATE copilotz_operations SET cancellation_requested_at=$1",
          [end],
        );
      }
      await f.run(root);
      assert.equal((await f.status(root)).state, outcome);
      assert.equal(await protection(f), "2099-01-03T00:00:00.000Z");
      f.state.time = "2099-01-05T00:00:00.000Z";
      await f.settlement.run({
        boundary: f.owner,
        caller: f.caller,
        target: { namespace: root.namespace, operationId: root.operationId },
        occurrence: "later-replay",
      });
      assert.equal(await protection(f), "2099-01-03T00:00:00.000Z");
      assert.equal((await f.events()).rows.length, 1);
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  }
});
test("owner content settlement preserves longer protection, adopted bodies and missing physical availability", async () => {
  const f = await fixture({ contentLifecycle: "owner" });
  try {
    const root = await f.seed();
    await acceptedBody(f, root);
    await f.db.query(
      "UPDATE copilotz_operation_bodies SET protected_until='2100-01-01T00:00:00Z',adoption_key='slot',adoption_fingerprint=$1,asset_id='asset',domain_owner_id='message',domain_owner_type='message',current_copy=$2::jsonb",
      [
        `sha256:${"c".repeat(64)}`,
        JSON.stringify({
          backendId: "promoted",
          key: "new-copy",
          versionToken: "new-version",
        }),
      ],
    );
    await f.db.query(
      "UPDATE copilotz_operation_streams SET availability='missing'",
    );
    await f.run(root);
    assert.equal((await f.status(root)).state, "completed");
    assert.equal(await protection(f), "2100-01-01T00:00:00.000Z");
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});
test("owner content settlement rejects contradictory, ambiguous and missing logical bodies", async () => {
  const f = await fixture({ contentLifecycle: "owner" });
  try {
    const root = await f.seed();
    await acceptedBody(f, root);
    const original =
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows[0];
    const patches = {
      digest: `sha256:${"b".repeat(64)}`,
      byte_length: 1,
      media_type: "image/png",
      settlement_scope_id: "other",
      owner_id: "other",
      producer: JSON.stringify({ kind: "processor", processorId: "other" }),
      pending_descriptor: JSON.stringify({}),
      retired_at: end,
    };
    for (const [field, value] of Object.entries(patches)) {
      const isJson = ["producer", "pending_descriptor"].includes(field);
      const cast = isJson ? "::jsonb" : "";
      await f.db.query(
        `UPDATE copilotz_operation_bodies SET ${field}=$1${cast}`,
        [value],
      );
      assert.deepEqual(await f.run(root), { status: "pending" });
      assert.equal((await f.status(root)).state, "accepted");
      await f.db.query(
        `UPDATE copilotz_operation_bodies SET ${field}=$1${cast}`,
        [
          isJson ? JSON.stringify(original[field]) : original[field],
        ],
      );
      const ready = await f.owner.project(f.caller, OWNER_OPERATION_READINESS, {
        namespace: root.namespace,
        operationId: root.operationId,
      }) as { status: string };
      assert.equal(ready.status, "ready");
    }
    await f.db.query("UPDATE copilotz_operation_streams SET owner_id='other'");
    await f.db.query("UPDATE copilotz_operation_bodies SET owner_id='other'");
    assert.deepEqual(await f.run(root), { status: "pending" });
    await f.db.query("UPDATE copilotz_operation_streams SET owner_id='owner'");
    await f.db.query("UPDATE copilotz_operation_bodies SET owner_id='owner'");
    // The schema prevents duplicates; also prove fail-closed completion if an
    // external corruption removes the index while this fixture owner is live.
    await assert.rejects(
      f.db.query(
        "INSERT INTO copilotz_operation_bodies SELECT (jsonb_populate_record(NULL::copilotz_operation_bodies,to_jsonb(body)||jsonb_build_object('logical_body_id','duplicate','pending_ref','duplicate'))).* FROM copilotz_operation_bodies body",
      ),
    );
    await f.db.query("DROP INDEX copilotz_operation_bodies_stream_idx");
    await f.db.query(
      "INSERT INTO copilotz_operation_bodies SELECT (jsonb_populate_record(NULL::copilotz_operation_bodies,to_jsonb(body)||jsonb_build_object('logical_body_id','duplicate','pending_ref','duplicate'))).* FROM copilotz_operation_bodies body",
    );
    assert.deepEqual(await f.run(root), { status: "pending" });
    await f.db.query("DELETE FROM copilotz_operation_bodies");
    assert.deepEqual(await f.run(root), { status: "pending" });
    assert.equal((await f.events()).rows.length, 0);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});
test("owner content final guard and protection failure roll back the lifecycle transaction", async () => {
  for (const fault of ["bodyRace", "rejectProtection"] as const) {
    const f = await fixture({ contentLifecycle: "owner" });
    try {
      const root = await f.seed();
      await acceptedBody(f, root);
      const before =
        (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows;
      f.state[fault] = true;
      await assert.rejects(f.run(root));
      assert.equal((await f.status(root)).state, "accepted");
      assert.equal((await f.events()).rows.length, 0);
      assert.deepEqual(
        (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
        before,
      );
      await f.run(root);
      assert.equal((await f.status(root)).state, "completed");
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  }
});

test("owner content lost settlement reply preserves the original replay deadline across owner succession", async () => {
  const f = await fixture({ contentLifecycle: "owner" });
  let successor: ReturnType<typeof f.boundary> | undefined;
  try {
    const root = await f.seed();
    await acceptedBody(f, root);
    const target = { namespace: root.namespace, operationId: root.operationId };
    const ready = await f.owner.project(
      f.caller,
      OWNER_OPERATION_READINESS,
      target,
    ) as { ticket: OwnerJson };
    f.state.time = end;
    f.state.loseReply = true;
    await assert.rejects(f.owner.execute(f.caller, {
      kind: OWNER_OPERATION_SETTLEMENT,
      domain: "occurrence",
      key: ownerOperationSettlementKey("owner", target, "lost-content"),
      intent: { occurrence: "lost-content", ticket: ready.ticket },
    }));
    assert.equal(f.owner.state, "stopped");
    assert.equal((await f.status(root)).state, "completed");
    assert.equal(await protection(f), "2099-01-03T00:00:00.000Z");
    successor = f.boundary("successor");
    await successor.acquire(1);
    const caller: OwnerCaller = {
      principal: {
        kind: "owner-control",
        ownerId: "owner",
        epoch: 2,
        holderId: "successor",
      },
      ownerEpoch: 2,
    };
    f.state.time = "2099-01-05T00:00:00.000Z";
    await f.settlement.run({
      boundary: successor,
      caller,
      target,
      occurrence: "retry-content",
    });
    assert.equal(await protection(f), "2099-01-03T00:00:00.000Z");
    assert.equal((await f.events()).rows.length, 1);
  } finally {
    f.owner.stop();
    successor?.stop();
    await f.db.close();
  }
});

test("owner content settlement recognizes local and worker producer facts without session authority", async () => {
  for (const shape of ["local-action", "worker-action", "worker-processor"]) {
    const f = await fixture({ contentLifecycle: "owner" });
    try {
      const root = await f.seed();
      await acceptedBody(f, root);
      const common = {
        namespace: root.namespace,
        sourceEventId: root.eventId,
        deliveryId: root.deliveryId,
      };
      const binding = shape === "local-action"
        ? {
          ...common,
          placement: "owner-local",
          kind: "action",
          ownerId: "owner",
          epoch: 1,
          holderId: "first",
          attemptId: "attempt",
          actionId: "fixture.action",
          actionRunId: "run",
        }
        : {
          ...common,
          placement: "worker",
          workerId: "worker",
          workerAttemptId: "worker-attempt",
          sessionGeneration: 1,
          sessionId: "closed-session",
          parentOperationId: root.operationId,
          assignmentId: "assignment",
          dispatchAttemptId: "dispatch",
          ...(shape === "worker-processor"
            ? { kind: "processor", processorId: "fixture" }
            : { actionId: "fixture.action", executionId: "run" }),
        };
      const producer = {
        sourceEventId: root.eventId,
        deliveryId: root.deliveryId,
        deliveryAttempt: 1,
        ...(shape === "worker-processor"
          ? { kind: "processor", processorId: "fixture" }
          : { kind: "action", actionId: "fixture.action", actionRunId: "run" }),
      };
      await f.db.query(
        "UPDATE copilotz_operation_streams SET placement_binding=$1::jsonb",
        [JSON.stringify(binding)],
      );
      await f.db.query(
        "UPDATE copilotz_operation_bodies SET producer=$1::jsonb",
        [JSON.stringify(producer)],
      );
      await f.run(root);
      assert.equal((await f.status(root)).state, "completed");
      assert.equal(await protection(f), "2099-01-03T00:00:00.000Z");
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  }
});
