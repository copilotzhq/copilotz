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
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerAssignmentControl,
  ownerAssignmentKey,
  provisionOwnerAssignments,
} from "../owner/assignments.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
} from "../owner/boundary.ts";
import { createOwnerExecutionCommands } from "../owner/execution.ts";
import { createOwnerEffectCommands } from "../owner/effects.ts";
import { ownerEffectKey } from "../owner/effects-client.ts";
import {
  createOwnerLostActionRecovery,
  OWNER_LOST_ACTION_RECOVERY,
  ownerLostActionKey,
} from "../owner/lost-action.ts";
import { provisionOwnerCommandSchema } from "../owner/schema.ts";
import { createOwnerOperationSettlement } from "../owner/settlement.ts";

const start = "2020-01-01T00:00:00.000Z";
const at = (offset: number) =>
  new Date(Date.parse(start) + offset).toISOString();
async function fixture(
  options: {
    eligible?: boolean;
    maxAssignments?: number;
    maxAttempts?: number;
    policy?: boolean;
    detached?: boolean;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    time: start,
    eligible: options.eligible ?? false,
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
    processorCalls: 0,
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
        settlement: options.detached ? "detached" : "inherit",
        handle() {
          state.processorCalls++;
        },
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
        async seed(input, ctx) {
          const spec = input as { run?: string; maxAttempts?: number } | null;
          const run = spec?.run ?? "run";
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
                  eventBodyId: `source-body:${run}`,
                  schemaVersion: 1,
                  mediaType: "application/json",
                },
              },
              metadata: {
                actionId: "work",
                actionRunId: run,
                actionMetadata: {},
              },
              deduplicationId: run,
            },
            body: { id: `source-body:${run}`, json: "value" },
            maxAttempts: spec?.maxAttempts ?? options.maxAttempts ?? 1,
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
  const worker = (value = bound): OwnerCaller => ({
    principal: { kind: "worker", workerId: value.workerId },
    ownerEpoch: 1,
    assignmentId: value.assignmentId,
    sessionId: value.sessionId,
    dispatchAttemptId: value.dispatchAttemptId,
    workerAttemptId: value.workerAttemptId,
    sessionGeneration: value.sessionGeneration,
    parentOperationId: value.parentOperationId,
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
    registry,
    session,
    catalog,
    executor,
    settlement,
    state,
    store,
    first,
    refs,
    target,
    recovery,
    command,
    worker,
    host,
    async seedLost(name: string, maxAttempts = 1) {
      const refs = (await first.execute(host(1), {
        kind: "seed",
        domain: "logical",
        key: `source:${name}`,
        intent: { run: name, maxAttempts },
      })).result as { eventId: string; deliveryId: string };
      const value = {
        ...binding(1),
        sourceEventId: refs.eventId,
        deliveryId: refs.deliveryId,
        executionId: name,
        assignmentId: `assignment:${name}`,
        sessionId: `session:${name}`,
        dispatchAttemptId: `attempt:${name}`,
      };
      await first.execute(host(1), assignmentCommand("assignment.bind", value));
      await first.execute(worker(value), {
        kind: "execution.claim",
        domain: "incarnation",
        key: ownerClaimKey("owner", value.assignmentId, value.sessionId),
        intent: {
          assignmentId: value.assignmentId,
          sessionId: value.sessionId,
        },
      });
      return { ...refs, namespace: "space", runId: name };
    },
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

import { createOwnerHost, type OwnerHostOptions } from "./owner-host.ts";
import {
  captureOwnerHostTerminalRecovery,
  createOwnerHostTerminalRecovery,
  type OwnerHostTerminalRecoveryFacts,
  type OwnerHostTerminalRecoveryOptions,
} from "./owner-host-terminal-recovery.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function hostOptions(
  f: Fixture,
  changes: Partial<OwnerHostOptions> = {},
): OwnerHostOptions {
  return {
    ownerId: "owner",
    holderId: "resumed",
    schema: "public",
    session: f.session,
    registry: f.registry,
    initialization: { mode: "resume", expectedEpoch: 1 },
    now: () => f.state.time,
    policy: {
      ingress: () => undefined,
      worker: () => ({ ctx: false, settlement: false }),
      input() {},
      collections: () => ({}),
      processorEvent() {},
      effectOutcome: () => false,
      effectNotStarted: () => false,
    },
    transport: { transports: [] },
    createTransport() {
      return {
        prepare() {},
        snapshot: () => ({}),
        shutdown: () => Promise.resolve(),
      } as never;
    },
    ...changes,
  };
}
function configuration(
  f: Fixture,
  authorizeTerminal: OwnerHostTerminalRecoveryOptions["authorizeTerminal"] =
    () => true,
) {
  return { targets: [{ ...f.target }], authorizeTerminal };
}
async function unchanged(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (
    const [table, order] of [
      ["events", "id"],
      ["event_bodies", "event_body_id"],
      ["event_deliveries", "id"],
      ["owner_assignments", "assignment_key"],
      ["open_actions", "action_run_id"],
      ["copilotz_operations", "operation_id"],
    ]
  ) {
    result[table] =
      (await f.db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
  }
  result.effects = (await f.db.query(
    "SELECT * FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY key",
  )).rows;
  return result;
}
async function corruptEvent(f: Fixture, sql: string, parameters: unknown[]) {
  // Deliberate fixture-only corruption; restore the exact immutable guard in
  // the same transaction. Production setup and all ordinary writes retain it.
  await f.db.transaction(async (tx) => {
    await tx.query(
      'ALTER TABLE events DISABLE TRIGGER "copilotz_events_immutable"',
    );
    await tx.query(sql, parameters);
    await tx.query(
      'ALTER TABLE events ENABLE TRIGGER "copilotz_events_immutable"',
    );
  });
}

test("terminal host captures closed dense own-data targets and callback without evaluating accessors", () => {
  let getters = 0;
  const valid = () => ({
    targets: [{ namespace: "space", deliveryId: "delivery" }],
    authorizeTerminal: () => true,
  });
  const bad: unknown[] = [
    null,
    undefined,
    [],
    {},
    { ...valid(), extra: true },
    { ...valid(), authorizeTerminal: null },
    { ...valid(), targets: [] },
    { ...valid(), targets: new Array(1) },
    {
      ...valid(),
      targets: Array.from(
        { length: 101 },
        (_, i) => ({ namespace: "space", deliveryId: `d${i}` }),
      ),
    },
    {
      ...valid(),
      targets: [{ namespace: "space", deliveryId: "delivery" }, {
        namespace: "space",
        deliveryId: "delivery",
      }],
    },
    { ...valid(), targets: [{ namespace: " space", deliveryId: "delivery" }] },
    {
      ...valid(),
      targets: [{ namespace: "space", deliveryId: "delivery", extra: true }],
    },
    {
      ...valid(),
      targets: [Object.create({ namespace: "space", deliveryId: "delivery" })],
    },
  ];
  for (const where of ["top", "target", "array"]) {
    const value = valid();
    const object = where === "top"
      ? value
      : where === "target"
      ? value.targets[0]
      : value.targets;
    Object.defineProperty(
      object,
      where === "top"
        ? "authorizeTerminal"
        : where === "target"
        ? "namespace"
        : "0",
      {
        enumerable: true,
        get() {
          getters++;
          return "space";
        },
      },
    );
    bad.push(value);
  }
  for (const extra of [Symbol("extra"), "hidden"]) {
    const value = valid();
    Object.defineProperty(value.targets, extra, { value: true });
    bad.push(value);
  }
  for (const value of bad) {
    assert.throws(() => captureOwnerHostTerminalRecovery(value as never));
  }
  assert.equal(getters, 0);
  const original = valid();
  const callback = original.authorizeTerminal;
  const captured = captureOwnerHostTerminalRecovery(original);
  original.targets[0].deliveryId = "mutated";
  original.authorizeTerminal = () => false;
  assert.equal(captured.targets[0].deliveryId, "delivery");
  assert.equal(captured.authorizeTerminal, callback);
});

test("terminal host refuses fresh, local and malformed private options before SQL", async () => {
  let calls = 0;
  const session: SqlSession = {
    query() {
      calls++;
      throw new Error("unexpected SQL");
    },
    transaction() {
      calls++;
      throw new Error("unexpected SQL");
    },
  };
  const fake = {
    session,
    registry: createPluginRegistry({}),
    state: { time: start },
  } as Fixture;
  for (
    const value of [null, {}, {
      targets: [],
      authorizeTerminal: () => true,
    }]
  ) {
    await assert.rejects(
      createOwnerHost(hostOptions(fake), undefined, undefined, value as never),
    );
  }
  await assert.rejects(
    createOwnerHost(
      { ...hostOptions(fake), initialization: "fresh" },
      undefined,
      undefined,
      {
        targets: [{ namespace: "space", deliveryId: "d" }],
        authorizeTerminal: () => true,
      },
    ),
  );
  await assert.rejects(
    createOwnerHost(hostOptions(fake), undefined, {} as never, {
      targets: [{ namespace: "space", deliveryId: "d" }],
      authorizeTerminal: () => true,
    }),
  );
  assert.equal(calls, 0);
});

async function assertCancelledNotification(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const rows = (await f.db.query(`SELECT d.status,d.attempts,
    (d.lease_owner IS NULL AND d.lease_expires_at IS NULL) AS lease_cleared,
    (NOT EXISTS(SELECT 1 FROM owner_alarms a WHERE a.name LIKE 'delivery:'||d.id||':%')) AS no_runnable_alarm
    FROM event_deliveries d WHERE d.consumer_id='processor:after'`)).rows;
  assert.deepEqual(rows, [{
    status: "cancelled",
    attempts: 0,
    lease_cleared: true,
    no_runnable_alarm: true,
  }]);
  assert.equal(f.state.processorCalls, 0);
  assert.equal(
    (await f.db.query(
      "SELECT 1 FROM owner_receipts WHERE kind='processor.claim'",
    )).rows.length,
    0,
  );
}

for (const cancelled of [false, true]) {
  test(`terminal host closes a genuine prior no-contract ${cancelled ? "cancelled" : "exhausted"} Action and retains its durable notification`, async () => {
    const f = await fixture({
      maxAttempts: cancelled ? 3 : 1,
      detached: cancelled,
    });
    let host: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
    const facts: OwnerHostTerminalRecoveryFacts[] = [];
    let transports = 0;
    try {
      if (cancelled) {
        await f.db.query(
          "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
          [at(10), f.refs.eventId],
        );
      }
      host = await createOwnerHost(
        hostOptions(f, {
          createTransport() {
            transports++;
            return {
              prepare() {},
              snapshot: () => ({}),
              shutdown: () => Promise.resolve(),
            } as never;
          },
        }),
        undefined,
        undefined,
        configuration(f, (_tx, value) => {
          facts.push(structuredClone(value));
          Object.assign(value.target, { deliveryId: "mutation" });
          return true;
        }),
      );
      assert.equal(host.snapshot().ready, true);
      assert.equal(transports, 1);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].disposition, cancelled ? "cancelled" : "exhausted");
      assert.equal(facts[0].owner.epoch, 2);
      const delivery = await f.store.getDelivery(f.refs.deliveryId);
      assert.equal(delivery?.status, cancelled ? "cancelled" : "dead_letter");
      assert.equal(delivery?.attempts, 1);
      assert.equal(
        (await f.terminal())?.status,
        cancelled ? "cancelled" : "failed",
      );
      assert.equal(
        (await f.db.query("SELECT 1 FROM open_actions")).rows.length,
        0,
      );
      if (cancelled) {
        await assertCancelledNotification(f);
      } else {
        assert.equal(
          (await f.db.query(
            "SELECT 1 FROM event_deliveries WHERE consumer_id='processor:after' AND status='pending'",
          )).rows.length,
          1,
        );
      }
      assert.equal(
        (await f.db.query(
          "SELECT 1 FROM owner_assignments WHERE retired=FALSE",
        )).rows.length,
        0,
      );
      assert.equal(
        (await f.db.query(
          "SELECT 1 FROM owner_receipts WHERE kind='execution.claim'",
        )).rows.length,
        1,
      );
      assert.equal(f.state.executions, 0);
    } finally {
      await host?.close();
      await f.close();
    }
  });
}

