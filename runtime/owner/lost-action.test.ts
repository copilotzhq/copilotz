import { createTestOwnerCatalog } from "../testing/owner-catalog.ts";
import { provisionOwnerContentCatalog } from "../streams/owner-catalog-schema.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerAssignmentControl,
  ownerAssignmentKey,
  provisionOwnerAssignments,
} from "./assignments.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandContext,
} from "./boundary.ts";
import { createOwnerExecutionCommands } from "./execution.ts";
import {
  createOwnerEffectCommands,
  readOwnerEffectInventory,
} from "./effects.ts";
import { OWNER_EFFECT_STEP_LIMIT, ownerEffectKey } from "./effects-client.ts";
import {
  createOwnerLostActionRecovery,
  OWNER_LOST_ACTION_RECOVERY,
  ownerLostActionKey,
} from "./lost-action.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { ownerReconciliationAlarm } from "./reconciliation.ts";
import {
  createOwnerOperationSettlement,
  ownerOperationSettlementAlarm,
} from "./settlement.ts";

const start = "2020-01-01T00:00:00.000Z";
const at = (offset: number) =>
  new Date(Date.parse(start) + offset).toISOString();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture timed out")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const flushNotifications = () =>
  new Promise((resolve) => setTimeout(resolve, 0));
