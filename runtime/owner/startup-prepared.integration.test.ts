/** Actual writer/scanner adapter proof. The ordinary source is a deterministic
 * trusted test port; it does not certify production source hydration or public
 * transport restart, which have their own integration acceptance gate. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createEventStore } from "../events/store.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { ownerClaimKey, ownerCompletionKey } from "../execution/owner-port.ts";
import type { OwnerChildActionReference } from "../execution/child-action-port.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createOwnerCommandBoundary, type OwnerCaller } from "./boundary.ts";
import {
  createOwnerAssignmentControl,
  ownerAssignmentKey,
  provisionOwnerAssignments,
} from "./assignments.ts";
import {
  createOwnerActionAdmission,
  OWNER_ACTION_ADMISSION,
  ownerActionAdmissionKey,
  validateOwnerActionAdmissionIdentity,
} from "./admission.ts";
import { createOwnerChildActions } from "./child-action.ts";
import { createOwnerExecutionCommands } from "./execution.ts";
import {
  createOwnerPreparations,
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationKey,
} from "./preparation.ts";
import { createOwnerOperationSettlement } from "./settlement.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerStartupProof,
  OWNER_STARTUP_PROOF,
  OWNER_STARTUP_REPAIR,
  ownerStartupRepairKey,
} from "./startup.ts";
import { ownerReconciliationAlarm } from "./reconciliation.ts";

async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    rendered: 0,
    authorized: 0,
    input: "original",
    originalAllowed: true,
  };
  const registry = createPluginRegistry({
    collections: {
      note: defineCollection({
        name: "note",
        schema: { type: "object" } as const,
      }),
    },
    actions: {
      parent: defineAction({
        id: "fixture.parent",
        execute: (value: unknown) => value,
      }),
      child: defineAction({
        id: "fixture.child",
        execute: (value: unknown) => value,
      }),
    },
  });
  const catalog = createOperationCatalog(db, "public");
  const store = createEventStore({ session: db, schema: "public" });
  const assignments = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    isCurrentStarted: () => true,
    authorizeControl(_tx, caller) {
      assert.equal(caller.principal.kind, "owner-control");
    },
  });
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "prepared-startup",
    workloads: {},
    scheduleDelivery() {},
    dispatchWork: () => Promise.reject(new Error("No business dispatch")),
    dispatchDelivery: () => Promise.reject(new Error("No business dispatch")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("No recovery dispatch")),
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session: db,
    catalog,
    authorizeControl: (_tx, caller) =>
      caller.principal.kind === "owner-control",
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake() {},
  });
  const execution = createOwnerExecutionCommands({
    ownerId: "owner",
    schema: "public",
    session: db,
    registry,
    catalog,
    executor,
    scheduleSettlement: settlement.schedule,
    allowRecovery: () => true,
    async resolveAssignment(tx, caller) {
      const b = await assignments.resolveStarted(tx, caller);
      if (!b || b.placement !== "worker" || "kind" in b) return undefined;
      const source = (await tx.query<
        { metadata: Record<string, unknown>; settlement_scope_id: string }
      >(
        "SELECT e.metadata,d.settlement_scope_id FROM events e JOIN event_deliveries d ON d.event_id=e.id WHERE d.id=$1",
        [b.deliveryId],
      )).rows[0];
      return {
        ...b,
        ownerId: "owner",
        ctxGranted: true,
        settlementGranted: true,
        invocation: {
          actionRunId: b.executionId,
          operationKey: b.executionId,
          rootKey: String(source.metadata.rootKey ?? b.executionId),
          metadata: {},
          ...(source.metadata.parentActionRunId === undefined
            ? {}
            : { parentActionRunId: String(source.metadata.parentActionRunId) }),
          identity: {
            causationId: b.sourceEventId,
            settlementScopeId: source.settlement_scope_id,
          },
        },
      };
    },
    authorizeInput() {},
    authorizePreparedInput: (tx, input) =>
      preparations.authorizeCaptured(tx, input),
  });
  const children = createOwnerChildActions({
    ownerId: "owner",
    schema: "public",
    session: db,
    registry,
    catalog,
    // This startup fixture supplies its own private Started grant (the SQL
    // assignment resolver above also uses an explicit fixture grant).
    isCurrentParent(who, binding) {
      if (binding.kind !== "action") return false;
      const a = binding.assignment;
      if (a.placement !== "worker") return false;
      return who.principal.kind === "worker" &&
        who.principal.workerId === a.workerId &&
        who.assignmentId === a.assignmentId && who.sessionId === a.sessionId &&
        who.dispatchAttemptId === a.dispatchAttemptId;
    },
    async resolveParent(tx, caller, time) {
      const assignment = await execution.authorizeLive(tx, caller, time);
      if (assignment.placement !== "worker") throw new Error("worker required");
      return { kind: "action", assignment };
    },
    authorizeChild() {},
    schedule() {},
    authorizePreparedInput: (tx, input) =>
      preparations.authorizeCaptured(tx, input),
  });
  const preparations = createOwnerPreparations({
    ownerId: "owner",
    schema: "public",
    registry,
    children,
    source: {
      capture: () =>
        Promise.resolve({
          projection: { record: { title: state.input }, content: [] },
          reference: {
            source: {
              name: "notes",
              kind: "note",
              selection: "record",
              recordId: "n1",
              namespace: "space",
              digest: `sha256:${"a".repeat(64)}`,
            },
            audience: "reader",
            content: [],
          },
        }),
      authorizeOriginal: () => {
        state.authorized++;
        if (!state.originalAllowed) {
          return Promise.reject(new Error("original forbidden"));
        }
        return Promise.resolve();
      },
      projections: {
        "preparation.source": () => {
          throw new Error("unused");
        },
      },
    },
    preparations: {
      context: {
        source: "notes",
        actionAlias: "child",
        shows: "note",
        modes: ["context"],
        mapInput(text) {
          state.rendered++;
          return text;
        },
      },
    },
    projectResource() {
      throw new Error("no resource");
    },
    authorizeResource() {
      throw new Error("no resource");
    },
  });
  const root = createOwnerActionAdmission({
    ownerId: "owner",
    schema: "public",
    session: db,
    registry,
    catalog,
    schedule() {},
  });
  const facts = preparations.historyRegistrations().map((
    { source, ...value },
  ) => ({
    ...value,
    source: { name: source, kind: "note", selection: "record" as const },
  }));
  const boundaries: ReturnType<typeof createOwnerCommandBoundary>[] = [];
  let epoch = 1;
  function caller(): OwnerCaller {
    return {
      principal: {
        kind: "owner-control",
        ownerId: "owner",
        epoch,
        holderId: `holder:${epoch}`,
      },
      ownerEpoch: epoch,
    };
  }
  function create(
    coverage: "configured" | "omitted" = "configured",
    maxItems = 10_000,
    maxBytes = 32 * 1024 * 1024,
  ) {
    const startup = createOwnerStartupProof({
      ownerId: "owner",
      schema: "public",
      registry,
      namespaces: ["space"],
      maxItems,
      maxBytes,
      ...(coverage === "configured" ? { prepared: facts } : {}),
      authorizeControl: (_tx, value) =>
        value.principal.kind === "owner-control",
    });
    const boundary = createOwnerCommandBoundary({
      ownerId: "owner",
      holderId: `holder:${epoch}`,
      schema: "public",
      session: db,
      now: () => "2026-10-17T00:00:00.000Z",
      handlers: {
        ...assignments.handlers,
        ...execution.handlers,
        ...startup.handlers,
        ...settlement.handlers,
        [OWNER_ACTION_ADMISSION]: root.handler,
        [OWNER_CHILD_ACTION_PREPARATION]: preparations.handler,
      },
      inputDefinitions: {
        ...execution.inputDefinitions,
        [OWNER_ACTION_ADMISSION]: root.inputDefinition,
        [OWNER_CHILD_ACTION_PREPARATION]: preparations.inputDefinition,
      },
      projections: {
        ...execution.projections,
        ...startup.projections,
        ...settlement.projections,
      },
      async authorize(tx, value, command, time, input) {
        if (command.kind.startsWith("assignment.")) {
          return await assignments.authorize(tx, value, command, time);
        }
        if (command.kind.startsWith("startup.")) {
          return await startup.authorize(tx, value, command, time);
        }
        if (command.kind.startsWith("operation.")) {
          return await settlement.authorize(tx, value, command, time);
        }
        if (command.kind === OWNER_CHILD_ACTION_PREPARATION) {
          return await preparations.authorize(tx, value, command, time, input);
        }
        if (command.kind === OWNER_ACTION_ADMISSION) {
          validateOwnerActionAdmissionIdentity("owner", command, input);
          return;
        }
        return await execution.authorize(tx, value, command, time, input);
      },
      authenticateReceipt() {
        throw new Error("No generic receipt authority");
      },
    });
    boundaries.push(boundary);
    return boundary;
  }
  let current = create();
  await current.acquire(0);
  const parent = (await current.executeInput({
    principal: { kind: "worker", workerId: "ingress" },
    ownerEpoch: epoch,
  }, {
    kind: OWNER_ACTION_ADMISSION,
    domain: "logical",
    key: ownerActionAdmissionKey("owner", "space", "root"),
    input: {
      namespace: "space",
      actionAlias: "parent",
      requestId: "root",
      input: {},
      metadata: {},
      provenance: {},
    },
  })).result as OwnerChildActionReference;
  const binding = (ref: OwnerChildActionReference) => ({
    placement: "worker" as const,
    workerId: `worker:${ref.actionId}`,
    workerAttemptId: `provision:${ref.actionId}`,
    sessionGeneration: 1,
    sessionId: `session:${ref.actionId}`,
    parentOperationId: `stream:${ref.actionId}`,
    assignmentId: `assignment:${ref.actionId}`,
    dispatchAttemptId: `attempt:${ref.actionId}`,
    namespace: ref.namespace,
    sourceEventId: ref.eventId,
    deliveryId: ref.deliveryId,
    actionId: ref.actionId,
    executionId: ref.executionId,
  });
  function worker(ref: OwnerChildActionReference): OwnerCaller {
    const b = binding(ref);
    return {
      principal: { kind: "worker", workerId: b.workerId },
      ownerEpoch: epoch,
      assignmentId: b.assignmentId,
      sessionId: b.sessionId,
      dispatchAttemptId: b.dispatchAttemptId,
      workerAttemptId: b.workerAttemptId,
      sessionGeneration: b.sessionGeneration,
      parentOperationId: b.parentOperationId,
    };
  }
  async function claim(ref: OwnerChildActionReference) {
    const b = binding(ref);
    await current.execute(caller(), {
      kind: "assignment.bind",
      domain: "incarnation",
      key: `${ownerAssignmentKey("owner", b)}:assignment.bind`,
      intent: b,
    });
    return await current.execute(worker(ref), {
      kind: "execution.claim",
      domain: "incarnation",
      key: ownerClaimKey("owner", b.assignmentId, b.sessionId),
      intent: { assignmentId: b.assignmentId, sessionId: b.sessionId },
    });
  }
  async function complete(ref: OwnerChildActionReference) {
    return await current.executeInput(worker(ref), {
      kind: "execution.complete",
      domain: "logical",
      key: ownerCompletionKey("owner", "space", ref.executionId),
      input: {
        namespace: "space",
        executionId: ref.executionId,
        completion: { status: "completed", output: "done" },
      },
    });
  }
  await claim(parent);
  const request = {
    kind: OWNER_CHILD_ACTION_PREPARATION,
    domain: "logical" as const,
    key: ownerPreparationKey(
      "owner",
      "space",
      parent.executionId,
      "context",
      "reply",
    ),
    input: {
      parent: {
        deliveryId: parent.deliveryId,
        dispatchAttemptId: binding(parent).dispatchAttemptId,
        operationKey: parent.executionId,
      },
      preparation: "context",
      targetActionId: "fixture.child",
      operationKey: "reply",
      recordId: "n1",
      hints: { mode: "context", renderer: "text" },
    },
  };
  const child = (await current.executeInput(worker(parent), request))
    .result as OwnerChildActionReference;
  return {
    db,
    state,
    registry,
    facts,
    parent,
    child,
    request,
    binding,
    store,
    caller,
    get current() {
      return current;
    },
    async finish() {
      await claim(child);
      await complete(child);
      await complete(parent);
      await settlement.run({
        boundary: current,
        caller: caller(),
        target: { namespace: "space", operationId: parent.eventId },
        occurrence: "settle",
      });
    },
    async takeover(
      coverage: "configured" | "omitted" = "configured",
      maxItems = 10_000,
      maxBytes = 32 * 1024 * 1024,
    ) {
      const prior = epoch++;
      current = create(coverage, maxItems, maxBytes);
      await current.acquire(prior);
    },
    repair: (id = crypto.randomUUID()) =>
      current.execute(caller(), {
        kind: OWNER_STARTUP_REPAIR,
        domain: "occurrence",
        key: ownerStartupRepairKey("owner", epoch, id),
        intent: { occurrence: id },
      }),
    proof: () => current.project(caller(), OWNER_STARTUP_PROOF, null),
    async close() {
      boundaries.forEach((boundary) => boundary.stop());
      await db.close();
    },
  };
}

/** Corruption-only transaction in the disposable fixture. Production semantic
 * event immutability remains enabled before and after this exact mutation. */