test("terminal host default deny and affirmative policy cannot requeue an unexhausted uncancelled Action", async () => {
  for (const configured of [false, true]) {
    const f = await fixture({ maxAttempts: 3 });
    let policy = 0, transports = 0;
    try {
      const before = await unchanged(f);
      await assert.rejects(createOwnerHost(
        hostOptions(f, {
          createTransport() {
            transports++;
            throw new Error("unexpected transport");
          },
        }),
        undefined,
        undefined,
        configured
          ? configuration(f, () => {
            policy++;
            return true;
          })
          : undefined,
      ));
      assert.deepEqual(await unchanged(f), before);
      assert.equal(policy, 0);
      assert.equal(transports, 0);
    } finally {
      await f.close();
    }
  }
});

test("terminal host current policy must return literal true and cannot alter current target coordinates", async () => {
  for (const scenario of ["false", "truthy", "attempts"]) {
    const f = await fixture();
    try {
      const before = await unchanged(f);
      await assert.rejects(
        createOwnerHost(
          hostOptions(f),
          undefined,
          undefined,
          configuration(f, async (tx) => {
            if (scenario === "attempts") {
              await tx.query(
                "UPDATE event_deliveries SET max_attempts=max_attempts+1 WHERE id=$1",
                [f.refs.deliveryId],
              );
            }
            return (scenario === "false"
              ? false
              : scenario === "truthy"
              ? 1
              : true) as boolean;
          }),
        ),
      );
      assert.deepEqual(await unchanged(f), before);
      assert.equal(await f.terminal(), null);
    } finally {
      await f.close();
    }
  }
});

