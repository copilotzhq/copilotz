import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import {
  createRegisteredLocalActionExecution,
  type RegisteredLocalActionPort,
} from "../execution/registered-local.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerAssignmentControl,
  provisionOwnerAssignments,
} from "./assignments.ts";
import type { OwnerLocalActionAssignmentBinding } from "./placement-binding.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandBoundary,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerCollectionCommand,
  type OwnerCollectionScope,
} from "./collections.ts";
import { createOwnerExecutionCommands } from "./execution.ts";
import { createOwnerLocalActionPort } from "./local-action-port.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const now = "2020-01-01T00:00:00.000Z";
const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
    required: ["title"],
  } as const,
});
const write: OwnerCommand = {
  kind: "collections",
  domain: "logical",
  key: "run/write",
  intent: {
    operations: [{
      collection: "notes",
      operation: "create",
      input: { title: "ordinary" },
    }],
  },
};
async function snapshot(db: SqlExecutor) {
  const result: Record<string, unknown> = {};
  for (
    const name of [
      "events",
      "event_deliveries",
      "event_bodies",
      "nodes",
      "open_actions",
      "owner_assignments",
      "owner_receipts",
      "owner_receipt_readers",
    ]
  ) {
    result[name] = (await db.query(
      `SELECT row_to_json(t) AS row FROM ${name} t ORDER BY row_to_json(t)::text`,
    )).rows;
  }
  return result;
}
async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const secretControl = crypto.randomUUID(), secretLocal = crypto.randomUUID();
  let binding!: OwnerLocalActionAssignmentBinding;
  const state = {
    current: true,
    control: true,
    phase: "reserved" as "reserved" | "running" | "terminal",
    ctx: true,
    settlement: true,
    collectionAllowed: true,
    scopeCalls: 0,
    completionCalls: 0,
    authoredCalls: 0,
    started: 0,
    terminal: 0,
    unknown: "" as "" | "committed" | "aborted",
    policyAwait: undefined as undefined | (() => Promise<void>),
    scopeChange: undefined as
      | undefined
      | ((scope: OwnerCollectionScope) => OwnerCollectionScope),
    retainedScope: undefined as undefined | OwnerCollectionScope,
    afterResolve: undefined as undefined | (() => void),
    queryHook: undefined as undefined | ((sql: string) => void),
  };
  const controlCaller = (): OwnerCaller => ({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    hostControl: secretControl,
  });
  const localCaller = (): OwnerCaller => ({
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId: binding.deliveryId,
      attemptId: binding.attemptId,
    },
    ownerEpoch: 1,
    hostLocal: secretLocal,
  });
  const currentLocal = (who: OwnerCaller) => {
    const p = who.principal;
    return state.current && state.phase === "running" &&
        who.hostLocal === secretLocal && p.kind === "owner-local" &&
        p.ownerId === binding.ownerId && p.epoch === binding.epoch &&
        who.ownerEpoch === binding.epoch && p.holderId === binding.holderId &&
        p.deliveryId === binding.deliveryId && p.attemptId === binding.attemptId
      ? binding
      : undefined;
  };
  const assignments = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    maxActive: 1,
    authorizeControl(_tx, who) {
      if (!state.control || who.hostControl !== secretControl) {
        throw new Error("control denied");
      }
    },
    isCurrentStarted: () => false,
    resolveCurrentLocal: currentLocal,
    hasAction: (id) => id === "work",
  });
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const unknown = state.unknown;
      state.unknown = "";
      const result = await db.transaction(async (tx) => {
        const value = await run({
          query(sql, values) {
            state.queryHook?.(sql);
            return tx.query(sql, values);
          },
        });
        if (unknown === "aborted") {
          throw Object.assign(new Error("unknown rollback"), {
            code: "persistence_indeterminate",
          });
        }
        return value;
      });
      if (unknown === "committed") {
        throw Object.assign(new Error("unknown commit reply"), {
          code: "persistence_indeterminate",
        });
      }
      return result;
    },
  };
  const action = defineAction({
    id: "work",
    async execute(_input: unknown, ctx: ActionContext) {
      state.authoredCalls++;
      const value = await ctx.transaction(async ({ collections }) => {
        const row = await collections.notes.create({ title: "ordinary" });
        return { id: row.id, local: new Map([["kept", true]]) };
      }, { operationKey: "write" });
      assert.equal(value.local.get("kept"), true);
      return { id: value.id };
    },
  });
  const registry = createPluginRegistry({
    actions: { work: action },
    collections: { notes },
  });
  const catalog = createOperationCatalog(db, "public"),
    store = createEventStore({ session: db, now: () => new Date(now) });
  // A scheduling sink only: no worker, transport, fake worker identity or Processor.
  const refuseDispatch = () =>
    Promise.reject(new Error("dispatch is outside this fixture"));
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "unused",
    workloads: {},
    scheduleDelivery() {},
    dispatchWork: refuseDispatch,
    dispatchDelivery: refuseDispatch,
    dispatchRecoverable: refuseDispatch,
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const execution = createOwnerExecutionCommands({
    ownerId: "owner",
    session,
    schema: "public",
    registry,
    catalog,
    executor,
    local: {
      authorizeStart(_tx, who, candidate) {
        return state.control && state.current && state.phase === "reserved" &&
          who.hostControl === secretControl &&
          JSON.stringify(candidate) === JSON.stringify(binding);
      },
      reserveLocal: assignments.reserveLocal,
      retireLocal: assignments.retireLocal,
    },
    async resolveAssignment(tx, who) {
      const found = await assignments.resolveLocal(tx, who);
      state.afterResolve?.();
      if (!found || found.kind !== "action") return undefined;
      return {
        ...found,
        ctxGranted: state.ctx,
        settlementGranted: state.settlement,
        invocation: {
          actionRunId: found.actionRunId,
          rootKey: "untrusted",
          operationKey: "untrusted",
          metadata: {},
        },
      };
    },
    authorizeInput() {},
  });
  const scopes = new WeakMap<SqlExecutor, OwnerCollectionScope>();
  const collectionOptions = {
    session,
    schema: "public",
    registry,
    collections: { notes },
    executor,
    catalog,
    scope(
      context: Parameters<ReturnType<typeof createOwnerCollectionCommand>>[1],
    ) {
      state.scopeCalls++;
      const scope = scopes.get(context.tx);
      assert.ok(scope);
      state.retainedScope = state.scopeChange
        ? state.scopeChange(scope)
        : scope;
      return state.retainedScope;
    },
  };
  const collection = createOwnerCollectionCommand(collectionOptions);
  const boundary = createOwnerCommandBoundary({
    session,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => now,
    handlers: {
      ...execution.handlers,
      collections: collection,
      async seed(_value, context) {
        const seeded = await createEventStore({
          session: db,
          ownerCommit: context.ownerCommit,
          admitOperationEventSql: catalog.admitEventSql.bind(catalog),
          indexOperationEventSql: catalog.indexEventSql.bind(catalog),
          indexOperationEvent: catalog.indexEvent.bind(catalog),
        }).commitMutation({
          transaction: context.tx,
          draft: {
            type: "copilotz.owner.action.requested",
            namespace: "space",
            payload: {
              dataRef: {
                eventBodyId: "body",
                schemaVersion: 1,
                mediaType: "application/json",
              },
            },
            metadata: {
              actionId: "work",
              actionRunId: "run",
              actionMetadata: { origin: "source" },
              rootKey: "root",
            },
            deduplicationId: "run",
            correlationId: "correlation",
          },
          body: { id: "body", json: { source: true } },
          consumers: [{ consumerId: "registered:work", settlement: "inherit" }],
        });
        return {
          eventId: seeded.event.id,
          deliveryId: seeded.deliveries[0].id,
        };
      },
      async cancel(_value, context) {
        await catalog.requestCancellation(
          context.tx,
          binding.namespace,
          binding.sourceEventId,
          "test cancellation",
          context.commandTime,
        );
        return null;
      },
    },
    projections: execution.projections,
    inputDefinitions: execution.inputDefinitions,
    async authorize(tx, who, command, time, input) {
      if (command.kind === "seed" || command.kind === "cancel") {
        if (
          !state.control || who.hostControl !== secretControl ||
          who.principal.kind !== "owner-control"
        ) throw new Error("private control denied");
        return;
      }
      if (command.kind === "collections") {
        const current = await execution.authorizeLive(tx, who, time);
        if (
          command.domain !== "logical" || !command.key.startsWith("run/")
        ) throw new Error("Collection key denied");
        await state.policyAwait?.();
        if (!state.collectionAllowed || !currentLocal(who)) {
          throw new Error("current Collection policy denied");
        }
        scopes.set(tx, {
          namespace: current.namespace,
          identity: {
            ...current.invocation.identity,
            deliveryLease: {
              deliveryId: current.deliveryId,
              owner: binding.attemptId,
            },
          },
          attempt: binding,
        });
        return;
      }
      if (command.kind === "execution.complete") state.completionCalls++;
      await execution.authorize(tx, who, command, time, input);
    },
    authenticateReceipt() {
      throw new Error("receipt recovery forbidden");
    },
  });
  await boundary.acquire(0);
  const seeded = await boundary.execute(controlCaller(), {
    kind: "seed",
    domain: "logical",
    key: "seed",
    intent: null,
  });
  const source = seeded.result as { eventId: string; deliveryId: string };
  binding = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: source.eventId,
    deliveryId: source.deliveryId,
    kind: "action",
    actionId: "work",
    actionRunId: "run",
  };
  const makePort = (
    actual: Pick<OwnerCommandBoundary, "execute" | "executeInput" | "project"> =
      boundary,
  ) =>
    createOwnerLocalActionPort({
      boundary: actual,
      reference: binding,
      controlCaller: controlCaller(),
      localCaller: localCaller(),
      isCurrent: () => state.current,
      onStarted() {
        state.started++;
        state.phase = "running";
      },
      onTerminal() {
        state.terminal++;
        state.phase = "terminal";
      },
    });
  const makeDriver = (port: RegisteredLocalActionPort) =>
    createRegisteredLocalActionExecution({
      registry,
      reference: binding,
      owner: port,
      isCurrent: () => state.current,
      createCapabilities: () => ({ resources: {}, adapters: {} }),
      onIndeterminate() {},
    });
  const cancel = () =>
    boundary.execute(controlCaller(), {
      kind: "cancel",
      domain: "logical",
      key: "cancel",
      intent: null,
    });
  return {
    db,
    state,
    store,
    boundary,
    binding,
    localCaller,
    controlCaller,
    collectionOptions,
    catalog,
    makePort,
    makeDriver,
    cancel,
    async close() {
      boundary.stop();
      await db.close();
    },
  };
}

