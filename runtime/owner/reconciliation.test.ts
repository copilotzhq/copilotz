import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { ownerClaimKey, ownerCompletionKey } from "../execution/owner-port.ts";
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
  type OwnerAssignmentBinding,
  ownerAssignmentKey,
  provisionOwnerAssignments,
} from "./assignments.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
} from "./boundary.ts";
import { createOwnerExecutionCommands } from "./execution.ts";
import { createOwnerEffectCommands } from "./effects.ts";
import { ownerEffectKey } from "./effects-client.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerReconciliation,
  OWNER_RECONCILIATION_CLASSIFY,
  OWNER_RECONCILIATION_INVENTORY,
  ownerReconciliationAlarm,
  type OwnerReconciliationClassification,
  type OwnerReconciliationCursor,
  ownerReconciliationKey,
  type OwnerReconciliationPage,
  type OwnerReconciliationTarget,
} from "./reconciliation.ts";

const start = "2020-01-01T00:00:00.000Z";
const host = (epoch: number): OwnerCaller => ({
  principal: {
    kind: "owner-control",
    ownerId: "owner",
    epoch,
    holderId: epoch === 1 ? "first" : epoch === 2 ? "second" : "third",
  },
  ownerEpoch: epoch,
  control: true,
});
async function fixture(
  options: {
    maxBatch?: number;
    maxAlarms?: number;
    publicationCapacity?: number;
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const registry = createPluginRegistry({
    actions: {
      work: defineAction({
        id: "work",
        inputSchema: { type: "string" } as const,
        outputSchema: { type: "string" } as const,
        execute: (value: string) => value,
      }),
    },
    processors: {
      observe: defineProcessor({
        id: "observe",
        on: [{ eventType: "requested" }],
        handle() {},
      }),
    },
  });
  const catalog = createOperationCatalog(db, "public");
  const state = {
    authorized: true,
    rollback: false,
    unknown: false,
    wakes: 0,
    wakeFailure: false,
    noncooperativeWake: false,
    mutateCaller: false,
    started: true,
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
        throw new Error("lost COMMIT acknowledgement");
      }
      return result;
    },
  };
  const control = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    isCurrentStarted: () => state.started,
    hasProcessor: (id) => id === "observe",
    authorizeControl(_tx, caller) {
      if (caller.control !== true) throw new Error("host only");
    },
  });
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "no-dispatch",
    workloads: {},
    scheduleDelivery() {},
    dispatchWork: () => Promise.reject(new Error("No recovery dispatch")),
    dispatchDelivery: () => Promise.reject(new Error("No recovery dispatch")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("No recovery dispatch")),
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
        ownerId: "owner",
        ...b,
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
    verifyNotStarted: () => false,
  });
  const reconciliationOptions: Parameters<typeof createOwnerReconciliation>[0] =
    {
      ownerId: "owner",
      schema: "public",
      registry,
      ...options,
      authorizeControl: (_tx, caller) => {
        const permitted = state.authorized && caller.control === true;
        if (state.mutateCaller) {
          Object.assign(caller, { ownerEpoch: 999 });
          Object.assign(caller.principal, { holderId: "mutated" });
        }
        return permitted;
      },
      wake() {
        state.wakes++;
        if (state.noncooperativeWake) return new Promise<never>(() => {});
        if (state.wakeFailure) throw new Error("bounded scheduling refused");
      },
    };
  const reconciliation = createOwnerReconciliation(reconciliationOptions);
  const errors: unknown[] = [];
  const create = (holderId: string) =>
    createOwnerCommandBoundary({
      session,
      ownerId: "owner",
      holderId,
      schema: "public",
      now: () => start,
      maxPostCommitGroups: options.publicationCapacity ?? 32,
      handlers: {
        ...control.handlers,
        ...execution.handlers,
        ...effects.handlers,
        ...reconciliation.handlers,
        async seed(input, ctx) {
          const data = input as {
            id: string;
            namespace: string;
            processor: boolean;
            malformed: boolean;
          };
          const result = await createEventStore({
            session,
            ownerCommit: ctx.ownerCommit,
            admitOperationEventSql: (value, param) =>
              catalog.admitEventSql(value, param),
            indexOperationEventSql: (value, param) =>
              catalog.indexEventSql(value, param),
            indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
          }).commitMutation({
            transaction: ctx.tx,
            draft: {
              type: "requested",
              namespace: data.namespace,
              payload: {
                dataRef: {
                  eventBodyId: `body:${data.id}`,
                  schemaVersion: 1,
                  mediaType: "application/json",
                },
              },
              metadata: data.processor || data.malformed
                ? {}
                : { actionId: "work", actionRunId: data.id },
              deduplicationId: data.id,
            },
            body: { id: `body:${data.id}`, json: "value" },
            consumers: [{
              consumerId: data.processor
                ? "processor:observe"
                : "registered:work",
              settlement: "inherit",
            }],
          });
          return {
            eventId: result.event.id,
            deliveryId: result.deliveries[0].id,
          };
        },
      },
      projections: {
        ...execution.projections,
        ...effects.projections,
        ...reconciliation.projections,
      },
      inputDefinitions: execution.inputDefinitions,
      async authorize(tx, caller, command, time, normalized) {
        if (command.kind === "seed") {
          if (caller.control !== true) throw new Error("host only");
        } else if (command.kind.startsWith("assignment.")) {
          await control.authorize(tx, caller, command, time);
        } else if (command.kind.startsWith("effect.")) {
          await effects.authorize(tx, caller, command, time);
        } else if (command.kind.startsWith("reconciliation.")) {
          await reconciliation.authorize(tx, caller, command, time);
        } else await execution.authorize(tx, caller, command, time, normalized);
      },
      authenticateReceipt() {
        throw new Error("No ambient recovery receipts");
      },
      onPostCommitError: (error) => errors.push(error),
    });
  const first = create("first");
  await first.acquire(0);
  async function seed(
    id: string,
    processor = false,
    namespace = "space",
    malformed = false,
  ) {
    const outcome = await first.execute(host(1), {
      kind: "seed",
      domain: "logical",
      key: `seed:${namespace}:${id}`,
      intent: { id, namespace, processor, malformed },
    });
    const ref = outcome.result as { eventId: string; deliveryId: string };
    const binding: OwnerAssignmentBinding = {
      placement: "worker",
      workerId: "worker",
      workerAttemptId: `worker:${id}`,
      sessionGeneration: 1,
      sessionId: `session:${id}`,
      parentOperationId: `operation:${id}`,
      assignmentId: `assignment:${id}`,
      dispatchAttemptId: `dispatch:${id}`,
      namespace,
      sourceEventId: ref.eventId,
      deliveryId: ref.deliveryId,
      ...(processor
        ? { kind: "processor" as const, processorId: "observe" }
        : { actionId: "work", executionId: id }),
    };
    const { workerId, ...callerBinding } = binding;
    const caller: OwnerCaller = {
      ...callerBinding,
      principal: { kind: "worker", workerId },
      ownerEpoch: 1,
    };
    const selected: OwnerReconciliationTarget = {
      kind: "delivery",
      namespace,
      id: ref.deliveryId,
    };
    return {
      ...ref,
      binding,
      caller,
      selected,
      bind: () =>
        first.execute(host(1), {
          kind: "assignment.bind",
          domain: "incarnation",
          key: `${ownerAssignmentKey("owner", binding)}:assignment.bind`,
          intent: binding,
        }),
      claim: () =>
        first.execute(caller, {
          kind: "execution.claim",
          domain: "incarnation",
          key: ownerClaimKey("owner", binding.assignmentId, binding.sessionId),
          intent: {
            assignmentId: binding.assignmentId,
            sessionId: binding.sessionId,
          },
        }),
      complete: () =>
        first.executeInput(caller, {
          kind: "execution.complete",
          domain: "logical",
          key: ownerCompletionKey("owner", namespace, id),
          input: {
            namespace,
            executionId: id,
            completion: { status: "completed", output: "done" },
          },
        }),
      begin: () =>
        first.execute(caller, {
          kind: "effect.begin",
          domain: "logical",
          key: ownerEffectKey("owner", {
            namespace,
            actionRunId: id,
            step: "send",
          }, "begin"),
          intent: { namespace, actionRunId: id, step: "send" },
        }),
    };
  }
  const second = create("second");
  const command = (
    selected: OwnerReconciliationTarget,
    epoch = 2,
  ): OwnerCommand => ({
    kind: OWNER_RECONCILIATION_CLASSIFY,
    domain: "occurrence",
    key: ownerReconciliationKey("owner", epoch, selected),
    intent: selected,
  });
  return {
    db,
    state,
    errors,
    reconciliationOptions,
    first,
    second,
    create,
    seed,
    command,
    takeover: () => second.acquire(1),
    classify: async (selected: OwnerReconciliationTarget) => {
      const result = (await second.execute(host(2), command(selected)))
        .result as OwnerReconciliationClassification;
      // Output release may precede bounded publication queue cleanup. This is
      // only a task turn for cleanup, never a retry of an unknown command.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return result;
    },
    page: async (cursor: OwnerReconciliationCursor | null = null) =>
      await second.project(host(2), OWNER_RECONCILIATION_INVENTORY, {
        cursor,
      }) as OwnerReconciliationPage,
    async close() {
      first.stop();
      second.stop();
      await db.close();
    },
  };
}

