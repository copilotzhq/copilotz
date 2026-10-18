import {
  createTestOwnerCatalog,
  insertTestOwnerBody,
  insertTestOwnerStream,
} from "../testing/owner-catalog.ts";
import { provisionOwnerContentCatalog } from "../streams/owner-catalog-schema.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { encodeEventBody } from "../events/body-store.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { ownerClaimKey, ownerCompletionKey } from "../execution/owner-port.ts";
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
} from "./boundary.ts";
import { createOwnerExecutionCommands } from "./execution.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerOperationSettlement } from "./settlement.ts";
import { ownerReconciliationAlarm } from "./reconciliation.ts";
import {
  createOwnerStartupProof,
  OWNER_STARTUP_PROOF,
  OWNER_STARTUP_REPAIR,
  ownerStartupRepairKey,
} from "./startup.ts";

const start = "2020-01-01T00:00:00.000Z";
type Ref = {
  namespace: string;
  sourceEventId: string;
  deliveryId: string;
  runId: string;
};
async function fixture(
  options: { maxItems?: number; maxBytes?: number; detached?: boolean } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOwnerContentCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    time: start,
    control: true,
    rollback: false,
    unknown: false,
    mutate: false,
  };
  const session: SqlSession = {
    query: db.query,
    transaction: async (run) => {
      const result = await db.transaction(async (tx) => {
        const result = await run(tx);
        if (state.rollback) {
          state.rollback = false;
          throw new Error("injected rollback");
        }
        return result;
      });
      if (state.unknown) {
        state.unknown = false;
        throw new Error("lost COMMIT acknowledgement");
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
        execute: (value: string) => value,
      }),
    },
    processors: {
      observe: defineProcessor({
        id: "observe",
        on: [{ eventType: "note.created" }],
        settlement: options.detached ? "detached" : "inherit",
        handle() {},
      }),
    },
  });
  const catalog = createTestOwnerCatalog(session, "public");
  const assignments = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    hasProcessor: (id) => id === "observe",
    isCurrentStarted: () => true,
    authorizeControl(_tx, caller) {
      assert.equal(caller.principal.kind, "owner-control");
    },
  });
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "startup-fixture",
    workloads: {},
    scheduleDelivery() {},
    dispatchWork: () => Promise.reject(new Error("no business dispatch")),
    dispatchDelivery: () => Promise.reject(new Error("no business dispatch")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("no recovery dispatch")),
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session,
    catalog,
    authorizeControl: (_tx, caller) =>
      caller.principal.kind === "owner-control" && state.control,
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake() {},
  });
  const execution = createOwnerExecutionCommands({
    ownerId: "owner",
    schema: "public",
    session,
    registry,
    catalog,
    executor,
    scheduleSettlement: settlement.schedule,
    async resolveAssignment(tx, caller) {
      const binding = await assignments.resolveStarted(tx, caller);
      if (!binding || "kind" in binding) return undefined;
      return {
        ...binding,
        ownerId: "owner",
        ctxGranted: true,
        settlementGranted: true,
        invocation: {
          actionRunId: binding.executionId,
          operationKey: binding.executionId,
          rootKey: binding.executionId,
          metadata: {},
          identity: {
            causationId: binding.sourceEventId,
            settlementScopeId: binding.sourceEventId,
          },
        },
      };
    },
    authorizeInput() {},
  });
  const startupOptions = {
    ownerId: "owner",
    schema: "public",
    registry,
    ...options,
    authorizeControl(_tx: unknown, caller: OwnerCaller) {
      const result = caller.principal.kind === "owner-control" && state.control;
      if (state.mutate) {
        Object.assign(caller, { ownerEpoch: 999 });
        Object.assign(caller.principal, { holderId: "changed" });
      }
      return result;
    },
  };
  const startup = createOwnerStartupProof(startupOptions);
  const boundaries: ReturnType<typeof createOwnerCommandBoundary>[] = [];
  function create(epoch: number) {
    const result = createOwnerCommandBoundary({
      ownerId: "owner",
      holderId: `holder-${epoch}`,
      schema: "public",
      session,
      now: () => state.time,
      handlers: {
        ...assignments.handlers,
        ...execution.handlers,
        ...settlement.handlers,
        ...startup.handlers,
        async seed(input, ctx) {
          const data = input as {
            id: string;
            processor: boolean;
            large: number;
            deduplicationId: string;
            eventType: string;
            metadata: Record<string, unknown>;
            inline: boolean;
          };
          const event = await createEventStore({
            session,
            schema: "public",
            ownerCommit: ctx.ownerCommit,
            admitOperationEventSql: (value, param) =>
              catalog.admitEventSql(value, param),
            indexOperationEventSql: (value, param) =>
              catalog.indexEventSql(value, param),
            indexOperationEvent: (tx, event) => catalog.indexEvent(tx, event),
          }).commitMutation({
            transaction: ctx.tx,
            draft: {
              namespace: "space",
              type: data.processor
                ? data.eventType
                : "copilotz.owner.action.requested",
              deduplicationId: data.deduplicationId,
              metadata: data.processor ? {} : {
                actionId: "work",
                actionRunId: data.id,
                actionMetadata: {},
                ...data.metadata,
              },
              payload: data.inline ? {} : {
                dataRef: {
                  eventBodyId: `body:${data.id}`,
                  schemaVersion: 1,
                  mediaType: "application/json",
                },
              },
            },
            body: {
              id: `body:${data.id}`,
              json: data.large ? "x".repeat(data.large) : "value",
            },
            consumers: [{
              consumerId: data.processor
                ? "processor:observe"
                : "registered:work",
              settlement: data.processor && options.detached
                ? "detached"
                : "inherit",
            }],
          });
          return {
            namespace: "space",
            sourceEventId: event.event.id,
            deliveryId: event.deliveries[0].id,
            runId: data.id,
          };
        },
      },
      projections: {
        ...execution.projections,
        ...settlement.projections,
        ...startup.projections,
      },
      inputDefinitions: execution.inputDefinitions,
      async authorize(tx, caller, command, time, input) {
        if (command.kind === "seed") {
          assert.equal(caller.principal.kind, "owner-control");
          return;
        }
        if (command.kind.startsWith("assignment.")) {
          return await assignments.authorize(tx, caller, command, time);
        }
        if (command.kind.startsWith("startup.")) {
          return await startup
            .authorize(tx, caller, command, time);
        }
        if (command.kind.startsWith("operation.")) {
          return await settlement
            .authorize(tx, caller, command, time);
        }
        return await execution.authorize(tx, caller, command, time, input);
      },
      authenticateReceipt() {
        throw new Error("no ambient receipt authority");
      },
    });
    boundaries.push(result);
    return result;
  }
  const caller = (epoch: number): OwnerCaller => ({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch,
      holderId: `holder-${epoch}`,
    },
    ownerEpoch: epoch,
  });
  let epoch = 1;
  let current = create(epoch);
  await current.acquire(0);
  function binding(ref: Ref) {
    return {
      placement: "worker" as const,
      workerId: "worker",
      workerAttemptId: `worker:${ref.runId}`,
      sessionGeneration: 1,
      sessionId: `session:${ref.runId}`,
      parentOperationId: `parent:${ref.runId}`,
      assignmentId: `assignment:${ref.runId}`,
      dispatchAttemptId: `attempt:${ref.runId}`,
      namespace: ref.namespace,
      sourceEventId: ref.sourceEventId,
      deliveryId: ref.deliveryId,
      actionId: "work",
      executionId: ref.runId,
    };
  }
  function command(occurrence: string): OwnerCommand {
    return {
      kind: OWNER_STARTUP_REPAIR,
      domain: "occurrence",
      key: ownerStartupRepairKey("owner", epoch, occurrence),
      intent: { occurrence },
    };
  }
  return {
    db,
    state,
    startupOptions,
    registry,
    binding,
    command,
    get current() {
      return current;
    },
    get caller() {
      return caller(epoch);
    },
    async seed(
      id = "run",
      processor = false,
      large = 0,
      extra: {
        deduplicationId?: string;
        eventType?: string;
        metadata?: {
          rootKey?: number;
          parentActionRunId?: number;
          actionMetadata?: [];
          preparation?: null;
        };
        inline?: boolean;
      } = {},
    ) {
      return (await current.execute(caller(epoch), {
        kind: "seed",
        domain: "logical",
        key: `seed:${id}`,
        intent: {
          id,
          processor,
          large,
          deduplicationId: extra.deduplicationId ?? id,
          eventType: extra.eventType ?? "note.created",
          metadata: extra.metadata ?? {},
          inline: extra.inline ?? false,
        },
      })).result as Ref;
    },
    async bind(ref: Ref) {
      const value = binding(ref);
      return await current.execute(caller(epoch), {
        kind: "assignment.bind",
        domain: "incarnation",
        key: `${ownerAssignmentKey("owner", value)}:assignment.bind`,
        intent: value,
      });
    },
    async claim(ref: Ref, complete = false) {
      const b = binding(ref);
      await this.bind(ref);
      const worker: OwnerCaller = {
        principal: { kind: "worker", workerId: b.workerId },
        ownerEpoch: epoch,
        assignmentId: b.assignmentId,
        sessionId: b.sessionId,
        dispatchAttemptId: b.dispatchAttemptId,
        workerAttemptId: b.workerAttemptId,
        sessionGeneration: b.sessionGeneration,
        parentOperationId: b.parentOperationId,
      };
      await current.execute(worker, {
        kind: "execution.claim",
        domain: "incarnation",
        key: ownerClaimKey("owner", b.assignmentId, b.sessionId),
        intent: { assignmentId: b.assignmentId, sessionId: b.sessionId },
      });
      if (complete) {
        await current.executeInput(worker, {
          kind: "execution.complete",
          domain: "logical",
          key: ownerCompletionKey("owner", ref.namespace, ref.runId),
          input: {
            namespace: ref.namespace,
            executionId: ref.runId,
            completion: { status: "completed", output: "value" },
          },
        });
      }
    },
    async takeover() {
      const next = create(epoch + 1);
      await next.acquire(epoch);
      epoch++;
      current = next;
      state.time = new Date(Date.parse(state.time) + 100).toISOString();
    },
    repair: (occurrence = "first") =>
      current.execute(caller(epoch), command(occurrence)),
    proof: () => current.project(caller(epoch), OWNER_STARTUP_PROOF, null),
    settle: (target: { namespace: string; operationId: string }) =>
      settlement.run({
        boundary: current,
        caller: caller(epoch),
        target,
        occurrence: crypto.randomUUID(),
      }),
    async close() {
      for (const boundary of boundaries) boundary.stop();
      await db.close();
    },
  };
}