test("actual local driver commits Collection event/row and terminal/retirement with one NULL-lease attempt", async () => {
  const f = await fixture();
  try {
    const port = f.makePort(), driver = f.makeDriver(port);
    const result = await driver.run();
    await driver.quiescent;
    assert.equal(result.completion.status, "completed");
    assert.equal(f.state.authoredCalls, 1);
    assert.equal(f.state.started, 1);
    assert.equal(f.state.terminal, 1);
    assert.equal(f.state.completionCalls, 1);
    const delivery = await f.store.getDelivery(f.binding.deliveryId);
    assert.equal(delivery?.attempts, 1);
    assert.equal(delivery?.leaseExpiresAt, undefined);
    assert.equal(delivery?.status, "succeeded");
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      true,
    );
    assert.equal(
      (await f.db.query("SELECT id FROM nodes WHERE type='note'")).rows.length,
      1,
    );
    const events = (await f.db.query(
      "SELECT id,type,causation_id,correlation_id,deduplication_id FROM events ORDER BY seq",
    )).rows;
    assert.equal(events.filter((e) => e.type === "work.invoked").length, 1);
    const created = events.find((e) => e.type === "note.created");
    assert.ok(created);
    assert.equal(created.causation_id, f.binding.sourceEventId);
    assert.equal(created.correlation_id, "correlation");
    assert.equal(delivery?.settlementScopeId, f.binding.sourceEventId);
    const indexed = await f.catalog.listOperationEventIds({
      namespace: f.binding.namespace,
      operationId: f.binding.sourceEventId,
    });
    assert.ok(indexed.some((event) => event.eventId === created.id));
    assert.deepEqual(
      (await f.db.query(
        "SELECT operation_id FROM copilotz_operation_events WHERE event_id=$1",
        [created.id],
      )).rows,
      [{ operation_id: f.binding.sourceEventId }],
    );
    const terminal = await createActionLifecycleLoader({ store: f.store })(
      "space",
      "run:action:terminal",
    );
    assert.equal(terminal?.status, "completed");
    assert.deepEqual(
      terminal?.output,
      result.completion.status === "completed"
        ? result.completion.output
        : undefined,
    );
    const receipts =
      (await f.db.query("SELECT kind,key FROM owner_receipts")).rows;
    assert.equal(receipts.filter((r) => r.kind === "collections").length, 1);
    assert.equal(
      receipts.filter((r) => r.kind === "execution.complete").length,
      1,
    );
    assert.equal(driver.run(), driver.run());
  } finally {
    await f.close();
  }
});