async function fixture(
  options: {
    eligible?: boolean;
    maxAssignments?: number;
    maxAttempts?: number;
    policy?: boolean;
    permissiveControl?: boolean;
    duringRecoveryPolicy?(tx: SqlExecutor): Promise<void>;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOwnerContentCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    time: start,
    eligible: options.eligible ?? true,
    policy: options.policy ?? true,
    control: true,
    controlCalls: 0,
    hold: false,
    commits: 0,
    rollback: false,
    unknown: false,
    wakes: 0,
    scheduled: [] as string[],
    publications: [] as string[],
    errors: [] as unknown[],
    mutatePolicy: false,
    noncooperativeWake: false,
    executions: 0,
    dispatches: 0,
    settlementWakes: [] as { namespace: string; operationId: string }[],
    notificationOrder: [] as string[],
    failPublish: false,
    failPlacement: false,
    failSettlementWake: false,
    lateRegistration: undefined as
      | OwnerCommandContext["afterCommit"]
      | undefined,
  };
  const gate = { reached: deferred(), release: deferred() };
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const result = await db.transaction(async (tx) => {
        const value = await run(tx);
        if (state.hold) {
          state.hold = false;
          gate.reached.resolve();
          await gate.release.promise;
        }
        if (state.rollback) {
          state.rollback = false;
          throw new Error("injected rollback");
        }
        return value;
      });
      state.commits++;
      if (state.unknown) {
        state.unknown = false;
        throw new Error("lost COMMIT reply");
      }
      return result;
    },
  };
  const registry = createPluginRegistry({
    actions: {
      work: defineAction({
        id: "work",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute(value: string) {
          state.executions++;
          return value;
        },
      }),
    },
    processors: {
      after: defineProcessor({
        id: "after",
        on: [{ eventType: "work.failed" }, { eventType: "work.cancelled" }],
        handle() {},
      }),
    },
  });
  const catalog = createTestOwnerCatalog(db, "public");
  const store = createEventStore({ session: db, schema: "public" });
  const control = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    isCurrentStarted: () => true,
    authorizeControl(_tx, caller) {
      if (caller.principal.kind !== "owner-control" || !state.control) {
        throw new Error("control refused");
      }
    },
  });
  const refuseDispatch = () => {
    state.dispatches++;
    return Promise.reject(new Error("recovery cannot execute"));
  };
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "schedule-only",
    workloads: {},
    scheduleDelivery(value) {
      state.scheduled.push(typeof value === "string" ? value : value.id);
      state.notificationOrder.push("placement");
      if (state.failPlacement) throw new Error("injected placement failure");
    },
    dispatchWork: refuseDispatch,
    dispatchDelivery: refuseDispatch,
    dispatchRecoverable: refuseDispatch,
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const execution = createOwnerExecutionCommands({
    ownerId: "owner",
    schema: "public",
    session,
    registry,
    catalog,
    executor,
    async resolveAssignment(tx, caller) {
      const b = await control.resolveStarted(tx, caller);
      if (!b || "kind" in b) return undefined;
      return {
        ...b,
        ownerId: "owner",
        ctxGranted: true,
        settlementGranted: true,
        invocation: {
          actionRunId: b.executionId,
          operationKey: b.executionId,
          rootKey: b.executionId,
          metadata: {},
          identity: {
            causationId: b.sourceEventId,
            settlementScopeId: b.sourceEventId,
          },
        },
      };
    },
    authorizeInput() {},
    allowRecovery: () => state.eligible,
  });
  const effects = createOwnerEffectCommands({
    ownerId: "owner",
    schema: "public",
    async authorizeEffect(tx, caller, ref, mode, time) {
      const a = mode === "begin"
        ? await execution.authorizeLive(tx, caller, time)
        : await execution.authorizeSettlement(tx, caller, time);
      return a.namespace === ref.namespace &&
        a.invocation.actionRunId === ref.actionRunId;
    },
    validateOutcome: () => true,
    verifyNotStarted: () => true,
  });
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session,
    catalog,
    authorizeControl: () => false,
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake(scope) {
      state.settlementWakes.push(scope);
      state.notificationOrder.push("settlement");
      if (state.failSettlementWake) {
        throw new Error("injected settlement wake failure");
      }
    },
  });
  const recovery = createOwnerLostActionRecovery({
    ownerId: "owner",
    schema: "public",
    session,
    registry,
    catalog,
    executor,
    maxAssignments: options.maxAssignments,
    authorizeControl(_tx, caller) {
      state.controlCalls++;
      const permitted = state.control &&
        (options.permissiveControl ||
          caller.principal.kind === "owner-control");
      if (state.mutatePolicy) {
        Object.assign(caller, { ownerEpoch: 999 });
        Object.assign(caller.principal, { holderId: "mutated" });
      }
      return permitted;
    },
    async authorizeRecoveryTransition(tx, identity) {
      await options.duringRecoveryPolicy?.(tx);
      const permitted = state.policy;
      if (state.mutatePolicy) {
        Object.assign(identity, { deliveryId: "mutated" });
        Object.assign(identity.contract, { deliveryId: "mutated" });
      }
      return permitted;
    },
    async scheduleSettlement(ctx, scope) {
      await settlement.schedule(ctx, scope);
      state.lateRegistration = ctx.afterCommit;
    },
    publish(event) {
      state.publications.push(event.type);
      state.notificationOrder.push("publication");
      if (state.failPublish) throw new Error("injected publisher failure");
    },
    wake() {
      state.wakes++;
      state.notificationOrder.push("reconciliation");
      if (state.noncooperativeWake) return new Promise<never>(() => {});
    },
  });
  const allBoundaries: ReturnType<typeof createOwnerCommandBoundary>[] = [];
  const make = (epoch: number) => {
    const boundary = createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId: "owner",
      holderId: `holder-${epoch}`,
      now: () => state.time,
      handlers: {
        ...control.handlers,
        ...execution.handlers,
        ...effects.handlers,
        ...recovery.handlers,
        async "fixture.retry"(input, ctx) {
          // This test-only host control path models an explicit prior failed
          // delivery, not lease expiry or permission to replay provider I/O.
          // It is historical-state setup; the current Action worker does not
          // expose this retry flow. Only later real claims advance attempts.
          const value = input as {
            deliveryId: string;
            dispatchAttemptId: string;
          };
          const commandStore = createEventStore({
            session,
            schema: "public",
            ownerCommit: {
              ...ctx.ownerCommit,
              afterCommit: ctx.afterCommit,
              ownerAttempt: {
                deliveryId: value.deliveryId,
                attemptId: value.dispatchAttemptId,
              },
            },
            lockSettlementScope: (tx, scope) => catalog.lockScope(tx, scope),
          });
          const before = await commandStore.getDelivery(value.deliveryId);
          assert.ok(before && before.attempts < before.maxAttempts);
          const next = await commandStore.failDelivery({
            id: value.deliveryId,
            owner: value.dispatchAttemptId,
            error: new Error("explicit fixture attempt failure"),
            retryable: true,
            backoffMs: 0,
          });
          assert.equal(next?.status, "retry_wait");
          assert.equal(next?.attempts, before.attempts);
          return { status: next!.status, attempts: next!.attempts };
        },
        async seed(_input, ctx) {
          const source = await createEventStore({
            session,
            schema: "public",
            ownerCommit: ctx.ownerCommit,
            admitOperationEventSql: (value, param) =>
              catalog.admitEventSql(value, param),
            indexOperationEventSql: (value, param) =>
              catalog.indexEventSql(value, param),
            indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
          }).commitMutation({
            transaction: ctx.tx,
            draft: {
              type: "copilotz.owner.action.requested",
              namespace: "space",
              payload: {
                dataRef: {
                  eventBodyId: "source-body",
                  schemaVersion: 1,
                  mediaType: "application/json",
                },
              },
              metadata: { actionId: "work", actionRunId: "run" },
              deduplicationId: "run",
            },
            body: { id: "source-body", json: "value" },
            maxAttempts: options.maxAttempts,
            consumers: [{
              consumerId: "registered:work",
              settlement: "inherit",
            }],
          });
          return {
            eventId: source.event.id,
            deliveryId: source.deliveries[0].id,
          };
        },
      },
      projections: { ...execution.projections, ...effects.projections },
      inputDefinitions: execution.inputDefinitions,
      async authorize(tx, caller, command, time, normalized) {
        if (command.kind === "seed" || command.kind === "fixture.retry") {
          if (caller.principal.kind !== "owner-control") {
            throw new Error("control required");
          }
        } else if (command.kind.startsWith("assignment.")) {
          await control.authorize(tx, caller, command, time);
        } else if (command.kind.startsWith("effect.")) {
          await effects.authorize(tx, caller, command, time);
        } else if (command.kind === OWNER_LOST_ACTION_RECOVERY) {
          await recovery.authorize(tx, caller, command, time);
        } else await execution.authorize(tx, caller, command, time, normalized);
      },
      authenticateReceipt() {
        throw new Error("no ambient receipt authority");
      },
      onPostCommitError: (error) => state.errors.push(error),
    });
    allBoundaries.push(boundary);
    return boundary;
  };
  const host = (epoch: number): OwnerCaller => ({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch,
      holderId: `holder-${epoch}`,
    },
    ownerEpoch: epoch,
  });
  const first = make(1);
  await first.acquire(0);
  const refs = (await first.execute(host(1), {
    kind: "seed",
    domain: "logical",
    key: "source",
    intent: null,
  })).result as { eventId: string; deliveryId: string };
  const binding = (index: number) => ({
    placement: "worker" as const,
    workerId: "worker",
    workerAttemptId: `worker:${index}`,
    sessionGeneration: 1,
    sessionId: `session:${index}`,
    parentOperationId: `operation:${index}`,
    assignmentId: `assignment:${index}`,
    dispatchAttemptId: `attempt:${index}`,
    namespace: "space",
    sourceEventId: refs.eventId,
    deliveryId: refs.deliveryId,
    actionId: "work",
    executionId: "run",
  });
  let bound = binding(1);
  const assignmentCommand = (kind: string, value = bound): OwnerCommand => ({
    kind,
    domain: "incarnation",
    key: `${ownerAssignmentKey("owner", value)}:${kind}`,
    intent: value,
  });
  const worker = (): OwnerCaller => ({
    principal: { kind: "worker", workerId: bound.workerId },
    ownerEpoch: 1,
    assignmentId: bound.assignmentId,
    sessionId: bound.sessionId,
    dispatchAttemptId: bound.dispatchAttemptId,
    workerAttemptId: bound.workerAttemptId,
    sessionGeneration: bound.sessionGeneration,
    parentOperationId: bound.parentOperationId,
  });
  await first.execute(host(1), assignmentCommand("assignment.bind"));
  const claim = () =>
    first.execute(worker(), {
      kind: "execution.claim",
      domain: "incarnation",
      key: ownerClaimKey("owner", bound.assignmentId, bound.sessionId),
      intent: { assignmentId: bound.assignmentId, sessionId: bound.sessionId },
    });
  await claim();
  let epoch = 1;
  let current = first;
  const target = { namespace: "space", deliveryId: refs.deliveryId };
  const command = (occurrence = "once"): OwnerCommand => ({
    kind: OWNER_LOST_ACTION_RECOVERY,
    domain: "occurrence",
    key: ownerLostActionKey("owner", epoch, target, occurrence),
    intent: { ...target, occurrence },
  });
  return {
    db,
    state,
    gate,
    store,
    first,
    refs,
    target,
    recovery,
    command,
    worker,
    host,
    get current() {
      return current;
    },
    get bound() {
      return bound;
    },
    async takeover() {
      state.time = new Date(Date.parse(state.time) + 100).toISOString();
      const next = make(epoch + 1);
      await next.acquire(epoch);
      current = next;
      epoch++;
    },
    retireLost: () =>
      first.execute(host(1), assignmentCommand("assignment.retire")),
    async injectConflictingReservation(future: boolean) {
      // Deliberately corrupt evidence: assignment.bind must never legally bind
      // a new reservation over this leased delivery, even after lease expiry.
      const value = binding(Number(bound.dispatchAttemptId.split(":")[1]) + 1);
      await db.query(
        `INSERT INTO owner_assignments(owner,epoch,assignment_key,delivery_id,binding,retired,created_at)
         VALUES($1,$2,$3,$4,$5::jsonb,FALSE,$6::timestamptz)`,
        [
          "owner",
          future ? epoch + 1 : epoch,
          ownerAssignmentKey("owner", value),
          value.deliveryId,
          JSON.stringify(value),
          state.time,
        ],
      );
    },
    async nextClaim() {
      await first.execute(host(1), {
        kind: "fixture.retry",
        domain: "occurrence",
        key: `retry:${bound.assignmentId}`,
        intent: {
          deliveryId: bound.deliveryId,
          dispatchAttemptId: bound.dispatchAttemptId,
        },
      });
      await first.execute(host(1), assignmentCommand("assignment.retire"));
      const number = Number(bound.dispatchAttemptId.split(":")[1]) + 1;
      state.time = at((number - 1) * 10001);
      bound = binding(number);
      await first.execute(host(1), assignmentCommand("assignment.bind"));
      await claim();
    },
    async effect(kind: "begin" | "confirm" | "notStarted") {
      const mode = kind;
      const ref = { namespace: "space", actionRunId: "run", step: "send" };
      return await first.execute(worker(), {
        kind: `effect.${mode}`,
        domain: "logical",
        key: ownerEffectKey("owner", ref, mode),
        intent: {
          ...ref,
          ...(kind === "confirm"
            ? { outcome: { id: "safe" } }
            : kind === "notStarted"
            ? { evidence: { source: "test", reference: "verified" } }
            : {}),
        },
      });
    },
    recover: (occurrence?: string) =>
      current.execute(host(epoch), command(occurrence)),
    terminal: () =>
      createActionLifecycleLoader({ store })("space", "run:action:terminal"),
    async close() {
      gate.release.resolve();
      for (const boundary of allBoundaries) boundary.stop();
      await db.close();
    },
  };
}

