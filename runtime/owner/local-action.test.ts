import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { ownerCompletionKey } from "../execution/owner-port.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createOwnerAssignmentControl,
  type OwnerLocalActionAssignmentBinding,
  provisionOwnerAssignments,
} from "./assignments.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerInputCommand,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerExecutionCommands,
  ownerLocalActionStartKey,
} from "./execution.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerEffectCommands } from "./effects.ts";
import { createOwnerEffectClient } from "./effects-client.ts";

const start = "2020-01-01T00:00:00.000Z";
const preparedCapture = {
  schema: "copilotz.owner.preparation.v1",
  preparation: "channel.text",
  source: {
    source: {
      name: "messages",
      kind: "message",
      path: "content",
      recordId: "message",
      namespace: "space",
      digest: `sha256:${"a".repeat(64)}`,
    },
    audience: "channel",
    content: [],
  },
  resources: [],
  view: {
    shows: "message",
    hints: { mode: "channel", renderer: "text" },
    selection: { kind: "registered", id: "message.channel" },
  },
};
async function snapshot(tx: SqlExecutor) {
  const result: Record<string, unknown> = {};
  for (
    const table of [
      "events",
      "event_deliveries",
      "event_bodies",
      "open_actions",
      "owner_assignments",
      "owner_receipts",
      "owner_receipt_readers",
    ]
  ) {
    result[table] = (await tx.query(
      `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
    )).rows;
  }
  return result;
}
async function fixture(
  options: {
    prepared?: boolean;
    missingPreparedPolicy?: boolean;
    localDisabled?: boolean;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    time: start,
    control: true,
    current: true,
    ctx: true,
    settlement: true,
    input: true,
    prepared: true,
    revokeDuringInput: false,
    revokeAfterBodyRead: false,
    rollback: false,
    beforeCommit: undefined as undefined | (() => Promise<void>),
    holdInput: undefined as undefined | (() => Promise<void>),
    holdPrepared: undefined as undefined | (() => Promise<void>),
    unknown: "" as "" | "committed" | "aborted",
    failRetirement: false,
    reservations: 0,
    retirements: 0,
    publications: [] as string[],
    schedules: 0,
    preparedCallers: [] as string[],
    startChecks: 0,
  };
  const controlCaller = (): OwnerCaller => ({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    privateControl: true,
  });
  const caller = (): OwnerCaller => ({
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId: binding.deliveryId,
      attemptId: binding.attemptId,
    },
    ownerEpoch: 1,
  });
  const assignments = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    maxActive: 1,
    authorizeControl(_tx, who) {
      if (!state.control || who.privateControl !== true) {
        throw new Error("private control revoked");
      }
    },
    isCurrentStarted: () => false,
    resolveCurrentLocal: () => state.current ? binding : undefined,
    hasAction: (id) => id === "fixture.work",
  });
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const mode = state.unknown;
      state.unknown = "";
      const result = await db.transaction(async (tx) => {
        const result = await run({
          async query<
            TRow extends Record<string, unknown> = Record<string, unknown>,
          >(sql: string, params?: unknown[]) {
            if (state.rollback && sql === "RELEASE SAVEPOINT owner_command_0") {
              state.rollback = false;
              throw new Error("command rollback");
            }
            const result = await tx.query<TRow>(sql, params);
            if (
              state.revokeAfterBodyRead &&
              sql.includes("SELECT namespace, event_body_id")
            ) {
              state.revokeAfterBodyRead = false;
              state.current = false;
            }
            return result;
          },
        });
        await state.beforeCommit?.();
        if (mode === "aborted") {
          throw Object.assign(new Error("unknown aborted commit"), {
            code: "persistence_indeterminate",
          });
        }
        return result;
      });
      if (mode === "committed") {
        throw Object.assign(new Error("unknown committed reply"), {
          code: "persistence_indeterminate",
        });
      }
      return result;
    },
  };
  const action = defineAction({
    id: "fixture.work",
    inputSchema: { type: "string" } as const,
    outputSchema: { type: "string" } as const,
    execute: (input: string) => input,
  });
  const registry = createPluginRegistry({
    plugins: [
      definePlugin({ id: "fixture", version: "1", actions: { work: action } }),
    ],
  });
  const catalog = createOperationCatalog(db, "public");
  const store = createEventStore({
    session: db,
    now: () => new Date(state.time),
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "unused-worker",
  });
  const execution = createOwnerExecutionCommands({
    ownerId: "owner",
    isCurrentAssignment: () => state.current,
    session: {
      query() {
        throw new Error("ambient query");
      },
      transaction() {
        throw new Error("nested transaction");
      },
    },
    schema: "public",
    registry,
    catalog,
    executor,
    local: options.localDisabled ? undefined : {
      authorizeStart(_tx, who, candidate) {
        state.startChecks++;
        return state.control && who.privateControl === true &&
          JSON.stringify(candidate) === JSON.stringify(binding);
      },
      async reserveLocal(context, candidate) {
        state.reservations++;
        await assignments.reserveLocal(context, candidate);
      },
      async retireLocal(context, candidate) {
        state.retirements++;
        await assignments.retireLocal(context, candidate);
        if (state.failRetirement) throw new Error("retirement failed");
      },
    },
    async resolveAssignment(tx, who, _time, readMode) {
      const current = await assignments.resolveLocal(tx, who, readMode);
      if (!current || current.kind !== "action") return undefined;
      return {
        ...current,
        ctxGranted: state.ctx,
        settlementGranted: state.settlement,
        invocation: {
          actionRunId: current.actionRunId,
          rootKey: "untrusted-root",
          operationKey: "untrusted-operation",
          metadata: { forged: true },
        },
      };
    },
    async authorizeInput(_tx, assignment, input) {
      await state.holdInput?.();
      assert.equal(assignment.invocation.operationKey, "run");
      assert.deepEqual(input, "hello");
      if (!state.input) throw new Error("input revoked");
      if (state.revokeDuringInput) state.control = false;
    },
    authorizePreparedInput: options.missingPreparedPolicy
      ? undefined
      : async (_tx, context) => {
        await state.holdPrepared?.();
        state.preparedCallers.push(context.caller.principal.kind);
        if (!state.prepared) throw new Error("prepared revoked");
      },
    publish(event) {
      state.publications.push(event.type);
    },
    scheduleSettlement(context) {
      context.afterCommit(() => {
        state.schedules++;
      });
    },
  });
  const effects = createOwnerEffectCommands({
    ownerId: "owner",
    schema: "public",
    async authorizeEffect(tx, who, ref, mode, time) {
      const assignment = mode === "begin"
        ? await execution.authorizeLive(tx, who, time)
        : await execution.authorizeSettlement(tx, who, time);
      return ref.namespace === assignment.namespace &&
        ref.actionRunId === assignment.invocation.actionRunId;
    },
    validateOutcome: () => true,
    verifyNotStarted: () => true,
  });
  const boundary = createOwnerCommandBoundary({
    session,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => state.time,
    handlers: {
      ...execution.handlers,
      ...effects.handlers,
      async seed(_input, context) {
        const value = await createEventStore({
          session: db,
          ownerCommit: context.ownerCommit,
          admitOperationEventSql: (value, param) =>
            catalog.admitEventSql(value, param),
          indexOperationEventSql: (value, param) =>
            catalog.indexEventSql(value, param),
          indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
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
              actionId: "fixture.work",
              actionRunId: "run",
              actionMetadata: { origin: "trusted" },
              rootKey: "root",
              ...(options.prepared ? { preparation: preparedCapture } : {}),
            },
            deduplicationId: "run",
            correlationId: "correlation",
          },
          body: { id: "body", json: "hello" },
          consumers: [{
            consumerId: "registered:fixture.work",
            settlement: "inherit",
          }],
        });
        return { eventId: value.event.id, deliveryId: value.deliveries[0].id };
      },
    },
    projections: { ...execution.projections, ...effects.projections },
    inputDefinitions: execution.inputDefinitions,
    async authorize(tx, who, command, time, input) {
      if (command.kind === "seed") {
        assert.equal(who.privateControl, true);
        return;
      }
      if (command.kind.startsWith("effect.")) {
        await effects.authorize(tx, who, command, time);
      } else await execution.authorize(tx, who, command, time, input);
    },
    authenticateReceipt() {
      throw new Error("local generic receipt reads forbidden");
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
  const binding: OwnerLocalActionAssignmentBinding = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: source.eventId,
    deliveryId: source.deliveryId,
    kind: "action",
    actionId: "fixture.work",
    actionRunId: "run",
  };
  const startCommand = (value = binding): OwnerCommand => ({
    kind: "owner.local-start",
    domain: "incarnation",
    key: ownerLocalActionStartKey(value),
    intent: value,
  });
  const completeCommand = (
    completion: OwnerJson = { status: "completed", output: "done" },
  ): OwnerInputCommand => ({
    kind: "execution.complete",
    domain: "logical",
    key: ownerCompletionKey("owner", "space", "run"),
    input: { namespace: "space", executionId: "run", completion },
  });
  return {
    db,
    state,
    assignments,
    execution,
    store,
    boundary,
    binding,
    source,
    caller,
    controlCaller,
    startCommand,
    completeCommand,
    start: () => boundary.execute(controlCaller(), startCommand()),
    project: () => boundary.project(caller(), "execution.input", binding),
    effectClient: () =>
      createOwnerEffectClient({
        ownerId: "owner",
        namespace: "space",
        actionRunId: "run",
        port: {
          execute: (command, options) =>
            boundary.execute(caller(), command, options),
          settle: (command, options) =>
            boundary.execute(caller(), command, options),
          project: (kind, input, options) =>
            boundary.project(caller(), kind, input, options),
        },
      }),
    complete: (value?: OwnerJson) =>
      boundary.executeInput(caller(), completeCommand(value)),
    async close() {
      boundary.stop();
      await db.close();
    },
  };
}

test("fresh local Action start atomically reserves, captures and projects immutable invocation without worker timing", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.start(), {
      status: "committed",
      result: { binding: f.binding, attempts: 1 },
    });
    const delivery = await f.store.getDelivery(f.binding.deliveryId);
    assert.equal(delivery?.status, "leased");
    assert.equal(delivery?.attempts, 1);
    assert.equal(delivery?.leaseOwner, "attempt");
    assert.equal(delivery?.leaseExpiresAt, undefined);
    f.state.time = "2040-01-01T00:00:00.000Z";
    const projected = await f.project() as Record<string, OwnerJson>;
    assert.deepEqual(projected.reference, f.binding);
    assert.equal(projected.input, "hello");
    assert.equal("workerId" in projected, false);
    assert.equal("lease" in projected, false);
    const invocation = projected.invocation as Record<string, OwnerJson>;
    assert.equal(invocation.rootKey, "root");
    assert.equal(invocation.operationKey, "run");
    assert.deepEqual(invocation.metadata, { origin: "trusted" });
    assert.deepEqual(invocation.identity, {
      causationId: f.source.eventId,
      correlationId: "correlation",
      settlementScopeId: f.source.eventId,
    });
    const before = await snapshot(f.db);
    await assert.rejects(f.start(), { code: "ActionOwnershipLost" });
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(f.state.reservations, 1);
    await assert.rejects(
      f.boundary.execute(f.caller(), {
        kind: "execution.renew",
        domain: "occurrence",
        key: "renew",
        intent: { reference: f.binding, sequence: 1 },
      }),
      { code: "owner_command_invalid" },
    );
    await assert.rejects(
      f.boundary.execute(f.caller(), {
        kind: "execution.claim",
        domain: "incarnation",
        key: "claim",
        intent: {},
      }),
      { code: "ActionOwnershipLost" },
    );
    assert.deepEqual((await f.complete()).result, {
      reference: f.binding,
      status: "completed",
    });
    assert.equal(
      (await f.store.getDelivery(f.binding.deliveryId))?.status,
      "succeeded",
    );
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      true,
    );
    await assert.rejects(f.project(), { code: "ActionOwnershipLost" });
  } finally {
    await f.close();
  }
});

test("local start defaults closed and rechecks private capacity after input policy", async () => {
  for (const mode of ["disabled", "private", "during-input"] as const) {
    const f = await fixture({ localDisabled: mode === "disabled" });
    try {
      if (mode === "private") f.state.control = false;
      if (mode === "during-input") f.state.revokeDuringInput = true;
      const before = await snapshot(f.db);
      await assert.rejects(f.start(), { code: "ActionOwnershipLost" });
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.reservations, 0);
    } finally {
      await f.close();
    }
  }
});

test("local start and completion roll back reservation, capture, terminal, receipt and publication together", async () => {
  for (const phase of ["start", "completion", "retirement"] as const) {
    const f = await fixture();
    try {
      if (phase !== "start") await f.start();
      const before = await snapshot(f.db);
      const publications = [...f.state.publications];
      if (phase === "retirement") f.state.failRetirement = true;
      else f.state.rollback = true;
      await assert.rejects(
        phase === "start" ? f.start() : f.complete(),
        /rollback|retirement failed/,
      );
      assert.deepEqual(await snapshot(f.db), before);
      assert.deepEqual(f.state.publications, publications);
    } finally {
      await f.close();
    }
  }
});

test("unknown local start outcome never returns an execution entitlement for committed or aborted transactions", async () => {
  for (const unknown of ["committed", "aborted"] as const) {
    const f = await fixture();
    try {
      f.state.unknown = unknown;
      await assert.rejects(f.start());
      assert.equal(f.boundary.state, "stopped");
      assert.equal(
        (await f.store.getDelivery(f.binding.deliveryId))?.attempts,
        unknown === "committed" ? 1 : 0,
      );
      assert.deepEqual(f.state.publications, []);
      await assert.rejects(f.start());
    } finally {
      await f.close();
    }
  }
});

test("local current private handle, exact binding, epoch and NULL deadline are independently required", async () => {
  const f = await fixture();
  try {
    await f.start();
    f.state.current = false;
    await assert.rejects(f.project(), { code: "ActionOwnershipLost" });
    f.state.current = true;
    for (
      const changed of [{ attemptId: "other" }, { deliveryId: "other" }, {
        holderId: "other",
      }, { epoch: 2 }]
    ) {
      const caller = f.caller();
      await assert.rejects(
        f.boundary.project(
          {
            ...caller,
            principal: {
              ...caller.principal,
              ...changed,
            } as typeof caller.principal,
          },
          "execution.input",
          f.binding,
        ),
      );
    }
    await assert.rejects(
      f.boundary.project(f.caller(), "execution.input", {
        ...f.binding,
        actionRunId: "other",
      }),
      { code: "ActionOwnershipLost" },
    );
    await f.db.query(
      "UPDATE event_deliveries SET lease_expires_at=$1 WHERE id=$2",
      ["2040-01-01T00:00:00Z", f.binding.deliveryId],
    );
    await assert.rejects(f.project(), { code: "ActionOwnershipLost" });
    await f.db.query(
      "UPDATE event_deliveries SET lease_expires_at=NULL WHERE id=$1",
      [f.binding.deliveryId],
    );
    await f.db.query(
      "UPDATE owner_epochs SET epoch=2,holder='successor' WHERE owner='owner'",
    );
    await assert.rejects(f.complete(), { code: "ActionOwnershipLost" });
  } finally {
    await f.close();
  }
});

test("prepared start uses actual control caller and current prepared/input revocation preserves narrow settlement", async () => {
  const f = await fixture({ prepared: true });
  try {
    await f.start();
    assert.ok(f.state.preparedCallers.length >= 2);
    assert.ok(
      f.state.preparedCallers.every((kind) => kind === "owner-control"),
    );
    await f.project();
    assert.equal(f.state.preparedCallers.at(-1), "owner-local");
    f.state.prepared = false;
    await assert.rejects(f.project(), /prepared revoked/);
    await assert.rejects(
      f.db.transaction((tx) =>
        f.execution.authorizeLive(tx, f.caller(), f.state.time)
      ),
      /prepared revoked/,
    );
    f.state.prepared = true;
    f.state.input = false;
    await assert.rejects(f.project(), /input revoked/);
    f.state.ctx = false;
    assert.equal(
      (await f.complete({ status: "failed", code: "action_failed" })).status,
      "committed",
    );
  } finally {
    await f.close();
  }
  const missing = await fixture({
    prepared: true,
    missingPreparedPolicy: true,
  });
  try {
    await assert.rejects(missing.start(), { code: "ActionOwnershipLost" });
    assert.equal(missing.state.reservations, 0);
  } finally {
    await missing.close();
  }
});

test("local cancellation preserves cancellation writer and exact attempt delivery admission", async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.db.query(
      "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
      [start, f.source.eventId],
    );
    await assert.rejects(f.complete(), { code: "ActionOwnershipLost" });
    await f.db.query(
      "UPDATE event_deliveries SET lease_owner='other' WHERE id=$1",
      [f.binding.deliveryId],
    );
    await assert.rejects(
      f.complete({ status: "cancelled", code: "action_cancelled" }),
      { code: "ActionOwnershipLost" },
    );
    await f.db.query(
      "UPDATE event_deliveries SET lease_owner='attempt' WHERE id=$1",
      [f.binding.deliveryId],
    );
    assert.equal(
      (await f.complete({ status: "cancelled", code: "action_cancelled" }))
        .status,
      "committed",
    );
    assert.equal(
      (await f.store.getDelivery(f.binding.deliveryId))?.status,
      "cancelled",
    );
    assert.equal(
      (await createActionLifecycleLoader({ store: f.store })(
        "space",
        "run:action:terminal",
      ))?.status,
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

test("local fresh admission refuses historical attempts, retry state and any prior invoked capture", async () => {
  for (const phase of ["attempts", "retry", "captured"] as const) {
    const f = await fixture();
    try {
      if (phase === "captured") {
        await f.start();
        await f.db.query(
          "UPDATE event_deliveries SET status='pending',attempts=0,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [f.binding.deliveryId],
        );
      } else if (phase === "attempts") {
        await f.db.query("UPDATE event_deliveries SET attempts=1 WHERE id=$1", [
          f.binding.deliveryId,
        ]);
      } else {
        await f.db.query(
          "UPDATE event_deliveries SET status='retry_wait' WHERE id=$1",
          [f.binding.deliveryId],
        );
      }
      const before = await snapshot(f.db);
      await assert.rejects(f.start(), { code: "ActionOwnershipLost" });
      assert.deepEqual(await snapshot(f.db), before);
    } finally {
      await f.close();
    }
  }
});

test("local completion retains the same logical key and normalized digest as worker completion", async () => {
  const f = await fixture();
  let expected: Record<string, unknown>;
  try {
    await f.start();
    const definition = f.execution.inputDefinitions["execution.complete"];
    const normalized = await definition.normalize(
      f.completeCommand({ status: "failed", code: "action_failed" }).input,
    );
    await f.complete({ code: "action_failed", status: "failed" });
    const receipt = (await f.db.query(
      "SELECT domain,key,kind,intent,result FROM owner_receipts WHERE kind='execution.complete'",
    )).rows[0];
    assert.equal(receipt.domain, "logical");
    assert.equal(receipt.kind, "execution.complete");
    assert.equal(receipt.key, ownerCompletionKey("owner", "space", "run"));
    assert.deepEqual(receipt.intent, normalized.intent);
    assert.deepEqual(receipt.result, {
      reference: f.binding,
      status: "failed",
    });
    expected = {
      domain: receipt.domain,
      key: receipt.key,
      kind: receipt.kind,
      intent: receipt.intent,
    };
  } finally {
    await f.close();
  }
  const { fixture: workerFixture } = await import(
    "./execution.fixture.test.ts"
  );
  const worker = await workerFixture();
  try {
    await worker.port().claim(worker.hint(), {});
    await worker.port().complete(worker.reference(), {
      status: "failed",
      code: "action_failed",
    }, {});
    const workerReceipt = (await worker.db.query(
      "SELECT domain,key,kind,intent FROM owner_receipts WHERE kind='execution.complete'",
    )).rows[0];
    assert.deepEqual(workerReceipt, expected);
  } finally {
    await worker.close();
  }
});

test("a genuinely prepared child reauthorizes captured source through actual control-start and local callers", async () => {
  const { fixture: preparationFixture } = await import(
    "./preparation.fixture.test.ts"
  );
  const f = await preparationFixture();
  let boundary: ReturnType<typeof createOwnerCommandBoundary> | undefined;
  try {
    const ref = (await f.prepare()).result as {
      namespace: string;
      actionId: string;
      executionId: string;
      eventId: string;
      deliveryId: string;
    };
    f.boundary.stop();
    await provisionOwnerAssignments(f.db, "public");
    const binding: OwnerLocalActionAssignmentBinding = {
      placement: "owner-local",
      ownerId: "owner",
      epoch: 2,
      holderId: "local-holder",
      attemptId: "fresh-child",
      namespace: ref.namespace,
      sourceEventId: ref.eventId,
      deliveryId: ref.deliveryId,
      kind: "action",
      actionId: ref.actionId,
      actionRunId: ref.executionId,
    };
    const control: OwnerCaller = {
      principal: {
        kind: "owner-control",
        ownerId: "owner",
        epoch: 2,
        holderId: "local-holder",
      },
      ownerEpoch: 2,
      privateControl: true,
    };
    const localCaller: OwnerCaller = {
      principal: {
        kind: "owner-local",
        ownerId: "owner",
        epoch: 2,
        holderId: "local-holder",
        deliveryId: ref.deliveryId,
        attemptId: "fresh-child",
      },
      ownerEpoch: 2,
    };
    let permitControlPrepared = false;
    let current = true;
    const observed: string[] = [];
    const assignments = createOwnerAssignmentControl({
      ownerId: "owner",
      schema: "public",
      authorizeControl() {},
      isCurrentStarted: () => false,
      resolveCurrentLocal: () => current ? binding : undefined,
      hasAction: (id) => id === ref.actionId,
    });
    const catalog = createOperationCatalog(f.db, "public");
    const execution = createOwnerExecutionCommands({
      ownerId: "owner",
      session: f.db,
      schema: "public",
      registry: f.registry,
      catalog,
      executor: createDeliveryExecutor({
        store: f.store,
        registry: f.registry,
        createContext: createTestProcessorContext,
        workerId: "unused",
      }),
      local: {
        authorizeStart: (_tx, who, candidate) =>
          who.privateControl === true && current &&
          JSON.stringify(candidate) === JSON.stringify(binding),
        reserveLocal: assignments.reserveLocal,
        retireLocal: assignments.retireLocal,
      },
      async resolveAssignment(tx, who) {
        const resolved = await assignments.resolveLocal(tx, who);
        if (!resolved || resolved.kind !== "action") return undefined;
        return {
          ...resolved,
          ctxGranted: true,
          settlementGranted: true,
          invocation: {
            actionRunId: ref.executionId,
            rootKey: ref.executionId,
            operationKey: ref.executionId,
            metadata: {},
          },
        };
      },
      authorizeInput(_tx, _assignment, input) {
        assert.deepEqual(input, { text: "Reply: Title body original" });
      },
      async authorizePreparedInput(tx, context) {
        assert.equal(context.sourceEventId, ref.eventId);
        assert.equal(context.deliveryId, ref.deliveryId);
        assert.equal(context.actionId, ref.actionId);
        assert.equal(context.namespace, ref.namespace);
        observed.push(`${context.caller.principal.kind}:${context.purpose}`);
        if (
          context.caller.principal.kind === "owner-control" &&
          !permitControlPrepared
        ) throw new Error("prepared control start denied");
        await f.preparations.authorizeCaptured(tx, context);
      },
    });
    boundary = createOwnerCommandBoundary({
      session: f.db,
      schema: "public",
      ownerId: "owner",
      holderId: "local-holder",
      now: () => f.state.time,
      handlers: execution.handlers,
      projections: execution.projections,
      inputDefinitions: execution.inputDefinitions,
      authorize: execution.authorize,
      authenticateReceipt() {
        throw new Error("no generic local receipt access");
      },
    });
    await boundary.acquire(1);
    const command: OwnerCommand = {
      kind: "owner.local-start",
      domain: "incarnation",
      key: ownerLocalActionStartKey(binding),
      intent: binding,
    };
    await assert.rejects(
      boundary.execute(control, command),
      /prepared control start denied/,
    );
    assert.equal((await f.store.getDelivery(ref.deliveryId))?.attempts, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM owner_assignments")).rows.length,
      0,
    );
    permitControlPrepared = true;
    await boundary.execute(control, command);
    assert.ok(observed.includes("owner-control:claim"));
    await boundary.project(localCaller, "execution.input", binding);
    assert.ok(observed.includes("owner-local:input"));
    await f.db.transaction((tx) =>
      execution.authorizeLive(tx, localCaller, f.state.time)
    );
    assert.ok(observed.includes("owner-local:mutation"));
    f.state.originalAllowed = false;
    await assert.rejects(
      boundary.project(localCaller, "execution.input", binding),
      /original source denied/,
    );
    await assert.rejects(
      f.db.transaction((tx) =>
        execution.authorizeLive(tx, localCaller, f.state.time)
      ),
      /original source denied/,
    );
    await boundary.executeInput(localCaller, {
      kind: "execution.complete",
      domain: "logical",
      key: ownerCompletionKey("owner", ref.namespace, ref.executionId),
      input: {
        namespace: ref.namespace,
        executionId: ref.executionId,
        completion: { status: "failed", code: "action_failed" },
      },
    });
    current = false;
    assert.equal(f.state.rendered, 1);
    assert.equal(f.state.executed, 0);
  } finally {
    boundary?.stop();
    await f.close();
  }
});

test("unknown local completion preserves atomic terminal and retirement without returning a known outcome", async () => {
  for (const unknown of ["committed", "aborted"] as const) {
    const f = await fixture();
    try {
      await f.start();
      const before = await snapshot(f.db);
      f.state.unknown = unknown;
      await assert.rejects(f.complete());
      assert.equal(f.boundary.state, "stopped");
      if (unknown === "aborted") assert.deepEqual(await snapshot(f.db), before);
      else {
        assert.equal(
          (await f.store.getDelivery(f.binding.deliveryId))?.status,
          "succeeded",
        );
        assert.equal(
          (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
            .retired,
          true,
        );
        assert.equal(
          (await f.db.query(
            "SELECT * FROM owner_receipts WHERE kind='execution.complete'",
          )).rows.length,
          1,
        );
      }
      await assert.rejects(f.complete());
    } finally {
      await f.close();
    }
  }
});

test("local successful completion refuses begun effects while independent settlement survives input revocation", async () => {
  const f = await fixture();
  try {
    await f.start();
    const effect = f.effectClient();
    assert.deepEqual(await effect.begin("send"), { status: "proceed" });
    assert.deepEqual(await effect.begin("send"), { status: "indeterminate" });
    await assert.rejects(f.complete(), { code: "effect_indeterminate" });
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      false,
    );
    f.state.ctx = false;
    f.state.input = false;
    await assert.rejects(effect.begin("another"));
    await effect.confirm("send", { delivered: true });
    assert.equal((await f.complete()).status, "committed");
  } finally {
    await f.close();
  }
});

test("local start output and lifecycle publication wait for the actual outer commit", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => reached = resolve);
    const gate = new Promise<void>((resolve) => release = resolve);
    f.state.beforeCommit = async () => {
      reached();
      await gate;
    };
    let delivered = false;
    const pending = f.start().then((outcome) => {
      delivered = true;
      return outcome;
    });
    await entered;
    assert.equal(delivered, false);
    assert.deepEqual(f.state.publications, []);
    release();
    assert.equal((await pending).status, "committed");
    assert.equal(
      (await f.store.getDelivery(f.binding.deliveryId))?.attempts,
      1,
    );
  } finally {
    release?.();
    await f.close();
  }
});

test("aborting local start during input or prepared policy keeps work charged until policy settles and writes nothing", async () => {
  for (const purpose of ["input", "prepared"] as const) {
    const f = await fixture({ prepared: purpose === "prepared" });
    let release!: () => void;
    try {
      const before = await snapshot(f.db);
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => reached = resolve);
      const gate = new Promise<void>((resolve) => release = resolve);
      const policy = async () => {
        reached();
        await gate;
      };
      if (purpose === "input") f.state.holdInput = policy;
      else f.state.holdPrepared = policy;
      const abort = new AbortController();
      const request = f.boundary.execute(f.controlCaller(), f.startCommand(), {
        signal: abort.signal,
      });
      let settled = false;
      const rejected = assert.rejects(request, /aborted local start/).then(
        () => {
          settled = true;
        },
      );
      await entered;
      abort.abort(new Error("aborted local start"));
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(f.state.reservations, 0);
      assert.deepEqual(f.state.publications, []);
      release();
      await rejected;
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.reservations, 0);
      assert.deepEqual(f.state.publications, []);
    } finally {
      release?.();
      await f.close();
    }
  }
});

test("local input rechecks private handle and ctx after both awaited input and final prepared policies", async () => {
  for (const phase of ["input", "prepared"] as const) {
    const f = await fixture({ prepared: phase === "prepared" });
    try {
      await f.start();
      for (const revoke of ["handle", "ctx"] as const) {
        const before = await snapshot(f.db);
        let preparedChecks = 0;
        const policy = () => {
          if (revoke === "handle") f.state.current = false;
          else f.state.ctx = false;
          return Promise.resolve();
        };
        if (phase === "input") f.state.holdInput = policy;
        else {f.state.holdPrepared = () =>
            ++preparedChecks === 2 ? policy() : Promise.resolve();}
        await assert.rejects(f.project(), { code: "ActionOwnershipLost" });
        assert.deepEqual(await snapshot(f.db), before);
        f.state.current = true;
        f.state.ctx = true;
      }
    } finally {
      await f.close();
    }
  }
});

test("local mutation rechecks private handle and ctx after both awaited input and final prepared policies", async () => {
  for (const phase of ["input", "prepared"] as const) {
    const f = await fixture({ prepared: phase === "prepared" });
    try {
      await f.start();
      for (const revoke of ["handle", "ctx"] as const) {
        const before = await snapshot(f.db);
        let preparedChecks = 0;
        const policy = () => {
          if (revoke === "handle") f.state.current = false;
          else f.state.ctx = false;
          return Promise.resolve();
        };
        if (phase === "input") f.state.holdInput = policy;
        else {f.state.holdPrepared = () =>
            ++preparedChecks === 2 ? policy() : Promise.resolve();}
        await assert.rejects(
          f.db.transaction((tx) =>
            f.execution.authorizeLive(tx, f.caller(), f.state.time)
          ),
          { code: "ActionOwnershipLost" },
        );
        assert.deepEqual(await snapshot(f.db), before);
        f.state.current = true;
        f.state.ctx = true;
      }
    } finally {
      await f.close();
    }
  }
});

test("local private witness is rechecked after the final captured-body read", async () => {
  const f = await fixture();
  try {
    await f.start();
    const before = await snapshot(f.db);
    f.state.holdInput = () => {
      f.state.revokeAfterBodyRead = true;
      return Promise.resolve();
    };
    await assert.rejects(f.project(), { code: "ActionOwnershipLost" });
    assert.equal(
      f.state.current,
      false,
      "private handle must be revoked after policy during the final SQL read",
    );
    assert.deepEqual(await snapshot(f.db), before);
  } finally {
    await f.close();
  }
});

test("local Action authority reuses checks in an exclusive read-only scope", async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.db.withReadSnapshot!(async (scope) => {
      const run = async (
        tx: SqlExecutor,
        mode: "locking" | "exclusive-read",
      ) => {
        const live = await f.execution.authorizeLive(
          tx,
          f.caller(),
          start,
          mode,
        );
        assert.equal(live.deliveryId, f.source.deliveryId);
        f.state.ctx = false;
        await assert.rejects(
          f.execution.authorizeLive(tx, f.caller(), start, mode),
        );
      };
      if (scope.kind === "exclusive") {
        await run(scope.snapshot, "exclusive-read");
      } else await scope.current((tx) => run(tx, "locking"));
    });
  } finally {
    await f.close();
  }
});
