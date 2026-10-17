import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { ownerClaimKey, ownerCompletionKey } from "../execution/owner-port.ts";
import {
  createOwnerChildActionPort,
  type OwnerChildActionReference,
} from "../execution/child-action-port.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { ownerProcessorClaimKey } from "../execution/registered-processor.ts";
import {
  createOwnerProcessorCommands,
  type OwnerProcessorAssignment,
} from "./processor.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createOwnerActionAdmission,
  OWNER_ACTION_ADMISSION,
  ownerActionAdmissionKey,
  validateOwnerActionAdmissionIdentity,
} from "./admission.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerInputCommand,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerChildActions,
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
  ownerChildActionKey,
} from "./child-action.ts";
import {
  createOwnerExecutionCommands,
  type OwnerExecutionAssignment,
} from "./execution.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const ownerId = "owner";
const namespace = "space";
const initialTime = "2020-01-01T00:00:00.000Z";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const errorCode = (code: string) => (error: unknown) =>
  (error as { code?: string })?.code === code;

async function setup(maxPendingDeliveries = 128) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const gate = { reached: deferred(), release: deferred() };
  const state = {
    time: initialTime,
    live: true,
    ctx: true,
    policy: true,
    scheduled: [] as OwnerChildActionReference[],
    rollBack: false,
    hold: false,
    receiptReads: 0,
    mutateReturned: false,
    returnedParent: undefined as OwnerExecutionAssignment | undefined,
    inTransaction: false,
    parent: undefined as OwnerExecutionAssignment | undefined,
  };
  const session: SqlSession = {
    query() {
      throw new Error("Ambient child SQL forbidden");
    },
    async transaction(run) {
      state.inTransaction = true;
      try {
        return await db.transaction(async (tx) => {
          const result = await run({
            async query(sql, params) {
              if (
                state.mutateReturned && state.returnedParent &&
                sql.includes("event_deliveries")
              ) {
                state.mutateReturned = false;
                Object.assign(state.returnedParent, { namespace: "spoofed" });
                Object.assign(state.returnedParent.invocation, {
                  operationKey: "spoofed",
                });
              }
              if (sql.includes("SELECT kind,intent,result")) {
                state.receiptReads++;
              }
              return await tx.query(sql, params);
            },
          });
          if (state.hold) {
            state.hold = false;
            gate.reached.resolve();
            await gate.release.promise;
          }
          if (state.rollBack) {
            state.rollBack = false;
            throw new Error("outer rollback");
          }
          return result;
        });
      } finally {
        state.inTransaction = false;
      }
    },
  };
  const registry = createPluginRegistry({
    actions: {
      parent: defineAction({ id: "fixture.parent", execute: () => null }),
      child: defineAction({
        id: "fixture.child",
        execute: (input: unknown) => input,
      }),
      other: defineAction({
        id: "fixture.other",
        execute: (input: unknown) => input,
      }),
      protected: defineAction({
        id: "fixture.protected",
        inputSchema: {
          type: "object",
          properties: {
            password: { type: "string", "x-copilotz-secret": true },
          },
        } as const,
        execute: () => null,
      }),
    },
  });
  const catalog = createOperationCatalog(db, "public");
  const store = createEventStore({ session: db });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "unused",
  });
  const assignments = new Map<string, OwnerExecutionAssignment>();
  const execution = createOwnerExecutionCommands({
    ownerId,
    schema: "public",
    session,
    registry,
    catalog,
    executor,
    leaseMs: 60_000,
    resolveAssignment(_tx, caller) {
      const a = assignments.get(String(caller.assignmentId));
      return state.live && a ? { ...a, ctxGranted: state.ctx } : undefined;
    },
    authorizeInput() {},
    allowRecovery: () => true,
  });
  const child = createOwnerChildActions({
    ownerId,
    schema: "public",
    session,
    registry,
    catalog,
    maxPendingDeliveries,
    async resolveParent(tx, caller, time) {
      const assignment = await execution.authorizeLive(tx, caller, time);
      state.returnedParent = assignment;
      return { kind: "action", assignment };
    },
    authorizeChild(_tx, _caller, parent) {
      assert.deepEqual(parent.originalMetadata, {
        principal: "original-principal",
      });
      if (!state.policy) throw new Error("current child policy denied");
    },
    schedule(reference) {
      assert.equal(state.inTransaction, false);
      state.scheduled.push(reference);
    },
  });
  const root = createOwnerActionAdmission({
    ownerId,
    schema: "public",
    session,
    registry,
    catalog,
    schedule() {},
  });
  const boundary = createOwnerCommandBoundary({
    ownerId,
    holderId: "holder",
    schema: "public",
    session,
    now: () => state.time,
    handlers: {
      [OWNER_ACTION_ADMISSION]: root.handler,
      [OWNER_CHILD_ACTION_ADMISSION]: child.handler,
      ...execution.handlers,
    },
    inputDefinitions: {
      ...execution.inputDefinitions,
      [OWNER_ACTION_ADMISSION]: root.inputDefinition,
      [OWNER_CHILD_ACTION_ADMISSION]: child.inputDefinition,
    },
    projections: {
      [OWNER_CHILD_ACTION_RESULT]: child.projection,
      ...execution.projections,
    },
    async authorize(tx, caller, command, time, input) {
      if (command.kind === OWNER_ACTION_ADMISSION) {
        validateOwnerActionAdmissionIdentity(ownerId, command, input);
        return;
      }
      if (
        [OWNER_CHILD_ACTION_ADMISSION, OWNER_CHILD_ACTION_RESULT].includes(
          command.kind,
        )
      ) return await child.authorize(tx, caller, command, time, input);
      await execution.authorize(tx, caller, command, time, input);
    },
    authenticateReceipt() {
      throw new Error("No child receipt hydration route");
    },
  });
  await boundary.acquire(0);
  const rootRef = (await boundary.executeInput({
    principal: { kind: "worker" as const, workerId: "ingress" },
    ownerEpoch: 1,
  }, {
    kind: OWNER_ACTION_ADMISSION,
    domain: "logical",
    key: ownerActionAdmissionKey(ownerId, namespace, "root"),
    input: {
      namespace,
      actionAlias: "parent",
      requestId: "root",
      input: { private: "parent-input" },
      metadata: { principal: "original-principal" },
      provenance: {},
    },
  })).result as OwnerChildActionReference;
  function assign(
    ref: OwnerChildActionReference,
    id: string,
    parentActionRunId?: string,
  ): OwnerExecutionAssignment {
    const a: OwnerExecutionAssignment = {
      ownerId,
      workerId: `worker:${id}`,
      assignmentId: id,
      sessionId: `session:${id}`,
      namespace,
      actionId: ref.actionId,
      deliveryId: ref.deliveryId,
      dispatchAttemptId: `attempt:${id}`,
      ctxGranted: true,
      settlementGranted: true,
      invocation: {
        actionRunId: ref.executionId,
        rootKey: rootRef.executionId,
        operationKey: ref.executionId,
        metadata: parentActionRunId ? {} : { principal: "original-principal" },
        ...(parentActionRunId ? { parentActionRunId } : {}),
        identity: {
          causationId: ref.eventId,
          settlementScopeId: rootRef.eventId,
        },
      },
    };
    assignments.set(id, a);
    return a;
  }
  const caller = (a = state.parent!): OwnerCaller => ({
    principal: { kind: "worker" as const, workerId: a.workerId },
    ownerEpoch: 1,
    assignmentId: a.assignmentId,
    sessionId: a.sessionId,
    dispatchAttemptId: a.dispatchAttemptId,
  });
  async function claim(a: OwnerExecutionAssignment) {
    return await boundary.execute(caller(a), {
      kind: "execution.claim",
      domain: "incarnation",
      key: ownerClaimKey(ownerId, a.assignmentId, a.sessionId),
      intent: { assignmentId: a.assignmentId, sessionId: a.sessionId },
    });
  }
  state.parent = assign(rootRef, "parent");
  await claim(state.parent);
  function request(
    alias = "child",
    input: OwnerJson = { b: 2, a: 1 },
    operationKey = "local",
  ): OwnerInputCommand {
    const a = state.parent!;
    return {
      kind: OWNER_CHILD_ACTION_ADMISSION,
      domain: "logical",
      key: ownerChildActionKey(
        ownerId,
        namespace,
        a.invocation.operationKey,
        registry.actions[alias as keyof typeof registry.actions].id,
        operationKey,
      ),
      input: {
        parent: {
          deliveryId: a.deliveryId,
          dispatchAttemptId: a.dispatchAttemptId,
          operationKey: a.invocation.operationKey,
        },
        actionAlias: alias,
        operationKey,
        input,
      },
    };
  }
  const admit = (command = request()) =>
    boundary.executeInput(caller(), command);
  const project = (ref: OwnerChildActionReference) =>
    boundary.project(caller(), OWNER_CHILD_ACTION_RESULT, {
      parent: {
        deliveryId: state.parent!.deliveryId,
        dispatchAttemptId: state.parent!.dispatchAttemptId,
        operationKey: state.parent!.invocation.operationKey,
      },
      reference: ref,
    });
  async function complete(ref: OwnerChildActionReference, output: OwnerJson) {
    const a = assign(ref, `child:${ref.actionId}`, rootRef.executionId);
    await claim(a);
    return await boundary.executeInput(caller(a), {
      kind: "execution.complete",
      domain: "logical",
      key: ownerCompletionKey(ownerId, namespace, ref.executionId),
      input: {
        namespace,
        executionId: ref.executionId,
        completion: { status: "completed", output },
      },
    });
  }
  return {
    db,
    boundary,
    state,
    registry,
    request,
    admit,
    project,
    complete,
    rootRef,
    caller,
    assignments,
    assign,
    claim,
    gate,
    store,
    close: () => db.close(),
  };
}