for (
  const coordinate of ["lease_expires_at", "cancellation_requested_at"] as const
) {
  test(`terminal host rejects a post-policy change to ${coordinate}`, async () => {
    const f = await fixture();
    try {
      if (coordinate === "cancellation_requested_at") {
        await f.db.query(
          "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
          [at(10), f.refs.eventId],
        );
      }
      const before = await unchanged(f);
      await assert.rejects(
        createOwnerHost(
          hostOptions(f),
          undefined,
          undefined,
          configuration(f, async (tx) => {
            await tx.query(
              coordinate === "lease_expires_at"
                ? "UPDATE event_deliveries SET lease_expires_at='2099-01-01T00:00:00.000001Z'::timestamptz WHERE id=$1"
                : "UPDATE copilotz_operations SET cancellation_requested_at=cancellation_requested_at+INTERVAL '1 microsecond' WHERE root_event_id=$1",
              [
                coordinate === "lease_expires_at"
                  ? f.refs.deliveryId
                  : f.refs.eventId,
              ],
            );
            return true;
          }),
        ),
        /changed/,
      );
      assert.deepEqual(await unchanged(f), before);
      assert.equal(await f.terminal(), null);
    } finally {
      await f.close();
    }
  });
}

for (const mismatch of ["missing", "namespace", "processor"] as const) {
  test(`terminal host explicitly accounts for ${mismatch} configured targets`, async () => {
    const f = await fixture();
    try {
      const target = { ...f.target };
      if (mismatch === "missing") target.deliveryId = "absent";
      if (mismatch === "namespace") target.namespace = "foreign";
      if (mismatch === "processor") {
        await f.db.query(
          "UPDATE event_deliveries SET consumer_id='processor:after',status='succeeded',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [f.refs.deliveryId],
        );
      }
      const before = await unchanged(f);
      let policy = 0;
      await assert.rejects(
        createOwnerHost(hostOptions(f), undefined, undefined, {
          targets: [target],
          authorizeTerminal() {
            policy++;
            return true;
          },
        }),
      );
      assert.equal(policy, 0);
      assert.deepEqual(await unchanged(f), before);
    } finally {
      await f.close();
    }
  });
}