test("startup restores exact pending Action and Processor alarms, and receipt replay cannot skip today's repairs", async () => {
  const f = await fixture();
  try {
    const action = await f.seed("action"),
      processor = await f.seed("processor", true);
    await f.takeover();
    await assert.rejects(f.proof(), /coverage|unresolved/);
    f.state.mutate = true;
    f.startupOptions.ownerId = "changed";
    f.startupOptions.schema = "changed";
    f.startupOptions.authorizeControl = () => false;
    const repaired = (await f.repair()).result as {
      blockers: unknown[];
      settlements: unknown[];
    };
    assert.deepEqual(repaired.blockers, []);
    assert.deepEqual(repaired.settlements, []);
    assert.equal((await f.proof() as { epoch: number }).epoch, 2);
    for (const ref of [action, processor]) {
      const rows = await f.db.query<{ due_at: Date; available_at: Date }>(
        `SELECT a.due_at,d.available_at FROM owner_alarms a JOIN event_deliveries d ON d.id=$1 WHERE a.name=$2`,
        [
          ref.deliveryId,
          JSON.stringify(["host.delivery", ref.namespace, ref.deliveryId]),
        ],
      );
      assert.equal(
        new Date(rows.rows[0].due_at).toISOString(),
        new Date(rows.rows[0].available_at).toISOString(),
      );
    }
    assert.equal((await f.repair()).status, "duplicate");
    await f.db.query("DELETE FROM owner_alarms WHERE name=$1", [
      JSON.stringify(["host.delivery", "space", action.deliveryId]),
    ]);
    await assert.rejects(f.repair(), /historical startup receipt/);
    await assert.rejects(f.proof(), /coverage|unresolved/);
    await f.repair("restore");
    await f.proof();
    f.state.control = false;
    await assert.rejects(f.proof(), /refused/);
  } finally {
    await f.close();
  }
});