test("child admission preserves target-scoped identity, canonical replay and one inherited operation", async () => {
  const f = await setup();
  try {
    const one = await f.admit();
    const ref = one.result as OwnerChildActionReference;
    assert.equal(one.status, "committed");
    assert.deepEqual(await f.admit(f.request("child", { a: 1, b: 2 })), {
      status: "duplicate",
      result: ref,
    });
    await assert.rejects(
      f.admit(f.request("child", { a: 2, b: 2 })),
      errorCode("owner_intent_conflict"),
    );
    const other = (await f.admit(f.request("other")))
      .result as OwnerChildActionReference;
    assert.notEqual(other.executionId, ref.executionId);
    assert.equal(
      ref.executionId,
      `${f.rootRef.executionId}/action:fixture.child:local`,
    );
    const deliveries = (await f.db.query<{ settlement_scope_id: string }>(
      "SELECT settlement_scope_id FROM event_deliveries",
    )).rows;
    assert.equal(deliveries.length, 3);
    assert.ok(
      deliveries.every((row) => row.settlement_scope_id === f.rootRef.eventId),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM copilotz_operations")).rows.length,
      1,
    );
    const source = await f.store.getEvent(ref.eventId);
    assert.deepEqual(source!.metadata.actionMetadata, {});
    assert.equal(source!.metadata.parentActionRunId, f.rootRef.executionId);
    assert.equal(source!.causationId, f.rootRef.eventId);
    assert.equal(source!.correlationId, f.rootRef.executionId);
    assert.deepEqual(await f.project(ref), { status: "pending" });
    const receipts = (await f.db.query<{ result: unknown }>(
      "SELECT result FROM owner_receipts WHERE kind=$1",
      [OWNER_CHILD_ACTION_ADMISSION],
    )).rows;
    assert.ok(
      receipts.every((row) =>
        Object.keys(row.result as object).sort().join(",") ===
          "actionId,deliveryId,eventId,executionId,namespace"
      ),
    );
  } finally {
    await f.close();
  }
});