for (
  const corruption of [
    "delivery-scope",
    "open-scope",
    "preparation",
    "action-metadata",
    "input",
  ] as const
) {
  test(`terminal host refuses unsupported ${corruption} before mutation`, async () => {
    const f = await fixture();
    try {
      if (corruption === "delivery-scope") {
        await f.db.query(
          "UPDATE event_deliveries SET action_scope_id='deferred' WHERE id=$1",
          [f.refs.deliveryId],
        );
      }
      if (corruption === "open-scope") {
        await f.db.query(
          "UPDATE open_actions SET action_scope_id='deferred' WHERE owner_delivery_id=$1",
          [f.refs.deliveryId],
        );
      }
      if (corruption === "preparation") {
        await corruptEvent(
          f,
          "UPDATE events SET metadata=metadata || '{\"preparation\":null}'::jsonb WHERE id=$1",
          [f.refs.eventId],
        );
      }
      if (corruption === "action-metadata") {
        await corruptEvent(
          f,
          "UPDATE events SET metadata=jsonb_set(metadata,'{actionMetadata}','[]'::jsonb) WHERE id=$1",
          [f.refs.eventId],
        );
      }
      if (corruption === "input") {
        await corruptEvent(
          f,
          "UPDATE events SET payload='{}'::jsonb WHERE id=$1",
          [f.refs.eventId],
        );
      }
      const before = await unchanged(f);
      let policy = 0;
      await assert.rejects(
        createOwnerHost(
          hostOptions(f),
          undefined,
          undefined,
          configuration(f, () => {
            policy++;
            return true;
          }),
        ),
      );
      assert.deepEqual(await unchanged(f), before);
      assert.equal(policy, 0);
      assert.equal(await f.terminal(), null);
    } finally {
      await f.close();
    }
  });
}