async function removePreparationMarker(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  id: string,
) {
  await db.transaction(async (tx) => {
    await tx.query(
      'ALTER TABLE events DISABLE TRIGGER "copilotz_events_immutable"',
    );
    await tx.query(
      "UPDATE events SET metadata=metadata-'preparation' WHERE id=$1",
      [id],
    );
    await tx.query(
      'ALTER TABLE events ENABLE TRIGGER "copilotz_events_immutable"',
    );
  });
}
function blockers(value: unknown): unknown[] {
  return (value as { blockers: unknown[] }).blockers;
}
test("startup accepts genuine closed prepared writers without re-render or policy impersonation", async () => {
  const f = await fixture();
  try {
    await f.finish();
    const before = { ...f.state };
    f.state.originalAllowed = false;
    f.state.input = "changed after capture";
    await f.takeover();
    assert.deepEqual(blockers((await f.repair()).result), []);
    await f.proof();
    assert.equal(f.state.rendered, before.rendered);
    assert.equal(f.state.authorized, before.authorized);
    const rows = await f.db.query<{ retired: boolean }>(
      "SELECT retired FROM owner_assignments",
    );
    assert.ok(rows.rows.every((row) => row.retired));
  } finally {
    await f.close();
  }
});
test("startup inventories orphan preparation kind and key-prefix receipts even without configuration", async () => {
  const f = await fixture();
  try {
    await f.finish();
    await f.db.query("UPDATE owner_receipts SET kind='changed' WHERE kind=$1", [
      OWNER_CHILD_ACTION_PREPARATION,
    ]);
    await f.takeover("omitted");
    const result = (await f.repair()).result;
    assert.ok(
      blockers(result).some((value) =>
        (value as { id: string }).id === "startup.prepared"
      ),
    );
    await assert.rejects(f.proof());
    const childRows = await f.db.query<{ retired: boolean }>(
      "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
      [f.child.deliveryId],
    );
    assert.equal(childRows.rows[0].retired, false);
  } finally {
    await f.close();
  }
});
test("startup refuses missing, conflicting and orphan prepared receipts with a bounded stable alarm", async () => {
  const f = await fixture();
  try {
    await f.finish();
    // Corrupt only this preparation association, removing its dependent reader
    // row before replacing the key so the fixture preserves foreign keys.
    await f.db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM owner_receipt_readers rr USING owner_receipts r WHERE rr.owner=r.owner AND rr.domain=r.domain AND rr.key=r.key AND r.kind=$1",
        [OWNER_CHILD_ACTION_PREPARATION],
      );
      await tx.query("UPDATE owner_receipts SET key=$1 WHERE kind=$2", [
        '["action.child-prepare",' + "x".repeat(1800),
        OWNER_CHILD_ACTION_PREPARATION,
      ]);
    });
    await f.takeover();
    const result = (await f.repair()).result;
    assert.ok(
      blockers(result).some((value) =>
        (value as { id: string }).id === "startup.prepared"
      ),
    );
    const alarm = ownerReconciliationAlarm("owner", {
      kind: "blocker",
      namespace: null,
      id: "startup.prepared",
    });
    assert.equal(
      (await f.db.query("SELECT name FROM owner_alarms WHERE name=$1", [alarm]))
        .rows.length,
      1,
    );
    await assert.rejects(f.proof());
  } finally {
    await f.close();
  }
});
test("startup keeps pending prepared children unretired and outside dispatch readiness", async () => {
  const f = await fixture();
  try {
    await f.takeover();
    assert.ok(blockers((await f.repair()).result).length);
    await assert.rejects(f.proof());
    assert.equal(
      (await f.db.query("SELECT name FROM owner_alarms WHERE name=$1", [
        JSON.stringify(["host.delivery", "space", f.child.deliveryId]),
      ])).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});
test("startup prepared evidence shares aggregate bounds and does not return partial matches", async () => {
  const f = await fixture();
  try {
    await f.finish();
    await f.takeover("configured", 150);
    await assert.rejects(f.repair(), /inventory|budget/);
    assert.equal(
      (await f.db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM owner_assignments WHERE retired=TRUE",
      )).rows[0].count,
      0,
    );
  } finally {
    await f.close();
  }
});

test("startup retains a disappeared prepared alarm under omitted coverage and clears it only with explicit complete proof", async () => {
  const f = await fixture();
  try {
    await f.finish();
    const alarm = ownerReconciliationAlarm("owner", {
      kind: "blocker",
      namespace: null,
      id: "startup.prepared",
    });
    await f.db.query(
      "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,'2026-10-17'::timestamptz)",
      [alarm],
    );
    // Deliberately remove just the preparation protocol association in this
    // corruption fixture, leaving canonical ordinary lifecycle evidence.
    await removePreparationMarker(f.db, f.child.eventId);
    await f.db.query("DELETE FROM owner_receipts WHERE kind=$1", [
      OWNER_CHILD_ACTION_PREPARATION,
    ]);
    await f.takeover("omitted");
    assert.ok(
      blockers((await f.repair()).result).some((value) =>
        (value as { id: string }).id === "startup.prepared"
      ),
    );
    await assert.rejects(f.proof());
    await f.takeover("configured");
    assert.deepEqual(blockers((await f.repair()).result), []);
    await f.proof();
    assert.equal(
      (await f.db.query("SELECT name FROM owner_alarms WHERE name=$1", [alarm]))
        .rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("startup detects an unassociated key-prefix preparation receipt without marker or configured coverage", async () => {
  const f = await fixture();
  try {
    await f.finish();
    await removePreparationMarker(f.db, f.child.eventId);
    await f.db.query("UPDATE owner_receipts SET kind='changed' WHERE kind=$1", [
      OWNER_CHILD_ACTION_PREPARATION,
    ]);
    await f.takeover("omitted");
    assert.ok(
      blockers((await f.repair()).result).some((value) =>
        (value as { id: string }).id === "startup.prepared"
      ),
    );
    await assert.rejects(f.proof());
  } finally {
    await f.close();
  }
});

test("startup cannot retire a prepared child whose parent acquired an extra lifecycle row", async () => {
  const f = await fixture();
  try {
    await f.finish();
    // Retained corruption evidence: a second same-run terminal has a genuine
    // body and catalog index, but is not the canonical status-independent ID.
    await f.db.query(
      `WITH extra AS (
      INSERT INTO events(id,schema_version,type,namespace,subject_type,subject_id,payload,metadata,causation_id,correlation_id,deduplication_id,owner_id,seq)
      SELECT 'extra-lifecycle',schema_version,type,namespace,subject_type,subject_id,payload,metadata,causation_id,correlation_id,'extra-lifecycle','owner',(SELECT max(seq)+1 FROM events)
      FROM events WHERE deduplication_id=$1 RETURNING id,namespace,position,created_at
    ) INSERT INTO copilotz_operation_events(namespace,operation_id,event_id,event_position,event_ordinal,created_at)
      SELECT namespace,$2,id,position,(SELECT max(event_ordinal)+1 FROM copilotz_operation_events),created_at FROM extra`,
      [
        `${f.parent.executionId}:action:terminal`,
        f.parent.eventId,
      ],
    );
    await f.takeover();
    const result = (await f.repair()).result;
    assert.ok(
      blockers(result).some((value) =>
        (value as { id: string }).id === "startup.prepared"
      ),
    );
    assert.equal(
      (await f.db.query<{ retired: boolean }>(
        "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
        [f.child.deliveryId],
      )).rows[0].retired,
      false,
    );
    await assert.rejects(f.proof());
  } finally {
    await f.close();
  }
});
test("startup binds the historical parent claim contract before releasing a prepared child", async () => {
  const f = await fixture();
  try {
    await f.finish();
    await f.db.query(
      "UPDATE owner_receipts SET result=jsonb_set(result,'{contract,ownerId}','\"foreign\"'::jsonb) WHERE kind='execution.claim' AND result->>'deliveryId'=$1",
      [f.parent.deliveryId],
    );
    await f.takeover();
    assert.ok(
      blockers((await f.repair()).result).some((value) =>
        (value as { id: string }).id === "startup.prepared"
      ),
    );
    assert.equal(
      (await f.db.query<{ retired: boolean }>(
        "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
        [f.child.deliveryId],
      )).rows[0].retired,
      false,
    );
    await assert.rejects(f.proof());
  } finally {
    await f.close();
  }
});
// Retained corruption cases for the shared canonical-history boundary.
// The original predicate is preserved until their failing-before runtime run.
for (const phase of ["invoked", "terminal"] as const) {
  test(`startup requires prepared child ${phase} correlation to match its source`, async () => {
    const f = await fixture();
    try {
      await f.finish();
      await f.db.transaction(async (tx) => {
        await tx.query(
          'ALTER TABLE events DISABLE TRIGGER "copilotz_events_immutable"',
        );
        await tx.query(
          "UPDATE events SET correlation_id='corrupt-correlation' WHERE deduplication_id=$1",
          [`${f.child.executionId}:action:${phase}`],
        );
        await tx.query(
          'ALTER TABLE events ENABLE TRIGGER "copilotz_events_immutable"',
        );
      });
      await f.takeover();
      assert.ok(
        blockers((await f.repair()).result).some((value) =>
          (value as { id: string }).id === "startup.prepared"
        ),
      );
      assert.equal(
        (await f.db.query<{ retired: boolean }>(
          "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
          [f.child.deliveryId],
        )).rows[0].retired,
        false,
      );
      await assert.rejects(f.proof());
    } finally {
      await f.close();
    }
  });
  test(`startup requires prepared ${phase} catalog membership in its exact delivery scope`, async () => {
    const f = await fixture();
    try {
      await f.finish();
      const other = (await f.current.executeInput({
        principal: { kind: "worker", workerId: "ingress" },
        ownerEpoch: 1,
      }, {
        kind: OWNER_ACTION_ADMISSION,
        domain: "logical",
        key: ownerActionAdmissionKey("owner", "space", "other-root"),
        input: {
          namespace: "space",
          actionAlias: "parent",
          requestId: "other-root",
          input: {},
          metadata: {},
          provenance: {},
        },
      })).result as OwnerChildActionReference;
      await f.db.query(
        "UPDATE copilotz_operation_events SET operation_id=$1 WHERE event_id=(SELECT id FROM events WHERE deduplication_id=$2)",
        [other.eventId, `${f.child.executionId}:action:${phase}`],
      );
      await f.takeover();
      assert.ok(
        blockers((await f.repair()).result).some((value) =>
          (value as { id: string }).id === "startup.prepared"
        ),
      );
      assert.equal(
        (await f.db.query<{ retired: boolean }>(
          "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
          [f.child.deliveryId],
        )).rows[0].retired,
        false,
      );
      await assert.rejects(f.proof());
    } finally {
      await f.close();
    }
  });
}