test("child authorization isolates returned host bindings before awaited SQL", async () => {
  const f = await setup();
  try {
    f.state.mutateReturned = true;
    const result = await f.admit();
    assert.equal(result.status, "committed");
    assert.equal(
      (result.result as OwnerChildActionReference).namespace,
      namespace,
    );
    assert.equal(f.state.returnedParent?.namespace, "spoofed");
  } finally {
    await f.close();
  }
});

test("child result is current-parent authorized, ordinary output and never a safe receipt body", async () => {
  const f = await setup();
  try {
    const ref = (await f.admit()).result as OwnerChildActionReference;
    await f.complete(ref, { answer: "child-output" });
    assert.deepEqual(await f.project(ref), {
      status: "completed",
      output: { answer: "child-output" },
    });
    f.state.ctx = false;
    const before = f.state.receiptReads;
    await assert.rejects(f.admit(), errorCode("ActionOwnershipLost"));
    assert.equal(f.state.receiptReads, before);
    await assert.rejects(f.project(ref), errorCode("ActionOwnershipLost"));
    f.state.ctx = true;
    f.state.policy = false;
    await assert.rejects(f.admit(), /current child policy denied/);
    await assert.rejects(f.project(ref), /current child policy denied/);
    f.state.policy = true;
    await assert.rejects(
      f.project({ ...ref, namespace: "foreign" }),
      errorCode("action_result_unavailable"),
    );
    await f.db.query(
      "UPDATE copilotz_operations SET cancellation_requested_at=$1 WHERE operation_id=$2",
      [initialTime, f.rootRef.eventId],
    );
    await assert.rejects(f.project(ref), errorCode("ActionOwnershipLost"));
  } finally {
    await f.close();
  }
});