test("startup retires only proven prior never-started reservations and refuses current/future evidence", async () => {
  for (const kind of ["prior", "current", "future"] as const) {
    const f = await fixture();
    try {
      const ref = await f.seed();
      await f.bind(ref);
      await f.takeover();
      if (kind !== "prior") {
        await f.db.query("UPDATE owner_assignments SET epoch=$1", [
          kind === "current" ? 2 : 3,
        ]);
      }
      const result = (await f.repair()).result as { blockers: unknown[] };
      const row = (await f.db.query<{ retired: boolean }>(
        "SELECT retired FROM owner_assignments",
      )).rows[0];
      if (kind === "prior") {
        assert.deepEqual(result.blockers, []);
        assert.equal(row.retired, true);
        await f.proof();
      } else {
        assert.ok(result.blockers.length);
        assert.equal(row.retired, false);
        await assert.rejects(f.proof(), /unresolved/);
      }
      assert.equal(
        (await f.db.query<{ attempts: number }>(
          "SELECT attempts FROM event_deliveries",
        )).rows[0].attempts,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("startup accepts genuine canonical completed Action history only after actual scope settlement and alarm repair", async () => {
  const f = await fixture();
  try {
    const ref = await f.seed();
    await f.claim(ref, true);
    await f.takeover();
    const result = (await f.repair()).result as {
      blockers: unknown[];
      settlements: { namespace: string; operationId: string }[];
    };
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.settlements, [{
      namespace: "space",
      operationId: ref.sourceEventId,
    }]);
    await assert.rejects(f.proof(), /unresolved/);
    await f.settle(result.settlements[0]);
    await f.repair("settled");
    await f.proof();
    assert.equal(
      (await f.db.query<{ state: string }>(
        "SELECT state FROM copilotz_operations",
      )).rows[0].state,
      "completed",
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("startup keeps claimed, orphan, foreign and unsupported alarm evidence as durable blockers", async () => {
  for (
    const kind of [
      "claimed",
      "orphan",
      "foreign",
      "unknown-alarm",
      "array-kind",
    ] as const
  ) {
    const f = await fixture();
    try {
      const ref = await f.seed();
      if (kind === "claimed" || kind === "orphan") await f.claim(ref);
      if (kind === "orphan") await f.db.query("DELETE FROM owner_assignments");
      if (kind === "foreign") {
        // Corruption evidence must stay visible outside owner-filtered joins.
        await f.db.query(
          `INSERT INTO events(id,schema_version,type,namespace,payload,metadata,correlation_id,owner_id,seq)
          VALUES('foreign-event',7,'note.created','foreign-space','{}'::jsonb,'{}'::jsonb,'foreign','other',1)`,
        );
      }
      if (kind === "unknown-alarm" || kind === "array-kind") {
        await f.db.query(
          "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,$2)",
          [
            kind === "unknown-alarm" ? "unknown-alarm" : JSON.stringify([
              "reconciliation",
              "owner",
              ["delivery"],
              "space",
              ref.deliveryId,
            ]),
            start,
          ],
        );
      }
      await f.takeover();
      const result = (await f.repair()).result as {
        blockers: { reason: string }[];
      };
      assert.ok(result.blockers.length);
      if (kind === "array-kind") {
        assert.ok(
          result.blockers.some((row) => row.reason === "unknown_alarm"),
        );
      }
      await assert.rejects(f.proof(), /unresolved/);
      assert.ok(
        (await f.db.query(
          "SELECT 1 FROM owner_alarms WHERE left(name,18)='[\"reconciliation\",'",
        )).rows.length,
      );
    } finally {
      await f.close();
    }
  }
});

test("startup preserves contradictory terminal, dangling Action and leased Processor evidence", async () => {
  for (
    const kind of [
      "terminal-without-history",
      "dangling-action",
      "leased-processor",
    ] as const
  ) {
    const f = await fixture();
    try {
      const ref = await f.seed("unresolved", kind === "leased-processor");
      if (kind === "leased-processor") {
        const { actionId: _actionId, executionId: _executionId, ...base } = f
          .binding(ref);
        const binding = {
          ...base,
          kind: "processor" as const,
          processorId: "observe",
        };
        await f.current.execute(f.caller, {
          kind: "assignment.bind",
          domain: "incarnation",
          key: `${ownerAssignmentKey("owner", binding)}:assignment.bind`,
          intent: binding,
        });
        await f.db.query(
          "UPDATE event_deliveries SET status='leased',attempts=1,lease_owner='old',lease_expires_at=$1 WHERE id=$2",
          ["2020-01-02T00:00:00Z", ref.deliveryId],
        );
      } else if (kind === "dangling-action") {
        await f.claim(ref);
        await f.db.query(
          "UPDATE open_actions SET owner_delivery_id='missing-delivery' WHERE action_run_id=$1",
          [ref.runId],
        );
      } else {
        await f.bind(ref);
        await f.db.query(
          "UPDATE event_deliveries SET status='succeeded',settled_at=$1 WHERE id=$2",
          [start, ref.deliveryId],
        );
      }
      const before =
        (await f.db.query("SELECT * FROM event_deliveries WHERE id=$1", [
          ref.deliveryId,
        ])).rows;
      await f.takeover();
      const result = (await f.repair()).result as {
        blockers: {
          kind: string;
          namespace: string | null;
          id: string;
          reason: string;
        }[];
      };
      assert.ok(result.blockers.length, kind);
      if (kind === "dangling-action") {
        assert.ok(
          result.blockers.some((row) =>
            row.kind === "action" && row.id === ref.runId &&
            row.namespace === ref.namespace &&
            row.reason === "open_action_recovery_required"
          ),
        );
      }
      await assert.rejects(f.proof(), /unresolved/);
      assert.deepEqual(
        (await f.db.query("SELECT * FROM event_deliveries WHERE id=$1", [
          ref.deliveryId,
        ])).rows,
        before,
      );
      assert.equal(
        (await f.db.query<{ retired: boolean }>(
          "SELECT retired FROM owner_assignments",
        )).rows[0].retired,
        false,
      );
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_alarms WHERE name=$1", [
          JSON.stringify(["host.delivery", ref.namespace, ref.deliveryId]),
        ])).rows.length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("startup alarm growth beyond capacity rolls back without a repair receipt", async () => {
  const f = await fixture({ maxItems: 1 });
  try {
    await f.db.query(
      "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner','unknown-alarm',$1)",
      [start],
    );
    const before = (await f.db.query("SELECT * FROM owner_alarms")).rows;
    await f.takeover();
    const receiptCount =
      (await f.db.query("SELECT * FROM owner_receipts")).rows;
    await assert.rejects(f.repair(), /Startup alarm capacity exceeded/);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM owner_alarms")).rows,
      before,
    );
    assert.deepEqual(
      (await f.db.query("SELECT * FROM owner_receipts")).rows,
      receiptCount,
    );
    await assert.rejects(f.proof(), /Startup alarm capacity exceeded/);
  } finally {
    await f.close();
  }
});

test("startup refuses incomplete row/aggregate-byte inventory and missing schema without provisioning", async () => {
  for (const kind of ["rows", "bytes", "schema"] as const) {
    const f = await fixture({
      maxItems: kind === "rows" ? 2 : undefined,
      maxBytes: kind === "bytes" ? 4096 : undefined,
    });
    try {
      await f.seed("large", false, kind === "bytes" ? 2048 : 0);
      await f.takeover();
      if (kind === "schema") {
        await f.db.query("DROP TABLE copilotz_operation_streams");
      }
      await assert.rejects(
        f.repair(),
        kind === "schema"
          ? /catalog|schema|relation|exist|column/i
          : /budget|incomplete/,
      );
      if (kind === "schema") {
        assert.equal(
          (await f.db.query<{ table_name: string | null }>(
            "SELECT to_regclass('public.copilotz_operation_streams') AS table_name",
          )).rows[0].table_name,
          null,
        );
      }
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("startup refuses graph and content storage even without event obligations", async () => {
  for (
    const kind of [
      "asset",
      "protected",
      "edge",
      "content",
      "orphan-body",
    ] as const
  ) {
    const f = await fixture();
    try {
      if (kind === "content") {
        const bodies = createDatabaseBodyStore({
          session: f.db,
          schema: "public",
        });
        await bodies.head({ bodyId: "absent" });
      } else if (kind === "orphan-body") {
        // Retained unsupported body evidence without an event reference.
        const value = await encodeEventBody({
          schema: "copilotz.action.lifecycle.protected.v1",
        });
        await f.db.query(
          "INSERT INTO event_bodies(namespace,event_body_id,schema_version,body,digest) VALUES('space','orphan',1,$1::jsonb,$2)",
          [value.body, value.digest],
        );
      } else {
        await f.db.query(
          "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,'space',$2,'retained',$3::jsonb)",
          [
            "node",
            kind === "asset" ? "asset" : "ordinary",
            JSON.stringify(
              kind === "asset"
                ? { state: "open", bodyId: "body" }
                : kind === "protected"
                ? { schema: "copilotz.action.lifecycle.protected.v1" }
                : {},
            ),
          ],
        );
        if (kind === "edge") {
          await f.db.query(
            "INSERT INTO edges(id,namespace,source_node_id,target_node_id,type) VALUES('edge','space','node','node','ordinary')",
          );
        }
      }
      await f.takeover();
      if (kind === "content") {
        await assert.rejects(f.repair(), {
          code: "owner_content_catalog_schema_incompatible",
        });
        await assert.rejects(f.proof(), {
          code: "owner_content_catalog_schema_incompatible",
        });
        assert.equal(
          (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
          0,
        );
        continue;
      }
      const result = (await f.repair()).result as {
        blockers: { reason: string; id: string }[];
      };
      assert.ok(result.blockers.some((blocker) =>
        blocker.reason ===
          (kind === "orphan-body"
            ? "event_body_unsupported"
            : "graph_recovery_unsupported")
      ));
      if (kind === "edge") {
        assert.ok(
          result.blockers.some((blocker) => blocker.id === "startup.edges"),
        );
      }
      assert.equal((await f.db.query("SELECT 1 FROM events")).rows.length, 0);
      await assert.rejects(f.proof(), /unresolved/);
    } finally {
      await f.close();
    }
  }
});

test("startup rejects protected/content protocol-family markers before claiming ordinary bodies", async () => {
  const f = await fixture();
  try {
    const markers = [
      { nested: { schema: "copilotz.action.lifecycle.protected.v99" } },
      { nested: { schema: [["copilotz.action.protected-value.v99"]] } },
      { nested: { assetId: null } },
      { nested: { bodyId: 123 } },
      { nested: { ownerNodeId: {} } },
      { nested: { "$copilotz-secret": false } },
      { nested: { "x-copilotz-secret": false } },
      { nested: { "$copilotz-protected": false } },
      { nested: { location: null } },
    ];
    for (const [index, marker] of markers.entries()) {
      const body = await encodeEventBody(marker);
      await f.db.query(
        "INSERT INTO event_bodies(namespace,event_body_id,schema_version,body,digest) VALUES('space',$1,1,$2::jsonb,$3)",
        [`marker-${index}`, body.body, body.digest],
      );
    }
    await f.takeover();
    const result = (await f.repair()).result as {
      blockers: { reason: string }[];
    };
    assert.equal(
      result.blockers.filter((item) => item.reason === "event_body_unsupported")
        .length,
      markers.length,
    );
    await assert.rejects(f.proof(), /unresolved/);
  } finally {
    await f.close();
  }
});

test("startup requires exact Action request identity, event scope association and current Processor subscription", async () => {
  for (
    const kind of [
      "dedup",
      "scope",
      "subscription",
      "rootKey",
      "parentActionRunId",
      "actionMetadata",
      "preparation",
      "payload",
    ] as const
  ) {
    const f = await fixture();
    try {
      const ref = await f.seed(
        "run",
        kind === "subscription",
        0,
        kind === "dedup"
          ? { deduplicationId: "different" }
          : kind === "subscription"
          ? { eventType: "not.subscribed" }
          : kind === "rootKey" || kind === "parentActionRunId"
          ? { metadata: { [kind]: 123 } }
          : kind === "actionMetadata"
          ? { metadata: { actionMetadata: [] } }
          : kind === "preparation"
          ? { metadata: { preparation: null } }
          : kind === "payload"
          ? { inline: true }
          : {},
      );
      if (kind === "scope") {
        const other = await f.seed("other");
        // Deliberately redirect a durable index to another valid owned scope.
        await f.db.query(
          "UPDATE copilotz_operation_events SET operation_id=$1,event_ordinal=2 WHERE event_id=$2",
          [other.sourceEventId, ref.sourceEventId],
        );
        await f.db.query(
          "UPDATE copilotz_operations SET next_event_ordinal=3 WHERE namespace='space' AND operation_id=$1",
          [other.sourceEventId],
        );
      }
      await f.takeover();
      const result = (await f.repair()).result as {
        blockers: { reason: string; id: string }[];
      };
      assert.ok(result.blockers.some((blocker) =>
        blocker.reason ===
          (kind === "dedup"
            ? "consumer_or_action_unsupported"
            : kind === "scope"
            ? "delivery_scope_association_invalid"
            : kind === "subscription"
            ? "processor_subscription_or_scope_changed"
            : kind === "preparation"
            ? "prepared_history_incompatible"
            : "action_invocation_or_input_unsupported")
      ));
      if (kind === "preparation") {
        assert.ok(
          result.blockers.some((blocker) =>
            blocker.reason === "prepared_history_incompatible" &&
            blocker.id === "startup.prepared"
          ),
        );
      }
      await assert.rejects(f.proof(), /unresolved/);
    } finally {
      await f.close();
    }
  }
});

test("startup refuses inherited deferred Action-scope selectors in ordinary histories", async () => {
  const f = await fixture();
  try {
    await f.seed("action");
    await f.seed("processor", true);
    // Deliberately corrupt the deferred-group coordinate, without changing the
    // valid settlement scope. Neither row has a matching deferred lifecycle.
    await f.db.query("UPDATE event_deliveries SET action_scope_id='other-run'");
    await f.takeover();
    const result = (await f.repair()).result as {
      blockers: { reason: string }[];
    };
    assert.equal(
      result.blockers.filter((item) =>
        item.reason === "action_scope_recovery_unsupported"
      ).length,
      2,
    );
    await assert.rejects(f.proof(), /unresolved/);
  } finally {
    await f.close();
  }
});

test("startup preserves genuine detached Processor scope instead of requiring the source's public index", async () => {
  const f = await fixture({ detached: true });
  try {
    const ref = await f.seed("detached", true);
    await f.takeover();
    const repaired = (await f.repair()).result as {
      blockers: unknown[];
      settlements: { namespace: string; operationId: string }[];
    };
    assert.deepEqual(repaired.blockers, []);
    assert.deepEqual(repaired.settlements, [{
      namespace: "space",
      operationId: ref.sourceEventId,
    }]);
    await f.settle(repaired.settlements[0]);
    await f.repair("public-settled");
    await f.proof();
    const delivery =
      (await f.db.query<{ settlement_scope_id: string; attempts: number }>(
        "SELECT settlement_scope_id,attempts FROM event_deliveries WHERE id=$1",
        [ref.deliveryId],
      )).rows[0];
    assert.equal(
      delivery.settlement_scope_id,
      `detached:${ref.sourceEventId}:processor:observe`,
    );
    assert.equal(delivery.attempts, 0);
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms WHERE name=$1", [
        JSON.stringify(["host.delivery", "space", ref.deliveryId]),
      ])).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("startup repairs are atomic, unknown COMMIT stops the instance, and proof always rereads current rows", async () => {
  for (const unknown of [false, true]) {
    const f = await fixture();
    try {
      const ref = await f.seed();
      await f.takeover();
      f.state[unknown ? "unknown" : "rollback"] = true;
      await assert.rejects(f.repair(), /unknown|COMMIT|rollback/i);
      assert.equal(f.current.state, "stopped");
      const alarms = await f.db.query("SELECT name FROM owner_alarms");
      assert.equal(alarms.rows.length, unknown ? 2 : 0);
      await f.takeover();
      await f.repair("new-epoch");
      await f.proof();
      // Deliberately injected corruption after a successful proof. A receipt
      // cannot hide the newly unresolved delivery, even with alarm coverage.
      await f.db.query(
        "UPDATE event_deliveries SET status='retry_wait',attempts=1 WHERE id=$1",
        [ref.deliveryId],
      );
      await assert.rejects(f.proof(), /unresolved/);
      const result = (await f.repair("block")).result as {
        blockers: unknown[];
      };
      assert.ok(result.blockers.length);
      const alarm = ownerReconciliationAlarm("owner", {
        kind: "delivery",
        namespace: "space",
        id: ref.deliveryId,
      });
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_alarms WHERE name=$1", [alarm]))
          .rows.length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("startup persists blockers for hidden active and revoked owner streams", async () => {
  for (const revocation of ["active", "revoked"] as const) {
    const f = await fixture();
    try {
      const ref = await f.seed();
      await insertTestOwnerStream(f.db, {
        namespace: ref.namespace,
        operationId: ref.sourceEventId,
      }, { revocation });
      const before =
        (await f.db.query("SELECT * FROM copilotz_operation_streams")).rows;
      await f.takeover();
      const result = (await f.repair()).result as {
        blockers: { kind: string; reason: string }[];
      };
      assert.ok(
        result.blockers.some((row) =>
          row.kind === "stream" && row.reason === "stream_recovery_unsupported"
        ),
      );
      await assert.rejects(f.proof(), /unresolved/);
      assert.deepEqual(
        (await f.db.query("SELECT * FROM copilotz_operation_streams")).rows,
        before,
      );
      assert.ok(
        (await f.db.query("SELECT 1 FROM owner_alarms WHERE name=$1", [
          ownerReconciliationAlarm("owner", {
            kind: "stream",
            namespace: ref.namespace,
            id: "unsupported-stream",
          }),
        ])).rows.length,
      );
    } finally {
      await f.close();
    }
  }
});

test("startup clears physical-storage blocker alarms after shared schema proof establishes absence", async () => {
  const f = await fixture();
  try {
    for (const name of ["content_bodies", "content_body_parts"]) {
      await f.db.query(
        "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,$2)",
        [
          ownerReconciliationAlarm("owner", {
            kind: "blocker",
            namespace: null,
            id: `startup.${name}`,
          }),
          start,
        ],
      );
    }
    await f.takeover();
    await f.repair();
    await f.proof();
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("startup does not ignore logical bodies after producer metadata is pruned", async () => {
  const f = await fixture();
  try {
    await insertTestOwnerBody(f.db, {
      namespace: "tenant",
      operationId: "pruned-producer",
    });
    const before =
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows;
    await f.takeover();
    const result = (await f.repair()).result as {
      blockers: { kind: string; reason: string }[];
    };
    assert.ok(
      result.blockers.some((row) =>
        row.kind === "blocker" &&
        row.reason === "logical_body_recovery_unsupported"
      ),
    );
    await assert.rejects(f.proof(), /unresolved/);
    assert.deepEqual(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      before,
    );
  } finally {
    await f.close();
  }
});