test("takeover inventory retires only exact old never-claimed reservations; unassigned pending work is ordinary", async () => {
  const f = await fixture({ publicationCapacity: 1 });
  try {
    const reserved = await f.seed("reserved");
    await reserved.bind();
    const pending = await f.seed("pending");
    Object.assign(f.reconciliationOptions, {
      ownerId: "mutated",
      schema: "absent",
      authorizeControl: () => false,
      wake: () => {
        throw new Error("replacement callback must not run");
      },
    });
    await f.takeover();
    f.state.noncooperativeWake = true;
    f.state.mutateCaller = true;
    assert.deepEqual(await f.classify(reserved.selected), {
      target: reserved.selected,
      disposition: "unscheduled",
      reason: "never_claimed",
      retired: 1,
    });
    assert.equal(
      (await f.classify(pending.selected)).disposition,
      "unscheduled",
    );
    const d = (await f.db.query(
      "SELECT status,attempts,max_attempts FROM event_deliveries ORDER BY id",
    )).rows;
    assert.ok(
      d.every((row) =>
        row.status === "pending" && row.attempts === 0 && row.max_attempts === 3
      ),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      2,
    );
    const blocker = (await f.page()).items.find((item) =>
      item.kind === "blocker"
    );
    assert.ok(blocker);
    assert.equal(
      (await f.classify(blocker)).reason,
      "retained_reconciliation_obligation",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      2,
    );
    const wakes = f.state.wakes;
    assert.equal(
      (await f.second.execute(host(2), f.command(reserved.selected))).status,
      "duplicate",
    );
    assert.equal(f.state.wakes, wakes);
    f.state.authorized = false;
    await assert.rejects(
      f.second.execute(host(2), f.command(reserved.selected)),
      /control refused/,
    );
    await assert.rejects(f.page(), /control refused/);
  } finally {
    await f.close();
  }
});

