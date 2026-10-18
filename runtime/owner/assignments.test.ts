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
  OWNER_ASSIGNMENT_BINDING_MAX_BYTES,
  type OwnerAssignmentBinding,
  ownerAssignmentKey,
  type OwnerLocalAssignmentBinding,
  type OwnerPlacementBinding,
  parseOwnerPlacementBinding,
  parseOwnerStoredAssignment,
  provisionOwnerAssignments,
  validateOwnerAssignments,
} from "./assignments.ts";

async function fixture(processor = false, maxActive = 1) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  const state = {
    started: false,
    control: true,
    rollback: false,
    registeredAction: true,
    registeredActionId: "work",
    currentLocal: true,
    localBinding: undefined as OwnerLocalAssignmentBinding | undefined,
  };
  const control = createOwnerAssignmentControl({
    ownerId: "owner",
    schema: "public",
    maxActive,
    authorizeControl(_tx, who) {
      if (!state.control || who.host !== true) {
        throw new Error("control refused");
      }
    },
    isCurrentStarted: () => state.started,
    resolveCurrentLocal: () =>
      state.currentLocal ? state.localBinding : undefined,
    hasAction: (id) =>
      state.registeredAction && id === state.registeredActionId,
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
    placement: "worker",
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
    binding: OwnerPlacementBinding = value,
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
      Number(
        (await f.db.query("SELECT COUNT(*) AS count FROM owner_assignments"))
          .rows[0].count,
      ),
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

for (const processor of [false, true]) {
  test(`assignment refuses a foreign-owned ${processor ? "Processor" : "Action"} source in the same namespace`, async () => {
    const f = await fixture(processor);
    try {
      // Inject foreign source evidence without creating a second active owner:
      // the production schema still permits exactly one owner epoch row.
      await f.db.query(
        `INSERT INTO events (id,schema_version,type,namespace,payload,metadata,correlation_id,owner_id,seq)
        SELECT 'foreign-source',schema_version,type,namespace,payload,metadata,correlation_id,'foreign-owner',1
        FROM events WHERE id=$1`,
        [f.value.sourceEventId],
      );
      await f.db.query(
        `INSERT INTO event_deliveries (id,event_id,consumer_id,settlement_scope_id,status)
        SELECT 'foreign-delivery','foreign-source',consumer_id,settlement_scope_id,'pending'
        FROM event_deliveries WHERE id=$1`,
        [f.value.deliveryId],
      );
      await assert.rejects(
        f.owner.execute(
          f.host(),
          f.command("assignment.bind", {
            ...f.value,
            sourceEventId: "foreign-source",
            deliveryId: "foreign-delivery",
          }),
        ),
        /not eligible/,
      );
      assert.equal(
        (await f.db.query("SELECT 1 FROM owner_assignments")).rows.length,
        0,
      );
      // A forged durable reservation must not bypass bind-time source ownership.
      const foreign = {
        sourceEventId: "foreign-source",
        deliveryId: "foreign-delivery",
      };
      const foreignWorker = { ...f.value, ...foreign };
      const foreignLocal = { ...localBinding(f), ...foreign };
      for (const binding of [foreignWorker, foreignLocal]) {
        const key = ownerAssignmentKey("owner", binding);
        await f.db.query(
          `INSERT INTO owner_assignments(owner,epoch,assignment_key,delivery_id,binding,created_at)
          VALUES('owner',1,$1,$2,$3::jsonb,NOW())`,
          [key, binding.deliveryId, JSON.stringify(binding)],
        );
        if (binding.placement === "worker") {
          f.state.started = true;
          assert.equal(
            await f.db.transaction((tx) =>
              f.control.resolveStarted(tx, f.caller())
            ),
            undefined,
          );
        } else {
          f.state.localBinding = binding;
          assert.equal(
            await f.db.transaction((tx) =>
              f.control.resolveLocal(tx, localCaller(binding))
            ),
            undefined,
          );
        }
        await f.db.query(
          "UPDATE owner_assignments SET retired=TRUE WHERE assignment_key=$1",
          [key],
        );
      }
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  });
}

function localBinding(
  f: Awaited<ReturnType<typeof fixture>>,
): OwnerLocalAssignmentBinding {
  return {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "first",
    attemptId: "local-attempt",
    namespace: f.value.namespace,
    sourceEventId: f.value.sourceEventId,
    deliveryId: f.value.deliveryId,
    ...("kind" in f.value && f.value.kind === "processor"
      ? {
        kind: "processor" as const,
        processorId: f.value.processorId,
        consumerId: `processor:${f.value.processorId}`,
      }
      : { kind: "action" as const, actionId: "work", actionRunId: "run" }),
  };
}
function localCaller(value: OwnerLocalAssignmentBinding): OwnerCaller {
  return {
    principal: {
      kind: "owner-local",
      ownerId: value.ownerId,
      epoch: value.epoch,
      holderId: value.holderId,
      deliveryId: value.deliveryId,
      attemptId: value.attemptId,
    },
    ownerEpoch: value.epoch,
  };
}

test("assignment codecs require exact placement tags and canonical local target coordinates", () => {
  const value = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: "event",
    deliveryId: "delivery",
    kind: "action",
    actionId: "work",
    actionRunId: "run",
  } as const;
  assert.deepEqual(parseOwnerPlacementBinding(value), value);
  for (const field of Object.keys(value)) {
    const missing: Record<string, unknown> = { ...value };
    delete missing[field];
    assert.throws(() => parseOwnerPlacementBinding(missing));
  }
  for (
    const change of [
      { placement: "local" },
      { epoch: "1" },
      { epoch: 0 },
      { epoch: 1.1 },
      { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { workerId: "invented" },
      { sessionId: "invented" },
      { executionId: "invented" },
      { holderId: " holder" },
      { kind: "processor" },
      { attemptId: null },
    ]
  ) {
    assert.throws(() => parseOwnerPlacementBinding({ ...value, ...change }));
  }
  const { actionId: _action, actionRunId: _run, ...base } = value;
  const processor = {
    ...base,
    kind: "processor",
    processorId: "observe",
    consumerId: "processor:observe",
  };
  assert.equal(parseOwnerPlacementBinding(processor).placement, "owner-local");
  assert.throws(() =>
    parseOwnerPlacementBinding({
      ...processor,
      consumerId: "registered:observe",
    })
  );
  const copy = parseOwnerPlacementBinding(value);
  assert.notEqual(copy, value);
  const key = ownerAssignmentKey("owner", value);
  assert.notEqual(
    key,
    ownerAssignmentKey("owner", {
      placement: "worker",
      sessionId: "delivery",
      assignmentId: "attempt",
    }),
  );
  const raw = {
    owner: "owner",
    epoch: "1",
    assignment_key: key,
    delivery_id: "delivery",
    binding: value,
    retired: false,
  };
  assert.deepEqual(parseOwnerStoredAssignment(raw), {
    owner: "owner",
    epoch: 1,
    key,
    binding: value,
    retired: false,
  });
  for (
    const change of [
      { owner: "other" },
      { epoch: 2 },
      { epoch: "01" },
      { assignment_key: `${key} ` },
      { delivery_id: "other" },
      { retired: 0 },
    ]
  ) {
    assert.throws(() => parseOwnerStoredAssignment({ ...raw, ...change }));
  }
});

for (const processor of [false, true]) {
  test(`owner-local ${processor ? "Processor" : "Action"} reservation requires its exact source and private handle`, async () => {
    const f = await fixture(processor, 3);
    try {
      const value = localBinding(f);
      const caller = localCaller(value);
      for (
        const change of [
          { ownerId: "other" },
          { epoch: 2 },
          { holderId: "other" },
          { sourceEventId: "other" },
          { namespace: "other" },
        ]
      ) {
        await assert.rejects(
          f.owner.execute(
            f.host(),
            f.command("assignment.bind", { ...value, ...change }),
          ),
        );
      }
      if (!processor) {
        f.state.registeredAction = false;
        await assert.rejects(
          f.owner.execute(f.host(), f.command("assignment.bind", value)),
          /Registered Action/,
        );
        f.state.registeredAction = true;
      }
      await f.owner.execute(f.host(), f.command("assignment.bind", value));
      assert.equal(await f.control.resolveLocal(f.db, caller), undefined);
      f.state.localBinding = value;
      assert.deepEqual(await f.control.resolveLocal(f.db, caller), value);
      assert.equal(await f.control.resolveStarted(f.db, caller), undefined);
      assert.deepEqual(
        (await f.db.query(
          "SELECT status,attempts,lease_owner,lease_expires_at FROM event_deliveries",
        )).rows,
        [{
          status: "pending",
          attempts: 0,
          lease_owner: null,
          lease_expires_at: null,
        }],
      );
      await assert.rejects(f.owner.execute(f.host(), f.command()), /unique/i);
      await f.owner.execute(f.host(), f.command("assignment.retire", value));
      assert.equal(await f.control.resolveLocal(f.db, caller), undefined);
      await f.owner.execute(f.host(), f.command());
      f.state.started = true;
      assert.deepEqual(
        await f.control.resolveStarted(f.db, f.caller()),
        f.value,
      );
    } finally {
      f.owner.stop();
      await f.db.close();
    }
  });
}

test("owner-local resolution independently fences principal owner epoch holder delivery and attempt", async () => {
  const f = await fixture();
  try {
    const value = localBinding(f);
    f.state.localBinding = value;
    const caller = localCaller(value);
    await f.owner.execute(f.host(), f.command("assignment.bind", value));
    for (
      const change of [
        { ownerId: "foreign" },
        { epoch: 2 },
        { holderId: "other" },
        { deliveryId: "other" },
        { attemptId: "other" },
        { workerId: "extra" },
      ]
    ) {
      assert.equal(
        await f.control.resolveLocal(
          f.db,
          {
            ...caller,
            principal: { ...caller.principal, ...change },
          } as OwnerCaller,
        ),
        undefined,
      );
    }
    assert.equal(
      await f.control.resolveLocal(f.db, { ...caller, ownerEpoch: 2 }),
      undefined,
    );
    assert.equal(await f.control.resolveLocal(f.db, f.host()), undefined);
    assert.equal(await f.control.resolveLocal(f.db, f.caller()), undefined);
    await f.db.query(
      "UPDATE owner_epochs SET epoch=2,holder='second' WHERE owner='owner'",
    );
    assert.equal(await f.control.resolveLocal(f.db, caller), undefined);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("owner-local resolution snapshots private facts and rechecks revoked or replaced handles after SQL", async () => {
  const f = await fixture();
  try {
    const value = localBinding(f);
    f.state.localBinding = value;
    await f.owner.execute(f.host(), f.command("assignment.bind", value));
    const caller = localCaller(value);
    const isolated = createOwnerAssignmentControl({
      ownerId: "owner",
      schema: "public",
      authorizeControl() {},
      isCurrentStarted: () => false,
      resolveCurrentLocal(who) {
        Object.assign(who.principal, {
          ownerId: "mutated",
          attemptId: "mutated",
        });
        return value;
      },
    });
    assert.deepEqual(await isolated.resolveLocal(f.db, caller), value);
    assert.equal(
      caller.principal.kind === "owner-local" && caller.principal.ownerId,
      "owner",
    );
    for (
      const change of [
        undefined,
        { ...value, attemptId: "new" },
        { ...value, namespace: "new" },
        { ...value, sourceEventId: "new" },
        { ...value, actionRunId: "new" },
        { ...value, actionId: "new" },
      ]
    ) {
      f.state.localBinding = value;
      const tx: import("../events/session.ts").SqlExecutor = {
        async query(sql, params) {
          const result = await f.db.query(sql, params);
          f.state.localBinding = change;
          return result as never;
        },
      };
      assert.equal(await f.control.resolveLocal(tx, caller), undefined);
    }
    const mutable = { ...value };
    f.state.localBinding = mutable;
    const pending = f.control.resolveLocal({
      async query(sql, params) {
        const result = await f.db.query(sql, params);
        Object.assign(mutable, { sourceEventId: "changed" });
        return result as never;
      },
    }, caller);
    assert.equal(await pending, undefined);
    assert.equal(
      (await f.db.query<{ binding: OwnerPlacementBinding }>(
        "SELECT binding FROM owner_assignments",
      )).rows[0]
        .binding.sourceEventId,
      value.sourceEventId,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment resolvers reject durable source/target and canonical-key corruption", async () => {
  const f = await fixture();
  try {
    await f.owner.execute(f.host(), f.command());
    f.state.started = true;
    for (
      const change of [{ sourceEventId: "other" }, { namespace: "other" }, {
        actionId: "other",
      }, { executionId: "other" }]
    ) {
      await f.db.query("UPDATE owner_assignments SET binding=$1::jsonb", [
        JSON.stringify({ ...f.value, ...change }),
      ]);
      assert.equal(await f.control.resolveStarted(f.db, f.caller()), undefined);
    }
    await f.db.query(
      "UPDATE owner_assignments SET binding=$1::jsonb,assignment_key='wrong'",
      [JSON.stringify(f.value)],
    );
    assert.equal(await f.control.resolveStarted(f.db, f.caller()), undefined);
    await f.db.query(
      "UPDATE owner_assignments SET assignment_key=$1,binding=$2::jsonb",
      [
        ownerAssignmentKey("owner", f.value),
        JSON.stringify({ ...f.value, assignmentId: "other" }),
      ],
    );
    await assert.rejects(
      f.control.resolveStarted(f.db, f.caller()),
      /coordinates/,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment schema requires exact generic keys and an unfiltered delivery history index", async () => {
  const f = await fixture();
  try {
    const columns = (await f.db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='owner_assignments' ORDER BY column_name",
    )).rows.map((x) => x.column_name);
    assert.ok(columns.includes("assignment_key"));
    assert.equal(columns.includes("session_id"), false);
    await f.db.query("DROP INDEX owner_assignments_delivery_history_idx");
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query(
      "CREATE INDEX owner_assignments_delivery_history_idx ON owner_assignments(delivery_id,owner) WHERE retired=FALSE",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query("DROP INDEX owner_assignments_delivery_history_idx");
    await f.db.query(
      "CREATE INDEX owner_assignments_delivery_history_idx ON owner_assignments(delivery_id,owner)",
    );
    await validateOwnerAssignments(f.db, "public");
    await f.db.query(
      "ALTER TABLE owner_assignments ADD COLUMN session_id TEXT",
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

test("assignment fresh provisioning refuses the old worker-only schema without repair", async () => {
  const f = await fixture();
  try {
    await f.db.query("DROP TABLE owner_assignments");
    await f.db.query(`CREATE TABLE owner_assignments (
      owner TEXT NOT NULL REFERENCES owner_epochs(owner), epoch BIGINT NOT NULL CHECK(epoch>0),
      session_id TEXT NOT NULL, assignment_id TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES event_deliveries(id),
      binding JSONB NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL, retired_at TIMESTAMPTZ,
      PRIMARY KEY(owner,session_id,assignment_id))`);
    await f.db.query(
      "CREATE UNIQUE INDEX owner_assignments_live_delivery_idx ON owner_assignments(owner,delivery_id) WHERE retired=FALSE",
    );
    await assert.rejects(
      provisionOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name='owner_assignments' AND column_name='assignment_key'",
      )).rows.length,
      0,
    );
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment binding byte budget includes UTF-8 escaping and JSONB whitespace", async () => {
  const base: OwnerAssignmentBinding = {
    placement: "worker",
    workerId: "id",
    workerAttemptId: "id",
    sessionGeneration: 1,
    sessionId: "id",
    parentOperationId: "id",
    assignmentId: "id",
    dispatchAttemptId: "id",
    namespace: "id",
    sourceEventId: "id",
    deliveryId: "id",
    actionId: "id",
    executionId: "id",
  };
  const fields = Object.keys(base).filter((key) =>
    !["placement", "sessionGeneration"].includes(key)
  );
  for (const text of ["界".repeat(1024), "\\".repeat(1024)]) {
    const oversized = { ...base };
    for (const key of fields) Object.assign(oversized, { [key]: text });
    assert.throws(() => parseOwnerPlacementBinding(oversized), /byte limit/);
  }
  const size = (value: unknown) =>
    new TextEncoder().encode(
      `{${
        Object.entries(value as object).map(([key, item]) =>
          `${JSON.stringify(key)}: ${JSON.stringify(item)}`
        ).join(", ")
      }}`,
    ).byteLength;
  const exact = { ...base };
  for (const key of fields) {
    const remaining = OWNER_ASSIGNMENT_BINDING_MAX_BYTES - size(exact);
    const length = Math.min(1024, Math.floor((remaining + 2) / 3));
    if (length > 0) Object.assign(exact, { [key]: "界".repeat(length) });
    if (OWNER_ASSIGNMENT_BINDING_MAX_BYTES - size(exact) < 3) break;
  }
  const room = OWNER_ASSIGNMENT_BINDING_MAX_BYTES - size(exact);
  const short = fields.find((key) =>
    (exact as unknown as Record<string, string>)[key].length + room < 1024
  )!;
  Object.assign(exact, {
    [short]: (exact as unknown as Record<string, string>)[short] +
      "x".repeat(room),
  });
  assert.equal(size(exact), OWNER_ASSIGNMENT_BINDING_MAX_BYTES);
  assert.deepEqual(parseOwnerPlacementBinding(exact), exact);
  assert.throws(
    () =>
      parseOwnerPlacementBinding({
        ...exact,
        [short]: (exact as unknown as Record<string, string>)[short] + "x",
      }),
    /byte limit/,
  );
  const f = await fixture();
  try {
    const stored = (await f.db.query<{ bytes: number }>(
      "SELECT octet_length($1::jsonb::text) AS bytes",
      [JSON.stringify(exact)],
    )).rows[0].bytes;
    assert.equal(stored, OWNER_ASSIGNMENT_BINDING_MAX_BYTES);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment validator refuses expression and extra-key indexes that weaken uniqueness or bounded lookup", async () => {
  const f = await fixture();
  try {
    await f.db.query("DROP INDEX owner_assignments_live_delivery_idx");
    await f.db.query(
      "CREATE UNIQUE INDEX owner_assignments_live_delivery_idx ON owner_assignments(owner,delivery_id,(binding->>'assignmentId')) WHERE retired=FALSE",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query("DROP INDEX owner_assignments_live_delivery_idx");
    await f.db.query(
      "CREATE UNIQUE INDEX owner_assignments_live_delivery_idx ON owner_assignments(owner,delivery_id) INCLUDE(epoch) WHERE retired=FALSE",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query("DROP INDEX owner_assignments_live_delivery_idx");
    await f.db.query(
      "CREATE UNIQUE INDEX owner_assignments_live_delivery_idx ON owner_assignments(owner,delivery_id) WHERE retired=FALSE",
    );
    await f.db.query("DROP INDEX owner_assignments_delivery_history_idx");
    await f.db.query(
      "CREATE INDEX owner_assignments_delivery_history_idx ON owner_assignments(delivery_id,owner,(binding->>'assignmentId'))",
    );
    await assert.rejects(
      validateOwnerAssignments(f.db, "public"),
      /incompatible/,
    );
    await f.db.query("DROP INDEX owner_assignments_delivery_history_idx");
    await f.db.query(
      "CREATE INDEX owner_assignments_delivery_history_idx ON owner_assignments(delivery_id,owner)",
    );
    await f.db.query(
      "ALTER TABLE owner_assignments DROP CONSTRAINT owner_assignments_pkey",
    );
    await f.db.query(
      "ALTER TABLE owner_assignments ADD PRIMARY KEY(owner,assignment_key,epoch)",
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

test("assignment control snapshots callback identities and isolates control caller facts", async () => {
  const f = await fixture();
  try {
    const caller = f.host();
    const options = {
      ownerId: "owner",
      schema: "public",
      authorizeControl(_tx: unknown, who: OwnerCaller) {
        Object.assign(who.principal, {
          ownerId: "mutated",
          holderId: "mutated",
        });
        Object.assign(who, { ownerEpoch: 999 });
      },
      isCurrentStarted: () => true,
      resolveCurrentLocal: () => undefined,
      hasAction: () => false,
      hasProcessor: () => false,
    };
    const isolated = createOwnerAssignmentControl(options);
    options.authorizeControl = () => {
      throw new Error("replaced callback");
    };
    options.isCurrentStarted = () => {
      throw new Error("replaced callback");
    };
    options.resolveCurrentLocal = () => {
      throw new Error("replaced callback");
    };
    options.hasAction = () => true;
    options.hasProcessor = () => true;
    await isolated.authorize(
      f.db,
      caller,
      f.command(),
      "2099-01-01T00:00:00.000Z",
    );
    assert.deepEqual(caller, f.host());
    assert.equal(await isolated.resolveStarted(f.db, f.caller()), undefined);
    assert.equal(
      await isolated.resolveLocal(f.db, localCaller(localBinding(f))),
      undefined,
    );
    const local = localBinding(f);
    await f.db.transaction(async (tx) => {
      await assert.rejects(
        Promise.resolve(isolated.handlers["assignment.bind"](local, {
          tx,
          caller,
          command: f.command("assignment.bind", local),
          commandTime: "2099-01-01T00:00:00.000Z",
          ownerCommit: {
            transaction: tx,
            ownerId: "owner",
            epoch: 1,
            holderId: "first",
            commandTime: "2099-01-01T00:00:00.000Z",
          },
          signal: new AbortController().signal,
          afterCommit() {},
        })),
        /Registered Action/,
      );
    });
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("assignment decoder refuses accessors hidden properties and prototype-shaped bindings", () => {
  const value = {
    placement: "worker",
    workerId: "w",
    workerAttemptId: "wa",
    sessionGeneration: 1,
    sessionId: "s",
    parentOperationId: "p",
    assignmentId: "a",
    dispatchAttemptId: "d",
    namespace: "n",
    sourceEventId: "e",
    deliveryId: "delivery",
    actionId: "action",
    executionId: "run",
  };
  let reads = 0;
  for (const key of Object.keys(value)) {
    const accessor = { ...value };
    Object.defineProperty(accessor, key, {
      enumerable: true,
      get() {
        reads++;
        return "owner-local";
      },
    });
    assert.throws(() => parseOwnerPlacementBinding(accessor), /Invalid/);
  }
  assert.equal(reads, 0);
  const hidden = { ...value };
  Object.defineProperty(hidden, "placement", {
    enumerable: false,
    value: "worker",
  });
  assert.throws(() => parseOwnerPlacementBinding(hidden), /Invalid/);
  assert.throws(
    () => parseOwnerPlacementBinding({ ...value, [Symbol("hidden")]: "bad" }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseOwnerPlacementBinding(
        Object.assign(Object.create({ hidden: true }), value),
      ),
    /Invalid/,
  );
  const plain = Object.assign(Object.create(null), value);
  assert.deepEqual(parseOwnerPlacementBinding(plain), value);
});

for (const field of ["actionId", "actionRunId"] as const) {
  for (const mode of ["bind", "resolve"] as const) {
    test(`assignment ${mode} refuses a numeric ${field} source identity for both placements`, async () => {
      const f = await fixture();
      try {
        await f.db.query(
          `INSERT INTO events(id,schema_version,type,namespace,payload,metadata,correlation_id,owner_id,seq)
          SELECT 'numeric-source',schema_version,type,namespace,payload,jsonb_set(metadata,ARRAY[$2::text],'1'::jsonb),correlation_id,owner_id,seq+1
          FROM events WHERE id=$1`,
          [f.value.sourceEventId, field],
        );
        await f.db.query(
          `INSERT INTO event_deliveries(id,event_id,consumer_id,settlement_scope_id,status)
          SELECT 'numeric-delivery','numeric-source',$2,settlement_scope_id,'pending'
          FROM event_deliveries WHERE id=$1`,
          [
            f.value.deliveryId,
            field === "actionId" ? "registered:1" : "registered:work",
          ],
        );
        const source = {
          sourceEventId: "numeric-source",
          deliveryId: "numeric-delivery",
        };
        const worker = {
          ...f.value,
          ...source,
          ...(field === "actionId" ? { actionId: "1" } : { executionId: "1" }),
        };
        const local = {
          ...localBinding(f),
          ...source,
          ...(field === "actionId" ? { actionId: "1" } : { actionRunId: "1" }),
        };
        f.state.registeredActionId = field === "actionId" ? "1" : "work";
        for (const binding of [worker, local]) {
          if (mode === "bind") {
            await assert.rejects(
              f.owner.execute(f.host(), f.command("assignment.bind", binding)),
              /eligible/,
            );
          } else {
            const key = ownerAssignmentKey("owner", binding);
            await f.db.query(
              `INSERT INTO owner_assignments(owner,epoch,assignment_key,delivery_id,binding,created_at)
              VALUES('owner',1,$1,$2,$3::jsonb,NOW())`,
              [key, binding.deliveryId, JSON.stringify(binding)],
            );
            if (binding.placement === "worker") {
              f.state.started = true;
              assert.equal(
                await f.owner.project(f.caller(), "binding", null),
                null,
              );
            } else {
              f.state.localBinding = binding;
              assert.equal(
                await f.db.transaction((tx) =>
                  f.control.resolveLocal(tx, localCaller(binding))
                ),
                undefined,
              );
            }
            await f.db.query(
              "UPDATE owner_assignments SET retired=TRUE WHERE assignment_key=$1",
              [key],
            );
          }
        }
      } finally {
        f.owner.stop();
        await f.db.close();
      }
    });
  }
}

test("assignment resolvers return NULL for oversized source identity scalars", async () => {
  const f = await fixture();
  try {
    f.state.started = true;
    for (const [index, field] of ["actionId", "actionRunId"].entries()) {
      const sourceEventId = `oversized-source-${index}`;
      const deliveryId = `oversized-delivery-${index}`;
      await f.db.query(
        `INSERT INTO events(id,schema_version,type,namespace,payload,metadata,correlation_id,owner_id,seq)
        SELECT $2,schema_version,type,namespace,payload,jsonb_set(metadata,ARRAY[$3::text],to_jsonb($4::text)),correlation_id,owner_id,seq+$5
        FROM events WHERE id=$1`,
        [
          f.value.sourceEventId,
          sourceEventId,
          field,
          "x".repeat(1025),
          index + 1,
        ],
      );
      await f.db.query(
        `INSERT INTO event_deliveries(id,event_id,consumer_id,settlement_scope_id,status)
        SELECT $2,$3,consumer_id,settlement_scope_id,'pending' FROM event_deliveries WHERE id=$1`,
        [f.value.deliveryId, deliveryId, sourceEventId],
      );
      for (
        const binding of [{
          ...f.value,
          sourceEventId,
          deliveryId,
          assignmentId: `oversized-${index}`,
        }, { ...localBinding(f), sourceEventId, deliveryId }]
      ) {
        const key = ownerAssignmentKey("owner", binding);
        await f.db.query(
          `INSERT INTO owner_assignments(owner,epoch,assignment_key,delivery_id,binding,created_at)
          VALUES('owner',1,$1,$2,$3::jsonb,NOW())`,
          [key, deliveryId, JSON.stringify(binding)],
        );
        let selected: unknown = "not selected";
        await f.db.transaction(async (transaction) => {
          const tx: import("../events/session.ts").SqlExecutor = {
            async query<TRow extends Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ) {
              const result = await transaction.query<TRow>(sql, params);
              if (sql.includes(" AS source_action_id")) {
                selected = result.rows[0]?.[
                  field === "actionId"
                    ? "source_action_id"
                    : "source_action_run_id"
                ];
              }
              return result;
            },
          };
          if (binding.placement === "worker") {
            assert.equal(
              await f.control.resolveStarted(
                tx,
                f.caller({ assignmentId: binding.assignmentId }),
              ),
              undefined,
            );
          } else {
            f.state.localBinding = binding;
            assert.equal(
              await f.control.resolveLocal(tx, localCaller(binding)),
              undefined,
            );
          }
        });
        assert.equal(selected, null);
        await f.db.query(
          "UPDATE owner_assignments SET retired=TRUE WHERE assignment_key=$1",
          [key],
        );
      }
    }
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});

test("worker assignment authority uses certified read-only scope without losing Started revocation", async () => {
  const f = await fixture();
  try {
    await f.owner.execute(f.host(), f.command());
    f.state.started = true;
    await f.db.withReadSnapshot!(async (scope) => {
      if (scope.kind === "exclusive") {
        assert.deepEqual(
          await f.control.resolveStarted(
            scope.snapshot,
            f.caller(),
            "exclusive-read",
          ),
          f.value,
        );
        f.state.started = false;
        assert.equal(
          await f.control.resolveStarted(
            scope.snapshot,
            f.caller(),
            "exclusive-read",
          ),
          undefined,
        );
      } else {
        await scope.current(async (tx) => {
          assert.deepEqual(
            await f.control.resolveStarted(tx, f.caller()),
            f.value,
          );
          f.state.started = false;
          assert.equal(
            await f.control.resolveStarted(tx, f.caller()),
            undefined,
          );
        });
      }
    });
  } finally {
    f.owner.stop();
    await f.db.close();
  }
});