test("actual settlement projection is exact and independent of denied ctx policy", async () => {
  const f = await fixture();
  try {
    const port = f.makePort();
    await port.start();
    assert.deepEqual(await port.settlementState(), {
      reference: f.binding,
      cancellationRequested: false,
    });
    f.state.ctx = false;
    await assert.rejects(port.project(), { code: "ActionOwnershipLost" });
    assert.equal((await port.settlementState()).cancellationRequested, false);
    await f.cancel();
    assert.equal((await port.settlementState()).cancellationRequested, true);
    port.sealInvocationCalls();
    assert.equal(
      (await port.complete({ status: "cancelled", code: "action_cancelled" }))
        .status,
      "committed",
    );
    assert.equal(
      (await f.store.getDelivery(f.binding.deliveryId))?.status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("actual settlement rejects private token/tuple/source/fence and post-await lifetime changes", async () => {
  const f = await fixture();
  try {
    await f.makePort().start();
    const before = await snapshot(f.db);
    const call = (who: OwnerCaller, selector: OwnerJson = f.binding) =>
      f.boundary.project(who, "execution.local-settlement-state", selector);
    for (
      const who of [{ ...f.localCaller(), hostLocal: "wrong" }, {
        ...f.localCaller(),
        ownerEpoch: 2,
      }, {
        ...f.localCaller(),
        principal: { kind: "worker" as const, workerId: "fake" },
      }, {
        ...f.localCaller(),
        principal: {
          ...f.localCaller().principal,
          attemptId: "wrong",
        } as OwnerCaller["principal"],
      }]
    ) await assert.rejects(call(who));
    await assert.rejects(
      call(f.localCaller(), { ...f.binding, sourceEventId: "wrong" }),
    );
    f.state.afterResolve = () => {
      f.state.current = false;
    };
    await assert.rejects(call(f.localCaller()));
    f.state.afterResolve = undefined;
    f.state.current = true;
    assert.deepEqual(await snapshot(f.db), before);
    f.state.settlement = false;
    await assert.rejects(call(f.localCaller()));
  } finally {
    await f.close();
  }
});

test("actual Collection requires private local attempt and exact namespace/lease before writes", async () => {
  const f = await fixture();
  try {
    const port = f.makePort();
    await port.start();
    const before = await snapshot(f.db);
    for (
      const change of [
        (scope: OwnerCollectionScope) => ({ ...scope, attempt: undefined }),
        (scope: OwnerCollectionScope) => ({ ...scope, namespace: "wrong" }),
        (scope: OwnerCollectionScope) => ({
          ...scope,
          identity: { ...scope.identity, deliveryLease: undefined },
        }),
        (scope: OwnerCollectionScope) => ({
          ...scope,
          identity: {
            ...scope.identity,
            deliveryLease: { deliveryId: f.binding.deliveryId, owner: "wrong" },
          },
        }),
        (scope: OwnerCollectionScope) => ({
          ...scope,
          attempt: { ...f.binding, attemptId: "wrong" },
        }),
      ]
    ) {
      f.state.scopeChange = change;
      await assert.rejects(port.execute(write));
      assert.deepEqual(await snapshot(f.db), before);
    }
    f.state.scopeChange = undefined;
    await assert.rejects(
      port.execute({
        ...write,
        intent: {
          ...(write.intent as Record<string, OwnerJson>),
          attempt: f.binding,
        },
      }),
    );
    assert.deepEqual(await snapshot(f.db), before);
  } finally {
    await f.close();
  }
});

test("actual Collection current policy runs before duplicate receipt replay", async () => {
  const f = await fixture();
  try {
    const port = f.makePort();
    await port.start();
    assert.equal((await port.execute(write)).status, "committed");
    const before = await snapshot(f.db), scopeCalls = f.state.scopeCalls;
    assert.equal((await port.execute(write)).status, "duplicate");
    assert.equal(f.state.scopeCalls, scopeCalls);
    f.state.collectionAllowed = false;
    await assert.rejects(
      port.execute(write),
      /current Collection policy denied/,
    );
    assert.equal(f.state.scopeCalls, scopeCalls);
    assert.deepEqual(await snapshot(f.db), before);
    f.state.collectionAllowed = true;
    f.state.policyAwait = async () => {
      f.state.current = false;
    };
    await assert.rejects(
      f.boundary.execute(f.localCaller(), { ...write, key: "run/other" }),
    );
    assert.deepEqual(await snapshot(f.db), before);
  } finally {
    await f.close();
  }
});

test("actual cancellation race quarantines after one rejected completion with no manufactured witness", async () => {
  const f = await fixture();
  try {
    const actual = f.makePort();
    const port: RegisteredLocalActionPort = {
      ...actual,
      async settlementState(options) {
        const state = await actual.settlementState(options);
        await f.cancel();
        return state;
      },
    };
    const driver = f.makeDriver(port);
    await assert.rejects(driver.run());
    await driver.quiescent;
    assert.equal(f.state.completionCalls, 1);
    assert.equal(f.state.terminal, 0);
    assert.equal(
      (await f.store.getDelivery(f.binding.deliveryId))?.status,
      "leased",
    );
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      false,
    );
    assert.equal(
      (await f.db.query(
        "SELECT kind FROM owner_receipts WHERE kind='execution.complete'",
      )).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query(
        "SELECT type FROM events WHERE deduplication_id='run:action:terminal'",
      )).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("actual unknown start reply never opens private entry or reruns authored Action", async () => {
  for (const unknown of ["committed", "aborted"] as const) {
    const f = await fixture();
    try {
      f.state.unknown = unknown;
      const driver = f.makeDriver(f.makePort());
      const first = driver.run();
      await assert.rejects(first);
      assert.equal(driver.run(), first);
      await driver.quiescent;
      assert.equal(f.state.started, 0);
      assert.equal(f.state.authoredCalls, 0);
      assert.equal(f.state.terminal, 0);
      assert.equal(
        (await f.store.getDelivery(f.binding.deliveryId))?.attempts,
        unknown === "committed" ? 1 : 0,
      );
    } finally {
      await f.close();
    }
  }
});

test("actual Collection snapshots scope and captures construction-time option identities", async () => {
  const f = await fixture();
  try {
    const port = f.makePort();
    await port.start();
    f.state.scopeChange = (scope) => {
      const copied = {
        ...structuredClone(scope),
        conditions: { notes: { next: { where: { title: "ordinary" } } } },
      };
      queueMicrotask(() => {
        const mutable = copied as {
          namespace: string;
          identity: { causationId: string; deliveryLease: { owner: string } };
          attempt: { attemptId: string };
        };
        mutable.namespace = "changed";
        mutable.identity.causationId = "changed";
        mutable.identity.deliveryLease.owner = "changed";
        mutable.attempt.attemptId = "changed";
        copied.conditions.notes.next.where.title = "changed";
      });
      return copied;
    };
    f.collectionOptions.scope = () => {
      throw new Error("replaced scope callback");
    };
    f.collectionOptions.schema = "changed";
    f.collectionOptions.session = {
      query() {
        throw new Error("replaced session");
      },
      transaction() {
        throw new Error("replaced transaction");
      },
    };
    Object.defineProperty(f.catalog, "indexEventSql", {
      value() {
        throw new Error("replaced catalog method");
      },
    });
    assert.equal((await port.execute(write)).status, "committed");
    const event = (await f.db.query(
      "SELECT namespace,causation_id FROM events WHERE type='note.created'",
    )).rows[0];
    assert.equal(event.namespace, "space");
    assert.equal(event.causation_id, f.binding.sourceEventId);
    assert.equal(f.state.retainedScope?.namespace, "changed");
  } finally {
    await f.close();
  }
});

test("actual driver consumes freshly committed cancellation through narrow settlement", async () => {
  const f = await fixture();
  try {
    const actual = f.makePort();
    const port: RegisteredLocalActionPort = {
      ...actual,
      async settlementState(options) {
        await f.cancel();
        return await actual.settlementState(options);
      },
    };
    const driver = f.makeDriver(port), result = await driver.run();
    await driver.quiescent;
    assert.deepEqual(result.completion, {
      status: "cancelled",
      code: "action_cancelled",
    });
    assert.equal(f.state.completionCalls, 1);
    assert.equal(f.state.terminal, 1);
    assert.equal(
      (await f.store.getDelivery(f.binding.deliveryId))?.status,
      "cancelled",
    );
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      true,
    );
  } finally {
    await f.close();
  }
});

test("actual unknown Collection/terminal commits quarantine without rerun or invented result", async () => {
  for (const phase of ["collections", "complete"] as const) {
    for (const unknown of ["committed", "aborted"] as const) {
      const f = await fixture();
      try {
        const actual = f.makePort();
        let submissions = 0;
        const port: RegisteredLocalActionPort = {
          ...actual,
          execute(command, options) {
            if (phase === "collections") {
              submissions++;
              f.state.unknown = unknown;
            }
            return actual.execute(command, options);
          },
          complete(completion, options) {
            if (phase === "complete") {
              submissions++;
              f.state.unknown = unknown;
            }
            return actual.complete(completion, options);
          },
        };
        const driver = f.makeDriver(port), first = driver.run();
        await assert.rejects(first);
        await driver.quiescent;
        assert.equal(driver.run(), first);
        assert.equal(submissions, 1);
        assert.equal(f.state.authoredCalls, 1);
        assert.equal(f.state.terminal, 0);
        const delivery = await f.store.getDelivery(f.binding.deliveryId);
        assert.equal(delivery?.attempts, 1);
        assert.equal(
          delivery?.status,
          phase === "complete" && unknown === "committed"
            ? "succeeded"
            : "leased",
        );
        assert.equal(
          (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
            .retired,
          phase === "complete" && unknown === "committed",
        );
        assert.equal(
          (await f.db.query("SELECT id FROM nodes WHERE type='note'")).rows
            .length,
          phase === "collections" && unknown === "aborted" ? 0 : 1,
        );
      } finally {
        await f.close();
      }
    }
  }
});