test("unexpired old Action lease and begun effect remain blocked without retry or attempt reset", async () => {
  const f = await fixture();
  try {
    const work = await f.seed("lost");
    await work.bind();
    await work.claim();
    await work.begin();
    const before =
      (await f.db.query("SELECT * FROM event_deliveries WHERE id=$1", [
        work.deliveryId,
      ])).rows;
    await f.takeover();
    assert.equal(
      (await f.classify(work.selected)).reason,
      "action_recovery_required",
    );
    assert.deepEqual(
      (await f.db.query("SELECT * FROM event_deliveries WHERE id=$1", [
        work.deliveryId,
      ])).rows,
      before,
    );
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      false,
    );
    const page = await f.page();
    assert.ok(page.items.some((item) => item.kind === "effect"));
    assert.ok(page.items.some((item) => item.kind === "action"));
    await f.db.query(
      "UPDATE open_actions SET owner_delivery_id='missing-delivery' WHERE action_run_id='lost'",
    );
    assert.equal(
      (await f.classify({ kind: "action", namespace: "space", id: "lost" }))
        .reason,
      "open_action_recovery_required",
    );
    await assert.rejects(work.complete(), /epoch|owner/i);
  } finally {
    await f.close();
  }
});

test("canonical committed Action terminal permits old reservation retirement; delivery status alone does not", async () => {
  const f = await fixture();
  try {
    const good = await f.seed("good");
    await good.bind();
    await good.claim();
    await good.complete();
    const incomplete = await f.seed("incomplete");
    await incomplete.bind();
    await f.db.query(
      "UPDATE event_deliveries SET status='succeeded',settled_at=$1 WHERE id=$2",
      [start, incomplete.deliveryId],
    );
    await f.takeover();
    assert.equal((await f.classify(good.selected)).disposition, "terminal");
    assert.equal(
      (await f.classify(incomplete.selected)).disposition,
      "blocked",
    );
    assert.deepEqual(
      (await f.db.query(
        "SELECT retired FROM owner_assignments ORDER BY assignment_key",
      )).rows.map((row) => row.retired),
      [true, false],
    );
  } finally {
    await f.close();
  }
});