test("child admission rejects parent, attempt, namespace and option spoofing before replay", async () => {
  const f = await setup();
  try {
    await f.admit();
    for (
      const [key, value] of [["deliveryId", "foreign"], [
        "dispatchAttemptId",
        "old",
      ], ["operationKey", "other-parent"]]
    ) {
      const command = f.request();
      const input = command.input as Record<string, OwnerJson>;
      await assert.rejects(
        f.admit({
          ...command,
          input: {
            ...input,
            parent: {
              ...(input.parent as Record<string, OwnerJson>),
              [key]: value,
            },
          },
        }),
        errorCode("ActionOwnershipLost"),
      );
    }
    const command = f.request();
    await assert.rejects(
      f.admit({
        ...command,
        key: ownerChildActionKey(
          ownerId,
          "foreign",
          f.rootRef.executionId,
          "fixture.child",
          "local",
        ),
      }),
      errorCode("ActionOwnershipLost"),
    );
    for (const field of ["metadata", "identity", "prepare", "namespace"]) {
      await assert.rejects(
        f.admit({
          ...command,
          input: {
            ...(command.input as Record<string, OwnerJson>),
            [field]: {},
          },
        }),
        /Unsupported child Action fields/,
      );
    }
    await assert.rejects(
      f.boundary.executeInput({ ...f.caller(), ownerEpoch: 0 }, command),
      errorCode("ActionOwnershipLost"),
    );
    f.state.time = "2020-01-01T00:01:01.000Z";
    await assert.rejects(f.admit(), errorCode("ActionOwnershipLost"));
  } finally {
    await f.close();
  }
});