test("terminal host retains begun effects after durable cleanup and cannot publish readiness", async () => {
  const f = await fixture();
  let transports = 0;
  try {
    await f.effect("begin");
    const effects = (await f.db.query(
      "SELECT * FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY key",
    )).rows;
    await assert.rejects(createOwnerHost(
      hostOptions(f, {
        createTransport() {
          transports++;
          throw new Error("unexpected transport");
        },
      }),
      undefined,
      undefined,
      configuration(f),
    ));
    assert.equal(
      (await f.store.getDelivery(f.refs.deliveryId))?.status,
      "dead_letter",
    );
    const terminal = await f.terminal();
    assert.equal(terminal?.status, "failed");
    if (terminal?.status === "failed") {
      assert.equal(terminal.error.code, "effect_indeterminate");
    }
    assert.deepEqual(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind LIKE 'effect.%' ORDER BY key",
      )).rows,
      effects,
    );
    assert.equal(transports, 0);
    assert.equal(f.state.executions, 0);
  } finally {
    await f.close();
  }
});

test("terminal host independently proves already terminal targets on a later resume without policy or another command", async () => {
  const f = await fixture();
  let first: Awaited<ReturnType<typeof createOwnerHost>> | undefined,
    second: typeof first;
  try {
    first = await createOwnerHost(
      hostOptions(f),
      undefined,
      undefined,
      configuration(f),
    );
    await first.close();
    first = undefined;
    const receipts =
      (await f.db.query("SELECT * FROM owner_receipts WHERE kind=$1", [
        OWNER_LOST_ACTION_RECOVERY,
      ])).rows;
    let policy = 0;
    second = await createOwnerHost(
      hostOptions(f, {
        holderId: "third",
        initialization: { mode: "resume", expectedEpoch: 2 },
      }),
      undefined,
      undefined,
      configuration(f, () => {
        policy++;
        return true;
      }),
    );
    assert.equal(second.snapshot().ready, true);
    assert.equal(policy, 0);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM owner_receipts WHERE kind=$1", [
        OWNER_LOST_ACTION_RECOVERY,
      ])).rows,
      receipts,
    );
  } finally {
    await first?.close();
    await second?.close();
    await f.close();
  }
});

test("terminal host repeats exact target accounting after transport construction", async () => {
  const f = await fixture();
  let change = false, shutdowns = 0;
  const session: SqlSession = {
    query: f.db.query,
    async transaction(run) {
      if (change) {
        change = false;
        await f.db.query(
          "UPDATE event_deliveries SET consumer_id='processor:after' WHERE id=$1",
          [f.refs.deliveryId],
        );
      }
      return await f.db.transaction(run);
    },
  };
  try {
    await assert.rejects(
      createOwnerHost(
        hostOptions(f, {
          session,
          createTransport() {
            change = true;
            return {
              prepare() {},
              snapshot: () => ({}),
              shutdown() {
                shutdowns++;
                return Promise.resolve();
              },
            } as never;
          },
        }),
        undefined,
        undefined,
        configuration(f),
      ),
    );
    assert.equal(shutdowns, 1);
  } finally {
    await f.close();
  }
});