test("orphan claimed work, lost Processor, and missing source metadata cannot disappear behind assignment joins", async () => {
  const f = await fixture();
  try {
    const orphan = await f.seed("orphan");
    const processor = await f.seed("processor", true);
    await processor.bind();
    const malformed = await f.seed("malformed", false, "space", true);
    await f.db.query(
      "UPDATE event_deliveries SET status='leased',attempts=1,lease_owner='old',lease_expires_at=$1 WHERE id=ANY($2::text[])",
      ["2020-01-02T00:00:00Z", [orphan.deliveryId, processor.deliveryId]],
    );
    await f.takeover();
    assert.equal(
      (await f.classify(orphan.selected)).reason,
      "claimed_without_binding",
    );
    assert.equal(
      (await f.classify(processor.selected)).reason,
      "processor_recovery_required",
    );
    assert.equal(
      (await f.classify(malformed.selected)).reason,
      "unsupported_consumer_or_source",
    );
    const page = await f.page();
    for (const ref of [orphan, processor, malformed]) {
      assert.ok(
        page.items.some((item) =>
          item.kind === "delivery" && item.id === ref.deliveryId
        ),
      );
    }
  } finally {
    await f.close();
  }
});

test("inventory cursor has exact epoch-bound suffix exhaustion and fresh independent reads see later obligations", async () => {
  const f = await fixture({ maxBatch: 1 });
  try {
    await f.seed("a");
    await f.seed("b");
    await f.takeover();
    const items: OwnerReconciliationTarget[] = [];
    let cursor: OwnerReconciliationCursor | null = null;
    do {
      const page = await f.page(cursor);
      items.push(...page.items);
      assert.equal(page.items.length, 1);
      assert.equal(page.exhausted, page.next === null);
      cursor = page.next;
    } while (cursor);
    assert.equal(items.length, 4);
    assert.equal(new Set(items.map((item) => JSON.stringify(item))).size, 4);
    const firstPage = await f.page();
    assert.ok(firstPage.next);
    await assert.rejects(
      f.page({ ...firstPage.next, epoch: 1 }),
      /another owner epoch/,
    );
    await assert.rejects(
      f.page({ ...firstPage.next, ownerId: "foreign" }),
      /another owner epoch/,
    );
    // Mutating state between pages invalidates any imagined snapshot proof.
    await f.db.query(
      "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner','later',$1)",
      [start],
    );
    const reread = await f.page();
    assert.equal(reread.items[0].kind, "alarm");
  } finally {
    await f.close();
  }
});

test("current epoch reservations are never retired and untrusted target coordinates do not create alarms", async () => {
  const f = await fixture();
  try {
    const work = await f.seed("current");
    await work.bind();
    const result = (await f.first.execute(host(1), f.command(work.selected, 1)))
      .result as OwnerReconciliationClassification;
    assert.equal(result.disposition, "current");
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      false,
    );
    await f.takeover();
    await assert.rejects(
      f.second.execute(
        {
          principal: { kind: "worker" as const, workerId: "worker" },
          ownerEpoch: 2,
        },
        f.command(work.selected),
      ),
      /control refused/,
    );
    assert.equal(
      (await f.classify({ ...work.selected, namespace: "other" })).disposition,
      "absent",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      1,
    );
    await f.db.query(
      "UPDATE owner_assignments SET epoch=3 WHERE delivery_id=$1",
      [work.deliveryId],
    );
    assert.equal(
      (await f.classify(work.selected)).reason,
      "future_epoch_binding",
    );
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      false,
    );
  } finally {
    await f.close();
  }
});

