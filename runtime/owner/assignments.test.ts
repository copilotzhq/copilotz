import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerAssignmentControl,
  type OwnerAssignmentBinding,
  ownerAssignmentKey,
  provisionOwnerAssignments,
  validateOwnerAssignments,
} from "./assignments.ts";

async function fixture(processor = false) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = { started: false, control: true, rollback: false };
  const control = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    maxActive: 1,
    authorizeControl(_tx, who) {
      if (!state.control || who.host !== true) {
        throw new Error("control refused");
      }
    },
    isCurrentStarted: () => state.started,
    hasProcessor: (id) => id === "observe",
  });
  const host = (epoch = 1): OwnerCaller => ({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch,
      holderId: epoch === 1 ? "first" : "second",
    },
    ownerEpoch: epoch,
    host: true,
  });
  const create = (holder: string) =>
    createOwnerCommandBoundary({
      session: {
        query: db.query,
        transaction: (run) =>
          db.transaction(async (tx) => {
            const result = await run(tx);
            if (state.rollback) {
              state.rollback = false;
              throw new Error("unknown outer outcome");
            }
            return result;
          }),
      },
      schema: "public",
      ownerId: "owner",
      holderId: holder,
      handlers: {
        ...control.handlers,
        async seed(_input, ctx) {
          const result = await createEventStore({
            session: db,
            ownerCommit: ctx.ownerCommit,
          }).commitMutation({
            transaction: ctx.tx,
            draft: {
              type: "requested",
              namespace: "space",
              payload: {},
              metadata: processor
                ? {}
                : { actionId: "work", actionRunId: "run" },
              deduplicationId: "seed",
            },
            consumers: [{
              consumerId: processor ? "processor:observe" : "registered:work",
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
        async binding(_input, ctx) {
          return await control.resolveStarted(ctx.tx, ctx.caller) ?? null;
        },
      },
      async authorize(tx, who, command, time) {
        if (command.kind.startsWith("assignment.")) {
          await control.authorize(tx, who, command, time);
        } else if (command.kind === "seed" && who.host !== true) {
          throw new Error("host only");
        }
      },
      authenticateReceipt() {},
    });
  const owner = create("first");
  await owner.acquire(0);
  const seeded = await owner.execute(host(), {
    kind: "seed",
    domain: "logical",
    key: "seed",
    intent: null,
  });
  const refs = seeded.result as { eventId: string; deliveryId: string };
  const value: OwnerAssignmentBinding = {
    workerId: "worker",
    workerAttemptId: "worker-attempt",
    sessionGeneration: 1,
    sessionId: "connection",
    parentOperationId: "operation",
    assignmentId: "stream",
    dispatchAttemptId: "dispatch",
    namespace: "space",
    ...(processor
      ? { kind: "processor" as const, processorId: "observe" }
      : { actionId: "work", executionId: "run" }),
    sourceEventId: refs.eventId,
    deliveryId: refs.deliveryId,
  };
  const command = (
    kind = "assignment.bind",
    binding: OwnerAssignmentBinding = value,
  ): OwnerCommand => ({
    kind,
    domain: "incarnation",
    key: `${ownerAssignmentKey("owner", binding)}:${kind}`,
    intent: binding,
  });
  const { workerId, ...callerBinding } = value;
  const caller = (extra: Partial<OwnerCaller> = {}): OwnerCaller => ({
    ...callerBinding,
    principal: { kind: "worker", workerId },
    ownerEpoch: 1,
    ...extra,
  });
  return { db, owner, create, control, state, value, host, command, caller };
}

test("assignment reservation replay is safe and cannot grant execution before current Started", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.owner.execute(f.host(), f.command())).status,
      "committed",
    );
    assert.equal(
      (await f.owner.execute(f.host(), f.command())).status,
      "duplicate",
    );
    assert.equal(await f.owner.project(f.caller(), "binding", null), null);
    f.state.started = true;
    assert.deepEqual(
      await f.owner.project(f.caller(), "binding", null),
      f.value,
    );
    f.state.control = false;
    await assert.rejects(
      f.owner.execute(f.host(), f.command()),
      /control refused/,
    );
    f.state.started = false;
    assert.equal(await f.owner.project(f.caller(), "binding", null), null);
    assert.equal(
      (await f.db.query("SELECT COUNT(*) AS count FROM owner_assignments"))
        .rows[0].count,
      1,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment refuses competing live reservation and mismatched source facts", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.owner.execute(
        f.host(),
        f.command("assignment.bind", { ...f.value, namespace: "foreign" }),
      ),
      /not eligible/,
    );
    await f.owner.execute(f.host(), f.command());
    await assert.rejects(
      f.owner.execute(
        f.host(),
        f.command("assignment.bind", { ...f.value, assignmentId: "other" }),
      ),
      /capacity|unique/i,
    );
    await assert.rejects(
      f.owner.execute(f.host(), { ...f.command(), domain: "logical" }),
      /identity/,
    );
    const delivery =
      (await f.db.query("SELECT status,attempts FROM event_deliveries"))
        .rows[0];
    assert.deepEqual(delivery, { status: "pending", attempts: 0 });
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment resolver compares exact worker provisioning session and parent fences", async () => {
  const f = await fixture();
  try {
    await f.owner.execute(f.host(), f.command());
    f.state.started = true;
    assert.equal(
      await f.control.resolveStarted(f.db, {
        ...f.caller(),
        workerId: "legacy",
      }),
      undefined,
    );
    for (
      const change of [
        { principal: { kind: "worker" as const, workerId: "other" } },
        { workerAttemptId: "new" },
        { sessionGeneration: 2 },
        { sessionId: "new" },
        { parentOperationId: "other" },
        { assignmentId: "other" },
      ]
    ) {
      assert.equal(
        await f.owner.project(f.caller(change), "binding", null),
        null,
      );
    }
    await assert.rejects(
      f.owner.project(f.caller({ ownerEpoch: 0 }), "binding", null),
      { code: "ActionOwnershipLost" },
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("bind committed without Open can retire without claiming delivery or erasing receipt readers", async () => {
  const f = await fixture();
  try {
    await f.owner.execute(f.host(), f.command());
    const readers =
      (await f.db.query("SELECT * FROM owner_receipt_readers ORDER BY key"))
        .rows;
    await f.owner.execute(f.host(), f.command("assignment.retire"));
    f.state.started = true;
    assert.equal(await f.owner.project(f.caller(), "binding", null), null);
    assert.deepEqual(
      (await f.db.query(
        "SELECT status,attempts,lease_owner FROM event_deliveries",
      )).rows,
      [{ status: "pending", attempts: 0, lease_owner: null }],
    );
    for (const row of readers) {
      assert.ok(
        (await f.db.query("SELECT * FROM owner_receipt_readers WHERE key=$1", [
          row.key,
        ])).rows.length,
      );
    }
    const replacement = {
      ...f.value,
      assignmentId: "new",
      dispatchAttemptId: "new-dispatch",
    };
    await f.owner.execute(f.host(), f.command("assignment.bind", replacement));
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("successor can retire an old-epoch reservation but cannot use it for execution", async () => {
  const f = await fixture();
  let successor: ReturnType<typeof f.create> | undefined;
  try {
    await f.owner.execute(f.host(), f.command());
    f.owner.stop();
    successor = f.create("second");
    await successor.acquire(1);
    f.state.started = true;
    assert.equal(
      await successor.project(f.caller({ ownerEpoch: 2 }), "binding", null),
      null,
    );
    await successor.execute(f.host(2), f.command("assignment.retire"));
    await successor.execute(
      f.host(2),
      f.command("assignment.bind", { ...f.value, assignmentId: "replacement" }),
    );
  } finally {
    f.owner.stop();
    successor?.stop();
    await f.db.close();
  }
});

test("assignment and receipt rollback together on unknown outer result", async () => {
  const f = await fixture();
  try {
    f.state.rollback = true;
    await assert.rejects(f.owner.execute(f.host(), f.command()), {
      code: "owner_commit_unknown",
    });
    assert.equal(f.owner.state, "stopped");
    assert.deepEqual(
      (await f.db.query("SELECT * FROM owner_assignments")).rows,
      [],
    );
    assert.deepEqual(
      (await f.db.query(
        "SELECT * FROM owner_receipts WHERE kind='assignment.bind'",
      )).rows,
      [],
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment schema validation refuses an incompatible uniqueness shape", async () => {
  const f = await fixture();
  try {
    await validateOwnerAssignments(f.db, "public");
    await f.db.query("DROP INDEX owner_assignments_live_delivery_idx");
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await assert.rejects(
      provisionOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment schema validates foreign ownership references without repairing them", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "ALTER TABLE owner_assignments DROP CONSTRAINT owner_assignments_delivery_id_fkey",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await assert.rejects(
      provisionOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment resolver rechecks Started after delayed SQL and isolates callback identity", async () => {
  const f = await fixture();
  try {
    await f.owner.execute(f.host(), f.command());
    f.state.started = true;
    const resolved = await f.control.resolveStarted({
      async query<TRow extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) {
        const result = await f.db.query<TRow>(sql, params);
        f.state.started = false;
        return result;
      },
    }, f.caller());
    assert.equal(resolved, undefined);
    const isolated = createOwnerAssignmentControl({
      ownerId: "owner",
      schema: "public",
      authorizeControl() {},
      isCurrentStarted(who) {
        Object.assign(who.principal, { workerId: "changed" });
        return true;
      },
    });
    assert.deepEqual(await isolated.resolveStarted(f.db, f.caller()), f.value);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment schema refuses nullable control columns and nonpositive epoch contracts", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "ALTER TABLE owner_assignments ALTER COLUMN retired DROP NOT NULL",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query(
      "ALTER TABLE owner_assignments ALTER COLUMN retired SET NOT NULL",
    );
    await f.db.query(
      "ALTER TABLE owner_assignments ALTER COLUMN epoch DROP NOT NULL",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query(
      "ALTER TABLE owner_assignments ALTER COLUMN epoch SET NOT NULL",
    );
    await f.db.query(
      "ALTER TABLE owner_assignments DROP CONSTRAINT owner_assignments_epoch_check",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("Processor assignment binds only its exact registered consumer and cannot reinterpret an Action", async () => {
  const f = await fixture(true);
  try {
    for (
      const change of [
        { processorId: "foreign" },
        { sourceEventId: "foreign" },
        { namespace: "foreign" },
        { actionId: "work", executionId: "run" },
      ]
    ) {
      await assert.rejects(
        f.owner.execute(
          f.host(),
          f.command("assignment.bind", { ...f.value, ...change }),
        ),
      );
    }
    await f.owner.execute(f.host(), f.command());
    assert.equal(await f.owner.project(f.caller(), "binding", null), null);
    f.state.started = true;
    assert.deepEqual(
      await f.owner.project(f.caller(), "binding", null),
      f.value,
    );
    assert.equal("actionId" in f.value, false);
    assert.equal("executionId" in f.value, false);
    await f.owner.execute(f.host(), f.command("assignment.retire"));
    assert.equal(await f.owner.project(f.caller(), "binding", null), null);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
  const action = await fixture();
  try {
    const { actionId: _actionId, executionId: _executionId, ...base } = action
      .value as import("./assignments.ts").OwnerActionAssignmentBinding;
    await assert.rejects(
      action.owner.execute(
        action.host(),
        action.command("assignment.bind", {
          ...base,
          kind: "processor",
          processorId: "observe",
        }),
      ),
      /eligible/,
    );
  } finally {
    action.owner.stop();
    await action.db.close();
  }
});

test("worker names cannot impersonate tagged assignment control", async () => {
  const f = await fixture();
  try {
    for (const workerId of ["host", "owner:owner", '["owner",1,"first"]']) {
      await assert.rejects(
        f.owner.execute({
          principal: { kind: "worker", workerId },
          ownerEpoch: 1,
          host: true,
        }, f.command()),
        /Assignment control principal required/,
      );
    }
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_assignments")).rows.length,
      0,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});
