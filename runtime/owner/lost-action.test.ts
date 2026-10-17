import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineProcessor } from "../plugins/processor.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
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
} from "./boundary.ts";
import { createOwnerExecutionCommands } from "./execution.ts";
import {
  createOwnerEffectCommands,
  readOwnerEffectInventory,
} from "./effects.ts";
import { ownerEffectKey } from "./effects-client.ts";
import {
  createOwnerLostActionRecovery,
  OWNER_LOST_ACTION_RECOVERY,
  ownerLostActionKey,
} from "./lost-action.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerOperationSettlement } from "./settlement.ts";

const start = "2020-01-01T00:00:00.000Z";
const at = (offset: number) =>
  new Date(Date.parse(start) + offset).toISOString();
async function fixture(
  options: {
    eligible?: boolean;
    maxAssignments?: number;
    maxAttempts?: number;
    policy?: boolean;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    time: start,
    eligible: options.eligible ?? true,
    policy: options.policy ?? true,
    control: true,
    rollback: false,
    unknown: false,
    wakes: 0,
    scheduled: [] as string[],
    publications: [] as string[],
    errors: [] as unknown[],
    mutatePolicy: false,
    noncooperativeWake: false,
    executions: 0,
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const result = await db.transaction(async (tx) => {
        const value = await run(tx);
        if (state.rollback) {
          state.rollback = false;
          throw new Error("injected rollback");
        }
        return value;
      });
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
  const catalog = createOperationCatalog(db, "public");
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
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "schedule-only",
    workloads: {},
    scheduleDelivery(value) {
      state.scheduled.push(typeof value === "string" ? value : value.id);
    },
    dispatchWork: () => Promise.reject(new Error("recovery cannot execute")),
    dispatchDelivery: () =>
      Promise.reject(new Error("recovery cannot execute")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("recovery cannot execute")),
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
    leaseMs: 10000,
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
    wake() {},
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
      const permitted = state.control &&
        caller.principal.kind === "owner-control";
      if (state.mutatePolicy) {
        Object.assign(caller, { ownerEpoch: 999 });
        Object.assign(caller.principal, { holderId: "mutated" });
      }
      return permitted;
    },
    authorizeRecoveryTransition(_tx, identity) {
      const permitted = state.policy;
      if (state.mutatePolicy) {
        Object.assign(identity, { deliveryId: "mutated" });
        Object.assign(identity.contract, { deliveryId: "mutated" });
      }
      return permitted;
    },
    scheduleSettlement: (ctx, scope) => settlement.schedule(ctx, scope),
    publish(event) {
      state.publications.push(event.type);
    },
    wake() {
      state.wakes++;
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