test("replacement parent attempts replay the same logical child without another delivery", async () => {
  const f = await setup();
  try {
    const ref = (await f.admit()).result as OwnerChildActionReference;
    const old = f.caller();
    f.state.time = "2020-01-01T00:01:01.000Z";
    const replacement = f.assign(f.rootRef, "replacement");
    f.state.parent = replacement;
    await f.claim(replacement);
    assert.deepEqual(await f.admit(), { status: "duplicate", result: ref });
    assert.equal(
      (await f.db.query("SELECT * FROM event_deliveries")).rows.length,
      2,
    );
    await assert.rejects(
      f.boundary.executeInput(old, f.request()),
      errorCode("ActionOwnershipLost"),
    );
  } finally {
    await f.close();
  }
});

test("a changed assignment cannot replace the durable Action parent operation identity", async () => {
  const f = await setup();
  try {
    const first = await f.admit();
    const original = f.state.parent!;
    const changed = {
      ...original,
      invocation: {
        ...original.invocation,
        operationKey: `${original.invocation.actionRunId}/custom`,
      },
    };
    f.state.parent = changed;
    f.assignments.set(changed.assignmentId, changed);
    await assert.rejects(f.admit(), errorCode("ActionOwnershipLost"));
    assert.equal(
      (await f.db.query("SELECT * FROM event_deliveries")).rows.length,
      2,
    );
    f.state.parent = original;
    f.assignments.set(original.assignmentId, original);
    assert.deepEqual(await f.admit(), {
      status: "duplicate",
      result: first.result,
    });
  } finally {
    await f.close();
  }
});

test("child references and scheduling are gated on outer commit and rollback leaves no child", async () => {
  const f = await setup();
  try {
    f.state.hold = true;
    let returned = false;
    const pending = f.admit().then((value) => {
      returned = true;
      return value;
    });
    await f.gate.reached.promise;
    assert.equal(returned, false);
    assert.deepEqual(f.state.scheduled, []);
    f.gate.release.resolve();
    const ref = (await pending).result as OwnerChildActionReference;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(f.state.scheduled, [ref]);
    f.state.rollBack = true;
    await assert.rejects(
      f.admit(f.request("other")),
      errorCode("owner_commit_unknown"),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM event_deliveries")).rows.length,
      2,
    );
    assert.deepEqual(f.state.scheduled, [ref]);
  } finally {
    await f.close();
  }
});

test("child capacity counts the parent, refuses boundedly at one and rejects protected/content input", async () => {
  const f = await setup(1);
  try {
    await assert.rejects(f.admit(), errorCode("owner_admission_refused"));
    assert.equal(
      (await f.db.query("SELECT * FROM event_deliveries")).rows.length,
      1,
    );
    for (
      const schema of [
        "copilotz.action.lifecycle.protected.v1",
        "copilotz.action.protected-value.v1",
      ]
    ) {
      await assert.rejects(
        f.admit(f.request("child", { nested: { schema } })),
        /ordinary JSON/,
      );
    }
    await assert.rejects(
      f.admit(f.request("protected")),
      /protected\/content\/deferred/,
    );
  } finally {
    await f.close();
  }
});