for (const committed of [false, true]) {
  test(`terminal host stops on ${committed ? "committed" : "aborted"} unknown terminal result without retry`, async () => {
    const f = await fixture();
    let terminalTransaction = false, transports = 0;
    let successor: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
    const session: SqlSession = {
      query: f.db.query,
      async transaction(run) {
        const result = await f.db.transaction(async (tx) => {
          const value = await run(tx);
          if (terminalTransaction && !committed) {
            terminalTransaction = false;
            throw new Error("injected terminal rollback");
          }
          return value;
        });
        if (terminalTransaction) {
          terminalTransaction = false;
          throw new Error("lost terminal COMMIT reply");
        }
        return result;
      },
    };
    try {
      await assert.rejects(
        createOwnerHost(
          hostOptions(f, {
            session,
            createTransport() {
              transports++;
              throw new Error("unexpected transport");
            },
          }),
          undefined,
          undefined,
          configuration(f, () => {
            terminalTransaction = true;
            return true;
          }),
        ),
        { code: "owner_commit_unknown" },
      );
      assert.equal(
        (await f.store.getDelivery(f.refs.deliveryId))?.status,
        committed ? "dead_letter" : "leased",
      );
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_receipts WHERE kind=$1", [
          OWNER_LOST_ACTION_RECOVERY,
        ])).rows.length,
        committed ? 1 : 0,
      );
      assert.equal(transports, 0);
      assert.equal(f.state.executions, 0);
      let successorPolicy = 0;
      successor = await createOwnerHost(
        hostOptions(f, {
          holderId: "successor",
          initialization: { mode: "resume", expectedEpoch: 2 },
        }),
        undefined,
        undefined,
        configuration(f, () => {
          successorPolicy++;
          return true;
        }),
      );
      assert.equal(successor.snapshot().ready, true);
      assert.equal(successorPolicy, committed ? 0 : 1);
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_receipts WHERE kind=$1", [
          OWNER_LOST_ACTION_RECOVERY,
        ])).rows.length,
        1,
      );
      assert.equal(
        (await f.store.getDelivery(f.refs.deliveryId))?.status,
        "dead_letter",
      );
      assert.equal(f.state.executions, 0);
    } finally {
      await successor?.close();
      await f.close();
    }
  });
}