test("classification retirement, alarm, and receipt roll back together; unknown committed outcome stays discoverable", async () => {
  const f = await fixture();
  try {
    const a = await f.seed("rollback");
    await a.bind();
    const b = await f.seed("unknown");
    await b.bind();
    await f.takeover();
    f.state.rollback = true;
    await assert.rejects(f.classify(a.selected), /unknown|rollback/i);
    assert.equal(
      (await f.db.query(
        "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
        [a.deliveryId],
      )).rows[0].retired,
      false,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      0,
    );
    assert.equal(f.state.wakes, 0);
    const third = f.create("third");
    try {
      await third.acquire(2);
      f.state.unknown = true;
      await assert.rejects(
        third.execute(host(3), f.command(b.selected, 3)),
        /unknown/i,
      );
      assert.equal(third.state, "stopped");
      assert.equal(
        (await f.db.query(
          "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
          [b.deliveryId],
        )).rows[0].retired,
        true,
      );
      assert.equal(
        (await f.db.query("SELECT name FROM owner_alarms")).rows[0].name,
        ownerReconciliationAlarm("owner", b.selected),
      );
      assert.equal(f.state.wakes, 0);
    } finally {
      third.stop();
    }
  } finally {
    await f.close();
  }
});

test("bounded alarm refusal rolls back retirement and postcommit scheduling refusal retains durable discovery", async () => {
  const f = await fixture({ maxAlarms: 1 });
  try {
    const a = await f.seed("a");
    await a.bind();
    const b = await f.seed("b");
    await b.bind();
    await f.takeover();
    f.state.wakeFailure = true;
    await f.classify(a.selected);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.second.state, "acquired");
    assert.equal(f.errors.length, 1);
    await assert.rejects(f.classify(b.selected), /capacity.*incomplete/);
    assert.equal(
      (await f.db.query(
        "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
        [b.deliveryId],
      )).rows[0].retired,
      false,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM owner_alarms")).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("reconciliation requires tagged control even with permissive host policy", async () => {
  const f = await fixture();
  try {
    const reconciliation = createOwnerReconciliation({
      ...f.reconciliationOptions,
      authorizeControl: () => true,
    });
    await assert.rejects(
      reconciliation.authorize(f.db, {
        principal: { kind: "worker", workerId: "owner:owner" },
        ownerEpoch: 1,
      }, {
        kind: OWNER_RECONCILIATION_INVENTORY,
        domain: "occurrence",
        key: "read",
        intent: { cursor: null },
      }, start),
      { code: "owner_reconciliation_refused" },
    );
  } finally {
    await f.close();
  }
});

test("local placement history remains blocked and cannot hide changed target identity", async () => {
  const f = await fixture();
  try {
    const work = await f.seed("local-history");
    const changed = await f.seed("local-changed");
    for (
      const [item, run] of [[work, "local-history"], [
        changed,
        "different-run",
      ]] as const
    ) {
      await item.bind();
      const binding = {
        placement: "owner-local" as const,
        ownerId: "owner",
        epoch: 1,
        holderId: "first",
        attemptId: `local:${item.deliveryId}`,
        namespace: "space",
        sourceEventId: item.eventId,
        deliveryId: item.deliveryId,
        kind: "action" as const,
        actionId: "work",
        actionRunId: run,
      };
      await f.db.query(
        "UPDATE owner_assignments SET assignment_key=$1,binding=$2::jsonb WHERE delivery_id=$3",
        [
          ownerAssignmentKey("owner", binding),
          JSON.stringify(binding),
          item.deliveryId,
        ],
      );
    }
    await f.takeover();
    assert.equal(
      (await f.classify(work.selected)).reason,
      "local_recovery_required",
    );
    assert.equal(
      (await f.classify(changed.selected)).reason,
      "assignment_identity_mismatch",
    );
    assert.deepEqual(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows.map(
        (row) => row.retired,
      ),
      [false, false],
    );
  } finally {
    await f.close();
  }
});