test("compatible child admission needs no new delivery slot at capacity", async () => {
  const f = await setup(2);
  try {
    const reference = (await f.admit()).result;
    assert.deepEqual(await f.admit(), {
      status: "duplicate",
      result: reference,
    });
    await assert.rejects(
      f.admit(f.request("other")),
      errorCode("owner_admission_refused"),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM event_deliveries")).rows.length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("pure child capability waits outside SQL and returns the own Action output", async () => {
  const f = await setup();
  try {
    const port = createOwnerChildActionPort({
      ownerId,
      namespace,
      parentOperationKey: f.rootRef.executionId,
      registry: f.registry,
      port: {
        executeInput: async (command, options) => {
          const admitted = await f.boundary.executeInput(
            f.caller(),
            command,
            options,
          );
          assert.equal(f.state.inTransaction, false);
          await f.complete(admitted.result as OwnerChildActionReference, {
            answer: 42,
          });
          return admitted;
        },
        project: (kind, input, options) =>
          f.boundary.project(f.caller(), kind, input, options),
      },
    });
    const a = f.state.parent!;
    assert.deepEqual(
      await port.call(
        { deliveryId: a.deliveryId, dispatchAttemptId: a.dispatchAttemptId },
        "child",
        {},
        "port",
      ),
      { answer: 42 },
    );
  } finally {
    await f.close();
  }
});

test("child admission and result refuse nested ContentRefs and protected value envelopes", async () => {
  const f = await setup();
  try {
    const content = {
      assetId: "asset",
      kind: "text",
      role: "input",
      mediaType: "text/plain",
    };
    await assert.rejects(
      f.admit(f.request("child", { nested: content })),
      /ordinary JSON/,
    );
    const ref = (await f.admit()).result as OwnerChildActionReference;
    await f.complete(ref, { nested: content });
    await assert.rejects(f.project(ref), /ordinary JSON/);
    const second = (await f.admit(f.request("other")))
      .result as OwnerChildActionReference;
    await f.complete(second, {
      schema: "copilotz.action.protected-value.v1",
      private: "never project",
    });
    await assert.rejects(f.project(second), /ordinary JSON/);
  } finally {
    await f.close();
  }
});

test("Processor child Actions retain stable delivery identity and existing inherited or detached scope", async () => {
  for (const detached of [false, true]) {
    const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
    try {
      for (const sql of createCoreSchemaStatements("public")) {
        await db.query(sql);
      }
      await provisionOperationCatalog(db, "public");
      await provisionOwnerCommandSchema(db, "public");
      const processor = defineProcessor({
        id: "fixture.observe",
        on: [{ eventType: "fixture.source" }],
        handle() {},
      });
      const registry = createPluginRegistry({
        processors: { observe: processor },
        actions: {
          child: defineAction({ id: "fixture.child", execute: () => null }),
        },
      });
      const catalog = createOperationCatalog(db, "public");
      let live = true;
      const commands = createOwnerProcessorCommands({
        ownerId,
        schema: "public",
        session: db,
        registry,
        catalog,
        resolveAssignment() {
          return live ? assignment : undefined;
        },
        authorizeEvent() {},
        scheduleSettlement() {},
        scheduleRetry() {},
      });
      const children = createOwnerChildActions({
        ownerId,
        schema: "public",
        session: db,
        registry,
        catalog,
        async resolveParent(tx, caller, time) {
          return {
            kind: "processor",
            assignment:
              (await commands.authorizeLive(tx, caller, time)).assignment,
          };
        },
        authorizeChild(_tx, _caller, parent) {
          assert.deepEqual(parent.originalMetadata, {
            actionMetadata: { bait: "never call metadata" },
          });
        },
        schedule() {},
      });
      const boundary = createOwnerCommandBoundary({
        ownerId,
        holderId: "holder",
        schema: "public",
        session: db,
        now: () => initialTime,
        handlers: {
          ...commands.handlers,
          [OWNER_CHILD_ACTION_ADMISSION]: children.handler,
          async seed(_intent, context) {
            const store = createEventStore({
              session: db,
              ownerCommit: context.ownerCommit,
              admitOperationEventSql: (input, param) =>
                catalog.admitEventSql(input, param),
              indexOperationEventSql: (input, param) =>
                catalog.indexEventSql(input, param),
              indexOperationEvent: (tx, input) => catalog.indexEvent(tx, input),
            });
            const result = await store.commitMutation({
              transaction: context.tx,
              draft: {
                type: "fixture.source",
                namespace,
                payload: {
                  dataRef: {
                    eventBodyId: "source-body",
                    schemaVersion: 1,
                    mediaType: "application/json",
                  },
                },
                metadata: { actionMetadata: { bait: "never call metadata" } },
              },
              body: { id: "source-body", json: {} },
              consumers: [{
                consumerId: `processor:${processor.id}`,
                settlement: detached ? "detached" : "inherit",
              }],
            });
            return {
              eventId: result.event.id,
              deliveryId: result.deliveries[0].id,
            };
          },
        },
        inputDefinitions: {
          [OWNER_CHILD_ACTION_ADMISSION]: children.inputDefinition,
        },
        projections: { [OWNER_CHILD_ACTION_RESULT]: children.projection },
        async authorize(tx, caller, command, time, input) {
          if (command.kind === "seed") return;
          if (command.kind.startsWith("action.child-")) {
            return await children.authorize(tx, caller, command, time, input);
          }
          await commands.authorize(tx, caller, command, time);
        },
        authenticateReceipt() {},
      });
      await boundary.acquire(0);
      const source = (await boundary.execute({
        principal: { kind: "worker" as const, workerId: "seed" },
        ownerEpoch: 1,
      }, {
        kind: "seed",
        domain: "logical",
        key: "seed",
        intent: null,
      })).result as { eventId: string; deliveryId: string };
      const assignment: OwnerProcessorAssignment = {
        kind: "processor",
        ownerId,
        workerId: "worker",
        assignmentId: "assignment",
        sessionId: "session",
        namespace,
        processorId: processor.id,
        sourceEventId: source.eventId,
        deliveryId: source.deliveryId,
        dispatchAttemptId: "attempt",
        ctxGranted: true,
        settlementGranted: true,
      };
      const caller: OwnerCaller = {
        principal: { kind: "worker" as const, workerId: "worker" },
        ownerEpoch: 1,
        assignmentId: "assignment",
        sessionId: "session",
        dispatchAttemptId: "attempt",
      };
      await boundary.execute(caller, {
        kind: "processor.claim",
        domain: "incarnation",
        key: ownerProcessorClaimKey(ownerId, "assignment", "session"),
        intent: { assignmentId: "assignment", sessionId: "session" },
      });
      const store = createEventStore({ session: db });
      const parent = (await store.getDelivery(source.deliveryId))!;
      const beforeOperations =
        (await db.query("SELECT * FROM copilotz_operations")).rows.length;
      const operationKey = `delivery:${source.deliveryId}`;
      const command: OwnerInputCommand = {
        kind: OWNER_CHILD_ACTION_ADMISSION,
        domain: "logical",
        key: ownerChildActionKey(
          ownerId,
          namespace,
          operationKey,
          "fixture.child",
          "same",
        ),
        input: {
          parent: {
            deliveryId: source.deliveryId,
            dispatchAttemptId: "attempt",
            operationKey,
          },
          actionAlias: "child",
          operationKey: "same",
          input: {},
        },
      };
      const first = await boundary.executeInput(caller, command);
      const reference = first.result as OwnerChildActionReference;
      assert.equal(
        reference.executionId,
        `${operationKey}/action:fixture.child:same`,
      );
      assert.deepEqual(await boundary.executeInput(caller, command), {
        status: "duplicate",
        result: reference,
      });
      assert.equal(
        (await store.getDelivery(reference.deliveryId))!.settlementScopeId,
        parent.settlementScopeId,
      );
      assert.equal(
        (await db.query("SELECT * FROM copilotz_operations")).rows.length,
        beforeOperations,
      );
      assert.equal(parent.settlementScopeId.startsWith("detached:"), detached);
      assert.deepEqual(
        (await store.getEvent(reference.eventId))!.metadata.actionMetadata,
        {},
      );
      assert.equal(
        (await db.query("SELECT * FROM open_actions")).rows.length,
        0,
      );
      live = false;
      await assert.rejects(
        boundary.executeInput(caller, command),
        errorCode("ActionOwnershipLost"),
      );
      await assert.rejects(
        boundary.project(caller, OWNER_CHILD_ACTION_RESULT, {
          parent: {
            deliveryId: source.deliveryId,
            dispatchAttemptId: "attempt",
            operationKey,
          },
          reference,
        }),
        errorCode("ActionOwnershipLost"),
      );
    } finally {
      await db.close();
    }
  }
});