test("lost Action requeue requires the exact original contract and current policy without executing or consuming another attempt", async () => {
  const f = await fixture();
  try {
    const old = await f.store.getDelivery(f.refs.deliveryId);
    assert.equal(old?.attempts, 1);
    await f.takeover();
    f.state.mutatePolicy = true;
    f.state.noncooperativeWake = true;
    assert.deepEqual((await f.recover()).result, {
      ...f.target,
      disposition: "retry",
      reason: "historical_and_current_recovery_proven",
    });
    const row = await f.store.getDelivery(f.refs.deliveryId);
    assert.equal(row?.status, "retry_wait");
    assert.equal(row?.attempts, 1);
    assert.equal(row?.maxAttempts, 3);
    assert.equal(row?.availableAt, old?.availableAt);
    assert.equal(f.state.executions, 0);
    assert.equal(await f.terminal(), null);
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wakes = f.state.wakes;
    assert.equal((await f.recover()).status, "duplicate");
    assert.equal(f.state.wakes, wakes);
    f.state.control = false;
    await assert.rejects(f.recover(), /control refused/i);
  } finally {
    await f.close();
  }
});

test("old unconverted Action and begun effects stay blocked after takeover without a no-effect inference", async () => {
  for (const scenario of ["unconverted", "begun", "policy"] as const) {
    const f = await fixture({
      eligible: scenario !== "unconverted",
      policy: scenario !== "policy",
    });
    try {
      if (scenario === "begun") await f.effect("begin");
      const before = await f.store.getDelivery(f.refs.deliveryId);
      f.state.eligible = true;
      await f.takeover();
      const result = (await f.recover()).result as {
        disposition: string;
        reason: string;
      };
      assert.equal(result.disposition, "blocked");
      assert.equal(
        result.reason,
        scenario === "unconverted"
          ? "original_contract_unproven"
          : scenario === "begun"
          ? "effect_reconciliation_required"
          : "current_recovery_policy_refused",
      );
      assert.deepEqual(await f.store.getDelivery(f.refs.deliveryId), before);
      assert.equal(f.state.executions, 0);
      assert.equal(await f.terminal(), null);
      assert.ok(
        (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length > 0,
      );
    } finally {
      await f.close();
    }
  }
});

test("lost exhausted/cancelled Actions use genuine prior claims and preserve unresolved effect evidence", async () => {
  for (const cancelled of [false, true]) {
    const f = await fixture();
    try {
      await f.effect("begin");
      await f.nextClaim();
      await f.nextClaim();
      if (cancelled) {
        await f.db.query(
          "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE namespace='space' AND operation_id=$2",
          [at(99), f.refs.eventId],
        );
      }
      await f.takeover();
      const result = (await f.recover()).result as { disposition: string };
      assert.equal(result.disposition, cancelled ? "cancelled" : "exhausted");
      const delivery = await f.store.getDelivery(f.refs.deliveryId);
      assert.equal(delivery?.attempts, 3);
      assert.equal(delivery?.status, cancelled ? "cancelled" : "dead_letter");
      const terminal = await f.terminal();
      assert.equal(terminal?.status, cancelled ? "cancelled" : "failed");
      if (terminal?.status === "failed") {
        assert.equal(terminal.error.code, "effect_indeterminate");
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
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});

test("lost Action recovery refuses incomplete assignment inventory and exact lost-claim corruption", async () => {
  for (const scenario of ["cap", "principal", "claim", "awaiting"] as const) {
    const f = await fixture({
      maxAssignments: scenario === "cap" ? 1 : undefined,
    });
    try {
      if (scenario === "cap") await f.nextClaim();
      if (scenario === "principal") {
        await f.db.query(
          "UPDATE owner_receipts SET principal_id=$1 WHERE kind='execution.claim'",
          [JSON.stringify(["different-worker"])],
        );
      }
      if (scenario === "claim") {
        await f.db.query(
          "UPDATE owner_receipts SET result=result || '{\"unexpected\":true}'::jsonb WHERE kind='execution.claim'",
        );
      }
      if (scenario === "awaiting") {
        await f.db.query(
          "UPDATE open_actions SET wait_key='unsupported-wait' WHERE namespace='space' AND action_run_id='run'",
        );
      }
      const before = await f.store.getDelivery(f.refs.deliveryId);
      await f.takeover();
      if (scenario === "cap") {
        await assert.rejects(f.recover(), /capacity|bound|limit|assignment/i);
      } else {assert.equal(
          ((await f.recover()).result as { disposition: string }).disposition,
          "blocked",
        );}
      assert.deepEqual(await f.store.getDelivery(f.refs.deliveryId), before);
      assert.equal(await f.terminal(), null);
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});

test("lost Action rollback or unknown COMMIT cannot produce an automatic execution retry", async () => {
  for (const unknown of [false, true]) {
    const f = await fixture();
    try {
      await f.takeover();
      const before = await f.store.getDelivery(f.refs.deliveryId);
      f.state.rollback = !unknown;
      f.state.unknown = unknown;
      await assert.rejects(f.recover(), { code: "owner_commit_unknown" });
      assert.equal(f.current.state, "stopped");
      assert.equal(f.state.executions, 0);
      const row = await f.store.getDelivery(f.refs.deliveryId);
      if (unknown) {
        assert.equal(row?.status, "retry_wait");
        assert.equal(row?.attempts, 1);
        assert.equal(row?.availableAt, before?.availableAt);
        await f.takeover();
        assert.equal(
          (await f.store.getDelivery(f.refs.deliveryId))?.status,
          "retry_wait",
        );
      } else {
        assert.deepEqual(row, before);
        assert.equal(
          (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
          0,
        );
        assert.equal(
          (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
            .retired,
          false,
        );
      }
      assert.equal(await f.terminal(), null);
    } finally {
      await f.close();
    }
  }
});

test("lost second attempt retains a distinct retired original contract, while current/future reservations block", async () => {
  for (const scenario of ["second", "retired", "current", "future"] as const) {
    const f = await fixture();
    try {
      if (scenario === "second") await f.nextClaim();
      else await f.retireLost();
      await f.takeover();
      if (scenario === "current" || scenario === "future") {
        await f.injectConflictingReservation(scenario === "future");
      }
      const before = await f.store.getDelivery(f.refs.deliveryId);
      const result = (await f.recover()).result as {
        disposition: string;
        reason: string;
      };
      if (scenario === "second" || scenario === "retired") {
        assert.equal(result.disposition, "retry");
        const row = await f.store.getDelivery(f.refs.deliveryId);
        assert.equal(row?.attempts, scenario === "second" ? 2 : 1);
        assert.equal(row?.availableAt, before?.availableAt);
        if (scenario === "second") {
          const claims = await f.db.query<
            {
              result: {
                contract?: { assignmentId: string };
                recovery?: unknown;
              };
            }
          >("SELECT result FROM owner_receipts WHERE kind='execution.claim' ORDER BY key");
          assert.equal(claims.rows.length, 2);
          assert.equal(
            claims.rows.filter((row) => row.result.contract).length,
            1,
          );
          assert.notEqual(
            claims.rows.find((row) => row.result.contract)?.result.contract
              ?.assignmentId,
            f.bound.assignmentId,
          );
          assert.equal(
            claims.rows.filter((row) => row.result.recovery).length,
            1,
          );
        }
      } else {
        assert.deepEqual(result, {
          ...f.target,
          disposition: "blocked",
          reason: `${scenario}_epoch_assignment`,
        });
        assert.deepEqual(await f.store.getDelivery(f.refs.deliveryId), before);
        assert.equal(
          (await f.db.query(
            "SELECT retired FROM owner_assignments WHERE epoch=$1",
            [scenario === "current" ? 2 : 3],
          )).rows[0].retired,
          false,
        );
      }
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});

test("lost Action canonical provenance baseline uses one genuine exhausted claim", async () => {
  const f = await fixture({ maxAttempts: 1, eligible: false });
  try {
    const source = await f.store.getEvent(f.refs.eventId);
    const invoked = await f.store.getEventByDeduplicationId(
      "space",
      "run:action:invoked",
    );
    assert.equal(source?.deduplicationId, "run");
    assert.equal(invoked?.correlationId, source?.correlationId);
    const indexes = await f.db.query<{ event_id: string; matches: boolean }>(
      `SELECT i.event_id,(i.namespace=e.namespace AND i.operation_id=$1 AND i.event_position=e.position) AS matches FROM copilotz_operation_events i JOIN events e ON e.id=i.event_id WHERE i.event_id IN ($1,$2) ORDER BY i.event_id`,
      [f.refs.eventId, invoked!.id],
    );
    assert.equal(indexes.rows.length, 2);
    assert.ok(indexes.rows.every((row) => row.matches));
    const claims = await f.db.query<{ result: { contract?: unknown } }>(
      "SELECT result FROM owner_receipts WHERE kind='execution.claim'",
    );
    assert.equal(claims.rows.length, 1);
    assert.equal(claims.rows[0].result.contract, undefined);
    await f.takeover();
    assert.equal(
      ((await f.recover()).result as { disposition: string }).disposition,
      "exhausted",
    );
    const delivery = await f.store.getDelivery(f.refs.deliveryId);
    assert.equal(delivery?.status, "dead_letter");
    assert.equal(delivery?.attempts, 1);
    assert.equal(delivery?.maxAttempts, 1);
    assert.equal((await f.terminal())?.status, "failed");
    assert.equal(f.state.executions, 0);
  } finally {
    await f.close();
  }
});

for (
  const corruption of [
    "source-deduplication",
    "invoked-correlation",
    "source-index-missing",
    "source-index-namespace",
    "source-index-scope",
    "source-index-position",
    "invoked-index-missing",
    "invoked-index-namespace",
    "invoked-index-scope",
    "invoked-index-position",
  ] as const
) {
  test(`lost Action canonical provenance blocks ${corruption} before terminal mutation`, async () => {
    const f = await fixture({ maxAttempts: 1, eligible: false });
    try {
      await f.effect("begin");
      const invoked = await f.store.getEventByDeduplicationId(
        "space",
        "run:action:invoked",
      );
      assert.ok(invoked);
      if (
        corruption === "source-deduplication" ||
        corruption === "invoked-correlation"
      ) {
        // Fixture-only corruption. The sole immutable-event trigger is restored
        // inside this transaction; an error also rolls back the trigger DDL.
        await f.db.transaction(async (tx) => {
          await tx.query(
            'ALTER TABLE events DISABLE TRIGGER "copilotz_events_immutable"',
          );
          await tx.query(
            corruption === "source-deduplication"
              ? "UPDATE events SET deduplication_id='wrong-run' WHERE id=$1"
              : "UPDATE events SET correlation_id='wrong-correlation' WHERE id=$1",
            [
              corruption === "source-deduplication"
                ? f.refs.eventId
                : invoked.id,
            ],
          );
          await tx.query(
            'ALTER TABLE events ENABLE TRIGGER "copilotz_events_immutable"',
          );
        });
      } else {
        const id = corruption.startsWith("source-")
          ? f.refs.eventId
          : invoked.id;
        const mutation = corruption.endsWith("missing")
          ? "DELETE FROM copilotz_operation_events WHERE event_id=$1"
          : corruption.endsWith("namespace")
          ? "UPDATE copilotz_operation_events SET namespace='foreign' WHERE event_id=$1"
          : corruption.endsWith("scope")
          ? "UPDATE copilotz_operation_events SET operation_id='foreign-scope' WHERE event_id=$1"
          : "UPDATE copilotz_operation_events SET event_position=event_position+9007199254740993 WHERE event_id=$1";
        await f.db.query(mutation, [id]);
      }
      await f.takeover();
      const snapshot = async () => {
        const data: Record<string, unknown> = {};
        for (
          const [table, order] of [
            ["events", "id"],
            ["event_bodies", "event_body_id"],
            ["event_deliveries", "id"],
            ["owner_assignments", "assignment_key"],
            ["open_actions", "action_run_id"],
            ["copilotz_operation_events", "event_id"],
            ["copilotz_operations", "operation_id"],
          ]
        ) {
          data[table] =
            (await f.db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
        }
        data.effects = (await f.db.query(
          "SELECT * FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY key",
        )).rows;
        return data;
      };
      const before = await snapshot();
      const notifications = {
        publications: [...f.state.publications],
        scheduled: [...f.state.scheduled],
        wakes: f.state.wakes,
      };
      const result = (await f.recover()).result as {
        disposition: string;
        reason: string;
      };
      assert.equal(result.disposition, "blocked");
      assert.equal(
        result.reason,
        corruption === "source-deduplication"
          ? "source_run_mismatch"
          : corruption === "invoked-correlation"
          ? "invoked_identity_mismatch"
          : "lifecycle_catalog_mismatch",
      );
      assert.deepEqual(await snapshot(), before);
      assert.equal(await f.terminal(), null);
      assert.deepEqual(f.state.publications, notifications.publications);
      assert.deepEqual(f.state.scheduled, notifications.scheduled);
      assert.equal(f.state.executions, 0);
      // A known blocker intentionally records its command receipt and exact
      // reconciliation alarm, and may issue the non-authoritative wake hint.
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_receipts WHERE kind=$1", [
          OWNER_LOST_ACTION_RECOVERY,
        ])).rows.length,
        1,
      );
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
        1,
      );
      assert.equal(f.state.wakes, notifications.wakes + 1);
    } finally {
      await f.close();
    }
  });
}

// Regression migration from the dormant namespace sweep. These fixtures use the
// real exact-target command, lifecycle, EventStore and settlement scheduler.
type LostFixture = Awaited<ReturnType<typeof fixture>>;
type EffectState = "none" | "begun" | "confirmed" | "not_started";
const effectStates: readonly EffectState[] = [
  "none",
  "begun",
  "confirmed",
  "not_started",
];
async function terminalFixture(
  effect: EffectState,
  cancelled = false,
  finalAttempt = true,
) {
  // A first genuine claim exhausts maxAttempts=1. The still-budgeted cancellation
  // case deliberately retains the ordinary default budget of three attempts.
  const f = await fixture({
    maxAttempts: finalAttempt ? 1 : undefined,
    eligible: false,
    policy: false,
  });
  try {
    if (effect !== "none") await f.effect("begin");
    if (effect === "confirmed") await f.effect("confirm");
    if (effect === "not_started") await f.effect("notStarted");
    if (cancelled) {
      await f.db.query(
        "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE namespace='space' AND operation_id=$2",
        [at(99), f.refs.eventId],
      );
    }
    await f.takeover();
    return f;
  } catch (error) {
    await f.close();
    throw error;
  }
}
async function effectBytes(f: LostFixture) {
  return (await f.db.query(
    "SELECT row_to_json(r)::text AS bytes FROM owner_receipts r WHERE kind LIKE 'effect.%' ORDER BY key",
  )).rows;
}
async function durableSnapshot(f: LostFixture) {
  const snapshot: Record<string, unknown> = {};
  for (
    const table of [
      "events",
      "event_bodies",
      "event_deliveries",
      "open_actions",
      "nodes",
      "owner_receipts",
      "owner_receipt_readers",
      "owner_epochs",
      "owner_assignments",
      "owner_alarms",
      "copilotz_operations",
      "copilotz_operation_events",
    ]
  ) {
    snapshot[table] = (await f.db.query(
      `SELECT row_to_json(r)::text AS bytes FROM ${table} r ORDER BY row_to_json(r)::text`,
    )).rows;
  }
  return snapshot;
}
async function continuationIds(f: LostFixture) {
  return (await f.db.query<{ id: string }>(
    "SELECT id FROM event_deliveries WHERE consumer_id='processor:after' ORDER BY id",
  )).rows.map((row) => row.id);
}
async function assertTerminalAlarms(f: LostFixture) {
  const alarms = await f.db.query<
    { owner: string; name: string; due_now: boolean }
  >(
    "SELECT owner,name,(due_at=$1::timestamptz) AS due_now FROM owner_alarms ORDER BY name",
    [f.state.time],
  );
  assert.deepEqual(
    alarms.rows,
    [
      ownerOperationSettlementAlarm({
        namespace: "space",
        operationId: f.refs.eventId,
      }),
      ownerReconciliationAlarm("owner", {
        kind: "delivery",
        namespace: "space",
        id: f.refs.deliveryId,
      }),
    ].sort().map((name) => ({ owner: "owner", name, due_now: true })),
  );
}
function assertNoNotifications(f: LostFixture) {
  assert.deepEqual(f.state.publications, []);
  assert.deepEqual(f.state.scheduled, []);
  assert.deepEqual(f.state.settlementWakes, []);
  assert.equal(f.state.wakes, 0);
  assert.deepEqual(f.state.notificationOrder, []);
  assert.equal(f.state.executions, 0);
  assert.equal(f.state.dispatches, 0);
}
async function assertCanonicalTerminal(
  f: LostFixture,
  effect: EffectState,
  cancelled: boolean,
) {
  const terminal = await f.terminal();
  assert.ok(terminal);
  assert.equal(terminal.status, cancelled ? "cancelled" : "failed");
  assert.ok(terminal.status === "failed" || terminal.status === "cancelled");
  assert.equal(
    terminal.error?.name,
    cancelled
      ? "AbortError"
      : effect === "begun"
      ? "ActionEffectIndeterminate"
      : "ActionDeliveryExhausted",
  );
  assert.equal(
    terminal.error?.code,
    !cancelled && effect === "begun" ? "effect_indeterminate" : undefined,
  );
  assert.equal(
    (await f.db.query(
      "SELECT 1 FROM events WHERE namespace='space' AND deduplication_id='run:action:terminal'",
    )).rows.length,
    1,
  );
  assert.equal((await f.db.query("SELECT 1 FROM open_actions")).rows.length, 0);
  assert.deepEqual(
    (await f.db.query(
      "SELECT status,attempts,lease_owner,lease_expires_at FROM event_deliveries WHERE consumer_id='processor:after'",
    )).rows,
    [{
      status: cancelled ? "cancelled" : "pending",
      attempts: 0,
      lease_owner: null,
      lease_expires_at: null,
    }],
  );
  assert.deepEqual(
    (await f.db.query(
      "SELECT retired FROM owner_assignments ORDER BY assignment_key",
    )).rows,
    [{ retired: true }],
  );
  await assertTerminalAlarms(f);
  assert.equal(f.state.executions, 0);
  assert.equal(f.state.dispatches, 0);
}

test("lost final first claim retains the complete effect matrix and exact terminal duplicates", async () => {
  for (const effect of effectStates) {
    const f = await terminalFixture(effect);
    try {
      const before = await f.store.getDelivery(f.refs.deliveryId);
      assert.equal(before?.attempts, 1);
      assert.equal(before?.maxAttempts, 1);
      assert.equal(
        (await f.db.query(
          "SELECT 1 FROM owner_receipts WHERE kind='execution.claim'",
        )).rows.length,
        1,
      );
      const evidence = await effectBytes(f);
      const outcome = await f.recover();
      assert.equal(outcome.status, "committed");
      assert.deepEqual(outcome.result, {
        ...f.target,
        disposition: "exhausted",
        reason: "canonical_terminal_written",
      });
      const delivery = await f.store.getDelivery(f.refs.deliveryId);
      assert.equal(delivery?.status, "dead_letter");
      assert.equal(delivery?.attempts, before?.attempts);
      assert.equal(delivery?.maxAttempts, before?.maxAttempts);
      assert.equal(delivery?.availableAt, before?.availableAt);
      assert.equal(delivery?.leaseOwner, undefined);
      assert.equal(delivery?.leaseExpiresAt, undefined);
      assert.deepEqual(delivery?.lastError, {
        name: "AttemptLost",
        message: "The delivery attempt was lost after its final attempt.",
      });
      assert.deepEqual(await effectBytes(f), evidence);
      assert.deepEqual(
        await readOwnerEffectInventory(f.db, {
          ownerId: "owner",
          schema: "public",
          namespace: "space",
          actionRunId: "run",
        }),
        effect === "none" ? [] : [{ step: "send", status: effect }],
      );
      await assertCanonicalTerminal(f, effect, false);
      await flushNotifications();
      assert.deepEqual(f.state.publications, ["work.failed"]);
      assert.deepEqual(f.state.scheduled, await continuationIds(f));
      assert.deepEqual(f.state.settlementWakes, [{
        namespace: "space",
        operationId: f.refs.eventId,
      }]);
      assert.equal(f.state.wakes, 1);
      const committed = await durableSnapshot(f);
      const order = [...f.state.notificationOrder];
      assert.deepEqual(await f.recover(), {
        status: "duplicate",
        result: outcome.result,
      });
      await flushNotifications();
      assert.deepEqual(await durableSnapshot(f), committed);
      assert.deepEqual(f.state.notificationOrder, order);
      assert.deepEqual(f.state.errors, []);
    } finally {
      await f.close();
    }
  }
});

test("lost cancellation takes precedence over every effect state with budget remaining or exhausted", async () => {
  for (const finalAttempt of [false, true]) {
    for (const effect of effectStates) {
      const f = await terminalFixture(effect, true, finalAttempt);
      try {
        const before = await f.store.getDelivery(f.refs.deliveryId);
        assert.equal(before?.attempts, 1);
        assert.equal(before?.maxAttempts, finalAttempt ? 1 : 3);
        assert.equal(
          (await f.db.query(
            "SELECT 1 FROM owner_receipts WHERE kind='execution.claim'",
          )).rows.length,
          1,
        );
        const evidence = await effectBytes(f);
        const outcome = await f.recover();
        assert.deepEqual(outcome.result, {
          ...f.target,
          disposition: "cancelled",
          reason: "canonical_terminal_written",
        });
        const delivery = await f.store.getDelivery(f.refs.deliveryId);
        assert.equal(delivery?.status, "cancelled");
        assert.equal(delivery?.attempts, before?.attempts);
        assert.equal(delivery?.maxAttempts, before?.maxAttempts);
        assert.equal(delivery?.availableAt, before?.availableAt);
        assert.equal(delivery?.leaseOwner, undefined);
        assert.equal(delivery?.leaseExpiresAt, undefined);
        assert.deepEqual(delivery?.lastError, before?.lastError);
        assert.deepEqual(await effectBytes(f), evidence);
        await assertCanonicalTerminal(f, effect, true);
        await flushNotifications();
        assert.deepEqual(f.state.publications, ["work.cancelled"]);
        // Cancellation emits the notification delivery already cancelled. It
        // is durable evidence, never a newly runnable continuation.
        assert.deepEqual(f.state.scheduled, []);
        assert.deepEqual(f.state.settlementWakes, [{
          namespace: "space",
          operationId: f.refs.eventId,
        }]);
        assert.equal(f.state.wakes, 1);
        const committed = await durableSnapshot(f);
        const order = [...f.state.notificationOrder];
        assert.deepEqual(await f.recover(), {
          status: "duplicate",
          result: outcome.result,
        });
        await flushNotifications();
        assert.deepEqual(await durableSnapshot(f), committed);
        assert.deepEqual(f.state.notificationOrder, order);
        assert.deepEqual(f.state.errors, []);
      } finally {
        await f.close();
      }
    }
  }
});

test("lost terminal output and all hints wait for a real outer COMMIT and vanish on rollback", async () => {
  for (const rollback of [false, true]) {
    const f = await terminalFixture("begun");
    try {
      const before = await durableSnapshot(f);
      const commits = f.state.commits;
      f.state.hold = true;
      f.state.rollback = rollback;
      let exposed = false;
      const pending = f.recover().finally(() => {
        exposed = true;
      });
      const completed = rollback
        ? assert.rejects(pending, { code: "owner_commit_unknown" })
        : pending;
      await within(f.gate.reached.promise);
      assert.equal(exposed, false);
      assert.equal(f.state.commits, commits);
      assertNoNotifications(f);
      f.gate.release.resolve();
      await within<unknown>(completed);
      await flushNotifications();
      assert.equal(exposed, true);
      assert.equal(f.state.commits, commits + (rollback ? 0 : 1));
      if (rollback) {
        assert.equal(f.current.state, "stopped");
        assert.deepEqual(await durableSnapshot(f), before);
        assertNoNotifications(f);
      } else {
        await assertCanonicalTerminal(f, "begun", false);
        assert.deepEqual(f.state.publications, ["work.failed"]);
        assert.deepEqual(f.state.scheduled, await continuationIds(f));
        assert.deepEqual(f.state.settlementWakes, [{
          namespace: "space",
          operationId: f.refs.eventId,
        }]);
        assert.equal(f.state.wakes, 1);
        assert.deepEqual(f.state.notificationOrder, [
          "publication",
          "placement",
          "settlement",
          "reconciliation",
        ]);
      }
    } finally {
      await f.close();
    }
  }
});

test("lost terminal duplicates reauthorize current control and exact epoch and target", async () => {
  const f = await terminalFixture("begun");
  try {
    const outcome = await f.recover();
    await flushNotifications();
    const before = await durableSnapshot(f);
    const order = [...f.state.notificationOrder];
    const command = f.command();
    assert.deepEqual(JSON.parse(command.key), [
      OWNER_LOST_ACTION_RECOVERY,
      "owner",
      2,
      "space",
      f.refs.deliveryId,
      "once",
    ]);
    await assert.rejects(
      f.current.execute({
        ...f.host(2),
        principal: { kind: "worker", workerId: "owner:owner" },
      }, command),
      { code: "owner_lost_action_refused" },
    );
    await assert.rejects(
      f.current.execute({ ...f.host(2), ownerEpoch: 1 }, command),
      {
        code: "ActionOwnershipLost",
      },
    );
    await assert.rejects(
      f.current.execute({ ...f.host(1), ownerEpoch: 2 }, command),
      {
        code: "ActionOwnershipLost",
      },
    );
    for (
      const changed of [
        { ...command, key: ownerLostActionKey("owner", 1, f.target, "once") },
        {
          ...command,
          intent: { ...f.target, namespace: "foreign", occurrence: "once" },
        },
        {
          ...command,
          intent: { ...f.target, deliveryId: "foreign", occurrence: "once" },
        },
      ]
    ) {
      await assert.rejects(f.current.execute(f.host(2), changed), {
        code: "owner_lost_action_refused",
      });
    }
    const calls = f.state.controlCalls;
    f.state.control = false;
    await assert.rejects(f.recover(), { code: "owner_lost_action_refused" });
    assert.equal(f.state.controlCalls, calls + 1);
    f.state.control = true;
    assert.deepEqual(await f.recover(), {
      status: "duplicate",
      result: outcome.result,
    });
    assert.equal(f.state.controlCalls, calls + 2);
    await flushNotifications();
    assert.deepEqual(await durableSnapshot(f), before);
    assert.deepEqual(f.state.notificationOrder, order);
    assert.equal(f.state.executions, 0);
    assert.equal(f.state.dispatches, 0);
  } finally {
    await f.close();
  }
});

test("lost exhausted and cancelled unknown COMMIT keeps both durable fates unexposed", async () => {
  for (const cancelled of [false, true]) {
    for (const rollback of [false, true]) {
      const f = await terminalFixture("begun", cancelled);
      try {
        const before = await durableSnapshot(f);
        const evidence = await effectBytes(f);
        const delivery = await f.store.getDelivery(f.refs.deliveryId);
        const key = f.command().key;
        f.state.rollback = rollback;
        f.state.unknown = !rollback;
        await assert.rejects(f.recover(), { code: "owner_commit_unknown" });
        assert.equal(f.current.state, "stopped");
        await flushNotifications();
        assertNoNotifications(f);
        // Observe commit fate with fixture SQL, never owner-control receipt read
        // authority or an automatic second command. Successor accounting is a
        // separate host regression because lost-action keys include the epoch.
        assert.equal(
          (await f.db.query(
            "SELECT 1 FROM owner_receipts WHERE kind=$1 AND key=$2",
            [OWNER_LOST_ACTION_RECOVERY, key],
          )).rows.length,
          rollback ? 0 : 1,
        );
        if (rollback) {
          assert.deepEqual(await durableSnapshot(f), before);
          assert.equal(await f.terminal(), null);
        } else {
          await assertCanonicalTerminal(f, "begun", cancelled);
          const row = await f.store.getDelivery(f.refs.deliveryId);
          assert.equal(row?.status, cancelled ? "cancelled" : "dead_letter");
          assert.equal(row?.attempts, delivery?.attempts);
          assert.equal(row?.maxAttempts, delivery?.maxAttempts);
          assert.equal(row?.availableAt, delivery?.availableAt);
        }
        assert.deepEqual(await effectBytes(f), evidence);
        assert.equal(
          (await f.db.query(
            "SELECT 1 FROM owner_receipts WHERE kind='execution.claim'",
          )).rows.length,
          1,
        );
        assert.deepEqual(f.state.errors, []);
      } finally {
        await f.close();
      }
    }
  }
});

test("lost terminal malformed or oversized effect inventory rolls back every partial transition", async () => {
  for (const oversized of [false, true]) {
    const f = await terminalFixture("begun");
    try {
      if (oversized) {
        // Corrupt retained evidence beyond the public step limit, in addition
        // to the genuine begun step. No attempts or claim facts are fabricated.
        for (let index = 0; index < OWNER_EFFECT_STEP_LIMIT; index++) {
          const ref = {
            namespace: "space",
            actionRunId: "run",
            step: `extra-${index}`,
          };
          await f.db.query(
            "INSERT INTO owner_receipts(owner,principal_kind,principal_id,domain,key,kind,intent,result) VALUES('owner','worker','[\"worker\"]','logical',$1,'effect.begin',$2::jsonb,$3::jsonb)",
            [
              ownerEffectKey("owner", ref, "begin"),
              JSON.stringify(ref),
              JSON.stringify({ ...ref, status: "begun" }),
            ],
          );
        }
      } else {
        await f.db.query(
          "UPDATE owner_receipts SET kind='effect.invalid' WHERE kind='effect.begin'",
        );
      }
      const before = await durableSnapshot(f);
      await assert.rejects(f.recover(), {
        code: oversized ? "effect_step_limit" : "effect_state_invalid",
      });
      assert.equal(f.current.state, "acquired");
      assert.deepEqual(await durableSnapshot(f), before);
      assert.equal(await f.terminal(), null);
      await flushNotifications();
      assertNoNotifications(f);
      assert.deepEqual(f.state.errors, []);
    } finally {
      await f.close();
    }
  }
});

test("lost terminal publication and settlement failures preserve every remaining hint and close registration", async () => {
  for (const failure of ["publisher", "placement", "settlement"] as const) {
    const f = await terminalFixture("begun");
    try {
      f.state.failPublish = failure === "publisher";
      f.state.failPlacement = failure === "placement";
      f.state.failSettlementWake = failure === "settlement";
      assert.equal((await f.recover()).status, "committed");
      await flushNotifications();
      await assertCanonicalTerminal(f, "begun", false);
      assert.deepEqual(f.state.publications, ["work.failed"]);
      assert.deepEqual(f.state.scheduled, await continuationIds(f));
      assert.deepEqual(f.state.settlementWakes, [{
        namespace: "space",
        operationId: f.refs.eventId,
      }]);
      assert.equal(f.state.wakes, 1);
      assert.deepEqual(f.state.notificationOrder, [
        "publication",
        "placement",
        "settlement",
        "reconciliation",
      ]);
      if (failure === "publisher") {
        // The real coordinator intentionally absorbs publisher exceptions and
        // still places the continuation. Do not change that live contract.
        assert.deepEqual(f.state.errors, []);
      } else {
        // Placement throws from the genuine earlier terminal-publication group;
        // settlement throws from the real scheduler's staged callback. In both
        // cases the final bounded reconciliation hint must still be attempted.
        assert.equal(f.state.errors.length, 1);
        const error = f.state.errors[0];
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Lost Action scheduling failed/);
        assert.equal(error.errors.length, 1);
        assert.equal(
          error.errors[0].message,
          failure === "placement"
            ? "injected placement failure"
            : "injected settlement wake failure",
        );
      }
      const before = await durableSnapshot(f);
      const order = [...f.state.notificationOrder];
      assert.ok(f.state.lateRegistration);
      let lateCalls = 0;
      assert.throws(() =>
        f.state.lateRegistration!(() => {
          lateCalls++;
        }), {
        code: "owner_lost_action_refused",
      });
      await flushNotifications();
      assert.equal(lateCalls, 0);
      assert.deepEqual(f.state.notificationOrder, order);
      assert.deepEqual(await durableSnapshot(f), before);
    } finally {
      await f.close();
    }
  }
});

test("lost Action authorize requires the owner-control tag even with permissive policy", async () => {
  const f = await fixture({ maxAttempts: 1, permissiveControl: true });
  try {
    await f.takeover();
    const calls = f.state.controlCalls;
    for (
      const principal of [
        { kind: "worker", workerId: "owner" },
        { kind: "worker", workerId: "owner:owner" },
        {
          kind: "owner-local",
          ownerId: "owner",
          epoch: 2,
          holderId: "holder-2",
          deliveryId: f.refs.deliveryId,
          attemptId: "attempt:1",
        },
        { ownerId: "owner", epoch: 2, holderId: "holder-2" },
      ]
    ) {
      await assert.rejects(
        f.recovery.authorize(
          f.db,
          {
            principal: principal as OwnerCaller["principal"],
            ownerEpoch: 2,
          },
          f.command(),
          f.state.time,
        ),
        { code: "owner_lost_action_refused" },
      );
    }
    assert.equal(f.state.controlCalls, calls);
    await f.recovery.authorize(f.db, f.host(2), f.command(), f.state.time);
    assert.equal(f.state.controlCalls, calls + 1);
    assert.equal(await f.terminal(), null);
    assertNoNotifications(f);
  } finally {
    await f.close();
  }
});

for (const disposition of ["retry", "exhausted", "cancelled"] as const) {
  for (
    const deadline of [
      "2099-01-01T00:00:00.123456Z",
      "2099-01-01T05:30:00.000001+05:30",
    ]
  ) {
    test(`lost Action ${disposition} preserves the exact historical SQL deadline ${deadline}`, async () => {
      const f = await fixture({
        maxAttempts: disposition === "exhausted" ? 1 : 3,
        eligible: disposition === "retry",
        policy: disposition === "retry",
      });
      try {
        await f.db.query(
          "UPDATE event_deliveries SET lease_expires_at=$1::timestamptz WHERE id=$2",
          [deadline, f.refs.deliveryId],
        );
        if (disposition === "cancelled") {
          await f.db.query(
            "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE namespace='space' AND operation_id=$2",
            [at(99), f.refs.eventId],
          );
        }
        const prior = await f.store.getDelivery(f.refs.deliveryId);
        assert.equal(
          (await f.db.query(
            "SELECT lease_expires_at=$1::timestamptz AS rounded_matches FROM event_deliveries WHERE id=$2",
            [prior!.leaseExpiresAt, f.refs.deliveryId],
          )).rows[0].rounded_matches,
          false,
        );
        await f.takeover();
        const result = await f.recover();
        assert.equal(result.status, "committed");
        assert.equal(
          (result.result as { disposition: string }).disposition,
          disposition,
        );
        const current = await f.store.getDelivery(f.refs.deliveryId);
        assert.equal(
          current!.status,
          disposition === "retry"
            ? "retry_wait"
            : disposition === "exhausted"
            ? "dead_letter"
            : "cancelled",
        );
        assert.equal(current!.leaseExpiresAt, undefined);
        assert.equal(current!.attempts, prior!.attempts);
        assert.equal(current!.maxAttempts, prior!.maxAttempts);
        assert.equal(current!.availableAt, prior!.availableAt);
        if (disposition === "exhausted") {
          assert.equal(
            (current!.lastError as { name: string }).name,
            "DeliveryLeaseExpired",
          );
        }
        assert.equal(f.state.executions, 0);
        assert.equal(f.state.dispatches, 0);
        assert.equal((await f.recover()).status, "duplicate");
      } finally {
        await f.close();
      }
    });
  }
}

test("lost Action does not adopt a policy-time one-microsecond deadline change", async () => {
  let reached = false;
  const f = await fixture({
    async duringRecoveryPolicy(tx) {
      reached = true;
      await tx.query(
        "UPDATE event_deliveries SET lease_expires_at=lease_expires_at + interval '1 microsecond' WHERE id=$1",
        [f.refs.deliveryId],
      );
    },
  });
  try {
    const deadline = "2099-01-01T00:00:00.123456Z";
    await f.db.query(
      "UPDATE event_deliveries SET lease_expires_at=$1::timestamptz WHERE id=$2",
      [deadline, f.refs.deliveryId],
    );
    await f.takeover();
    const before = await durableSnapshot(f);
    await assert.rejects(
      f.recover(),
      (error: unknown) =>
        (error as { code?: string }).code === "owner_lost_action_refused",
    );
    assert.equal(reached, true);
    assert.deepEqual(await durableSnapshot(f), before);
    assert.equal(f.state.executions, 0);
    assert.equal(f.state.dispatches, 0);
    assert.equal(f.state.wakes, 0);
    assert.deepEqual(f.state.publications, []);
  } finally {
    await f.close();
  }
});

for (const deadline of ["infinity", "-infinity"]) {
  test(`historical deadline handoff still refuses ${deadline} without durable changes`, async () => {
    const f = await fixture();
    try {
      await f.db.query(
        "UPDATE event_deliveries SET lease_expires_at=$1::timestamptz WHERE id=$2",
        [deadline, f.refs.deliveryId],
      );
      await f.takeover();
      const before = await durableSnapshot(f);
      await assert.rejects(f.recover());
      assert.deepEqual(await durableSnapshot(f), before);
      assert.equal(f.state.executions, 0);
      assert.equal(f.state.dispatches, 0);
      assert.equal(f.state.wakes, 0);
    } finally {
      await f.close();
    }
  });
}