test("terminal host exact inventory leaves unrelated lost delivery unchanged after selected durable progress", async () => {
  const f = await fixture();
  try {
    const other = await f.seedLost("other");
    const before = await f.store.getDelivery(other.deliveryId);
    let calls = 0;
    await assert.rejects(
      createOwnerHost(
        hostOptions(f),
        undefined,
        undefined,
        configuration(f, () => {
          calls++;
          return true;
        }),
      ),
    );
    assert.equal(calls, 1);
    assert.equal(
      (await f.store.getDelivery(f.refs.deliveryId))?.status,
      "dead_letter",
    );
    assert.deepEqual(await f.store.getDelivery(other.deliveryId), before);
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM events WHERE deduplication_id='other:action:terminal'",
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("terminal host preserves a refused later configured target after earlier known terminal commit", async () => {
  const f = await fixture();
  try {
    const other = await f.seedLost("other");
    const before = await f.store.getDelivery(other.deliveryId);
    const calls: string[] = [];
    await assert.rejects(createOwnerHost(hostOptions(f), undefined, undefined, {
      targets: [f.target, { namespace: "space", deliveryId: other.deliveryId }],
      authorizeTerminal(_tx, facts) {
        calls.push(facts.target.deliveryId);
        return facts.target.deliveryId === f.refs.deliveryId;
      },
    }));
    assert.deepEqual(calls, [f.refs.deliveryId, other.deliveryId]);
    assert.equal(
      (await f.store.getDelivery(f.refs.deliveryId))?.status,
      "dead_letter",
    );
    assert.deepEqual(await f.store.getDelivery(other.deliveryId), before);
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM events WHERE deduplication_id='other:action:terminal'",
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("terminal host missing target in a mixed inventory cannot disappear behind a real lost target", async () => {
  const f = await fixture();
  try {
    const before = await unchanged(f);
    let calls = 0;
    await assert.rejects(
      createOwnerHost(hostOptions(f), undefined, undefined, {
        targets: [f.target, { namespace: "space", deliveryId: "absent" }],
        authorizeTerminal() {
          calls++;
          return true;
        },
      }),
    );
    assert.equal(calls, 0);
    assert.deepEqual(await unchanged(f), before);
  } finally {
    await f.close();
  }
});

test("terminal host private control refuses forged tokens and rechecks actual current authority after held policy", async () => {
  const f = await fixture();
  let current = true, release!: () => void, reached!: () => void;
  const policyReached = new Promise<void>((resolve) => reached = resolve),
    policyRelease = new Promise<void>((resolve) => release = resolve);
  const helper = createOwnerHostTerminalRecovery({
    configuration: captureOwnerHostTerminalRecovery(
      configuration(f, async () => {
        reached();
        await policyRelease;
        return true;
      }),
    ),
    ownerId: "owner",
    schema: "public",
    session: f.session,
    registry: f.registry,
    catalog: f.catalog,
    executor: f.executor,
    scheduleSettlement: f.settlement.schedule,
    currentOwner: () =>
      current ? { ownerId: "owner", epoch: 2, holderId: "private" } : undefined,
  });
  const boundary = createOwnerCommandBoundary({
    ownerId: "owner",
    holderId: "private",
    schema: "public",
    session: f.session,
    now: () => f.state.time,
    handlers: helper.handlers,
    authorize: helper.authorize,
    authenticateReceipt() {
      throw new Error("no authority");
    },
  });
  try {
    await boundary.acquire(1);
    const before = await unchanged(f);
    const occurrence = "forged",
      command = {
        kind: OWNER_LOST_ACTION_RECOVERY,
        domain: "occurrence" as const,
        key: ownerLostActionKey("owner", 2, f.target, occurrence),
        intent: { ...f.target, occurrence },
      };
    for (
      const principal of [
        {
          kind: "owner-control",
          ownerId: "owner",
          epoch: 2,
          holderId: "private",
        },
        { kind: "worker", workerId: "worker" },
        {
          kind: "owner-local",
          ownerId: "owner",
          epoch: 2,
          holderId: "private",
        },
      ]
    ) {
      await assert.rejects(
        boundary.execute(
          { principal, ownerEpoch: 2, hostControl: "forged" } as never,
          command,
        ),
      );
    }
    const pending = helper.recover(boundary, f.target);
    await policyReached;
    current = false;
    release();
    await assert.rejects(pending);
    assert.deepEqual(await unchanged(f), before);
    assert.equal(await f.terminal(), null);
  } finally {
    release();
    boundary.stop();
    await f.close();
  }
});

test("terminal host private current authority is rechecked after the held second target read", async () => {
  const f = await fixture();
  let current = true, release!: () => void, reached!: () => void;
  const policyReached = new Promise<void>((resolve) => reached = resolve),
    policyRelease = new Promise<void>((resolve) => release = resolve);
  let reads = 0;
  const session: SqlSession = {
    query: f.session.query,
    transaction: (run) =>
      f.session.transaction((tx) => {
        const query: SqlExecutor["query"] = async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("END AS source_event_id") && ++reads === 2) {
            reached();
            await policyRelease;
          }
          return result as never;
        };
        return run({ query });
      }),
  };
  const helper = createOwnerHostTerminalRecovery({
    configuration: captureOwnerHostTerminalRecovery(configuration(f)),
    ownerId: "owner",
    schema: "public",
    session,
    registry: f.registry,
    catalog: f.catalog,
    executor: f.executor,
    scheduleSettlement: f.settlement.schedule,
    currentOwner: () =>
      current ? { ownerId: "owner", epoch: 2, holderId: "private" } : undefined,
  });
  const boundary = createOwnerCommandBoundary({
    ownerId: "owner",
    holderId: "private",
    schema: "public",
    session,
    now: () => f.state.time,
    handlers: helper.handlers,
    authorize: helper.authorize,
    authenticateReceipt() {
      throw new Error("no authority");
    },
  });
  try {
    await boundary.acquire(1);
    const before = await unchanged(f);
    const pending = helper.recover(boundary, f.target);
    await policyReached;
    current = false;
    release();
    await assert.rejects(pending);
    assert.deepEqual(await unchanged(f), before);
    assert.equal(await f.terminal(), null);
  } finally {
    release();
    boundary.stop();
    await f.close();
  }
});

import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import { createOwnerConnectedWorker } from "./owner-worker.ts";
const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() >= until) {
      throw new Error("Terminal continuation fixture timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
for (const mode of ["in-process", "websocket"] as const) {
  for (const cancelled of [false, true]) {
    test(
      `terminal host real ${mode} ${
        cancelled
          ? "cancelled notification stays unexecuted"
          : "exhausted inherited continuation executes"
      } after cleanup`,
      { skip: !sourceRoot, timeout: 45_000 },
      async () => {
        const { entrypoints } = await resolveOxianSource(sourceRoot!);
        const { createHypervisor } = await import(entrypoints["./hypervisor"]);
        const { createWorker } = await import(entrypoints["./worker"]);
        const { serve } = await import(entrypoints["./adapters/node"]);
        const f = await fixture({
          maxAttempts: cancelled ? 3 : 1,
          detached: cancelled,
        });
        let host: Awaited<ReturnType<typeof createOwnerHost>> | undefined;
        let worker: ReturnType<typeof createOwnerConnectedWorker> | undefined;
        let listener: Awaited<ReturnType<typeof serve>> | undefined;
        let actionFactories = 0, processorFactories = 0;
        const errors: unknown[] = [];
        try {
          if (cancelled) {
            await f.db.query(
              "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
              [at(10), f.refs.eventId],
            );
          }
          const local = {
            type: "in-process" as const,
            config: { topic: crypto.randomUUID() },
          };
          const base = hostOptions(f);
          host = await createOwnerHost(
            {
              ...base,
              policy: {
                ...base.policy,
                worker: () => ({ ctx: true, settlement: true }),
              },
              onError(error) {
                errors.push(error);
              },
              transport: {
                transports: mode === "websocket"
                  ? [{ type: "websocket", config: { path: "/workers" } }]
                  : [local],
                admit: ({ identity, credential, workloads, capacity }) => ({
                  definition: {
                    workerId: identity.workerId,
                    providerId: "fixture",
                    workloads,
                    capacity,
                    providerConfig: {},
                    labels: {},
                  },
                  sessionGeneration: 1,
                  authenticatedWith: credential.kind,
                  resume: {
                    credential: { kind: "resume", capability: "fixture" },
                    expiresAtMs: Date.now() + 60_000,
                  },
                }),
              },
              createTransport: createHypervisor,
            },
            undefined,
            undefined,
            configuration(f),
          );
          assert.equal(host.snapshot().ready, true);
          assert.equal(f.state.processorCalls, 0);
          listener = mode === "websocket"
            ? await serve({ hypervisor: host.listener })
            : undefined;
          const url = listener ? new URL("/workers", listener.url) : undefined;
          if (url) url.protocol = "ws:";
          worker = createOwnerConnectedWorker({
            registry: f.registry,
            ownerId: "owner",
            namespace: "space",
            worker: {
              id: "continuation",
              transport: url
                ? {
                  type: "websocket",
                  config: { url, allowInsecureLoopback: true },
                }
                : local,
              capacity: 2,
              hostCalls: { maxConcurrent: 16, timeoutMs: 10_000 },
              activate: () => ({
                workerId: "continuation",
                attemptId: crypto.randomUUID(),
                epoch: 1,
              }),
              register: () => ({
                credential: { kind: "registration", capability: "fixture" },
                expiresAtMs: Date.now() + 60_000,
              }),
              reconnectDelay: false,
            } as never,
            createCapabilities() {
              actionFactories++;
              return { resources: {}, adapters: {} };
            },
            createProcessorCapabilities() {
              processorFactories++;
              return { resources: {}, adapters: {} };
            },
          }, createWorker);
          await worker.ready;
          await host.wake();
          if (cancelled) {
            await assertCancelledNotification(f);
          } else {
            await eventually(async () =>
              f.state.processorCalls === 1 &&
              (await f.db.query(
                  "SELECT 1 FROM event_deliveries WHERE consumer_id='processor:after' AND status='succeeded'",
                )).rows.length === 1
            );
          }
          await eventually(async () =>
            (await f.db.query(
              "SELECT state FROM copilotz_operations WHERE operation_id=$1",
              [f.refs.eventId],
            )).rows[0].state === (cancelled ? "cancelled" : "failed")
          );
          assert.equal(actionFactories, 0);
          assert.equal(processorFactories, cancelled ? 0 : 1);
          assert.equal(f.state.executions, 0);
          assert.equal(
            (await f.db.query(
              "SELECT 1 FROM owner_receipts WHERE kind='execution.claim'",
            )).rows.length,
            1,
          );
          assert.equal(
            (await f.db.query(
              "SELECT 1 FROM owner_receipts WHERE kind='processor.claim'",
            )).rows.length,
            cancelled ? 0 : 1,
          );
          assert.deepEqual(errors, []);
        } finally {
          await worker?.close("fixture finished");
          await host?.close();
          await listener?.shutdown();
          await f.close();
        }
      },
    );
  }
}

for (const deadline of ["infinity", "-infinity"]) {
  test(`terminal host refuses post-policy ${deadline} instead of treating it as a non-expiring attempt`, async () => {
    const f = await fixture();
    let policyCalls = 0;
    try {
      const before = await unchanged(f);
      await assert.rejects(
        createOwnerHost(
          hostOptions(f),
          undefined,
          undefined,
          configuration(f, async (tx) => {
            policyCalls++;
            await tx.query(
              "UPDATE event_deliveries SET lease_expires_at=$1::timestamptz WHERE id=$2",
              [deadline, f.refs.deliveryId],
            );
            return true;
          }),
        ),
        { code: "owner_host_terminal_recovery_refused" },
      );
      assert.equal(policyCalls, 1);
      assert.deepEqual(await unchanged(f), before);
      assert.equal(await f.terminal(), null);
    } finally {
      await f.close();
    }
  });
}
