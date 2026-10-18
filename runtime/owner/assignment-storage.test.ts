import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import type { OwnerCommitContext } from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  type OwnerAssignmentBinding,
  ownerAssignmentKey,
  type OwnerPlacementBinding,
  parseOwnerStoredAssignment,
  provisionOwnerAssignments,
} from "./assignments.ts";
import {
  createOwnerAssignmentStorage,
  type OwnerStoredAssignment,
} from "./assignment-storage.ts";

const commandTime = "2099-01-01T00:00:00.000Z";
async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  await db.query(
    "INSERT INTO owner_epochs(owner,epoch,holder) VALUES('owner',3,'current')",
  );
  const context = (transaction: SqlExecutor): OwnerCommitContext => ({
    transaction,
    ownerId: "owner",
    epoch: 3,
    holderId: "current",
    commandTime,
  });
  const event = await db.transaction(async (tx) =>
    await createEventStore({ session: db, ownerCommit: context(tx) })
      .commitMutation({
        transaction: tx,
        draft: {
          namespace: "space",
          type: "requested",
          payload: {},
          metadata: { actionId: "work", actionRunId: "run" },
        },
        consumers: [{ consumerId: "registered:work", settlement: "inherit" }],
      })
  );
  const value: OwnerAssignmentBinding = {
    placement: "worker",
    workerId: "worker",
    workerAttemptId: "worker-attempt",
    sessionGeneration: 1,
    sessionId: "session",
    parentOperationId: "operation",
    assignmentId: "assignment",
    dispatchAttemptId: "dispatch",
    namespace: "space",
    sourceEventId: event.event.id,
    deliveryId: event.deliveries[0].id,
    actionId: "work",
    executionId: "run",
  };
  const store = createOwnerAssignmentStorage({
    ownerId: "owner",
    schema: "public",
  });
  async function put(
    epoch: number,
    name: string,
    retired = true,
    local = false,
  ): Promise<OwnerStoredAssignment> {
    const binding: OwnerPlacementBinding = local
      ? {
        placement: "owner-local",
        ownerId: "owner",
        epoch,
        holderId: `holder-${epoch}`,
        attemptId: name,
        namespace: value.namespace,
        sourceEventId: value.sourceEventId,
        deliveryId: value.deliveryId,
        kind: "action",
        actionId: "work",
        actionRunId: "run",
      }
      : { ...value, assignmentId: name, dispatchAttemptId: `dispatch-${name}` };
    const result = await db.query(
      `INSERT INTO owner_assignments(owner,epoch,assignment_key,delivery_id,binding,retired,created_at)
      VALUES('owner',$1,$2,$3,$4::jsonb,$5,$6::timestamptz) RETURNING *`,
      [
        epoch,
        ownerAssignmentKey("owner", binding),
        value.deliveryId,
        JSON.stringify(binding),
        retired,
        commandTime,
      ],
    );
    return parseOwnerStoredAssignment(result.rows[0]);
  }
  const list = (maxAssignments?: number) =>
    db.transaction((tx) =>
      store.listDelivery(context(tx), {
        namespace: "space",
        deliveryId: value.deliveryId,
        ...(maxAssignments === undefined ? {} : { maxAssignments }),
      })
    );
  return { db, value, store, context, put, list };
}

test("assignment storage retains detached prior current future retired and cross-placement evidence", async () => {
  const f = await fixture();
  try {
    const expected = [
      await f.put(1, "old", false),
      await f.put(2, "retired"),
      await f.put(3, "current"),
      await f.put(4, "future"),
      await f.put(2, "local", true, true),
    ];
    const actual = await f.list();
    assert.deepEqual(
      [...actual].sort((a, b) => a.key.localeCompare(b.key)),
      expected.sort((a, b) => a.key.localeCompare(b.key)),
    );
    Object.assign(actual[0].binding, { namespace: "mutated" });
    assert.equal(
      (await f.list()).every((row) => row.binding.namespace === "space"),
      true,
    );
    assert.equal(actual.some((row) => row.epoch === 4), true);
    assert.equal(
      actual.some((row) => row.binding.placement === "owner-local"),
      true,
    );
  } finally {
    await f.db.close();
  }
});

test("assignment storage refuses incomplete bounded history and enforces default and hard limits", async () => {
  const f = await fixture();
  try {
    await f.put(1, "one");
    await f.put(1, "two");
    await f.put(1, "three");
    await assert.rejects(f.list(2), /incomplete/);
    assert.equal((await f.list(3)).length, 3);
    for (const limit of [0, -1, 1.5, 1001, NaN, Infinity]) {
      await assert.rejects(f.list(limit), /limit/);
    }
    for (let index = 3; index < 101; index++) {
      await f.put(1, `history-${index}`);
    }
    await assert.rejects(f.list(), /incomplete/);
    assert.equal((await f.list(1000)).length, 101);
    const statements: { sql: string; params?: unknown[] }[] = [];
    await f.db.transaction(async (tx) => {
      await assert.rejects(
        f.store.listDelivery(
          f.context({
            async query<TRow extends Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ) {
              statements.push({ sql, params });
              return await tx.query<TRow>(sql, params);
            },
          }),
          { namespace: "space", deliveryId: f.value.deliveryId },
        ),
        /incomplete/,
      );
    });
    assert.equal(statements[1].params?.[2], 101);
    assert.match(
      statements[1].sql,
      /WHERE owner=\$1 AND delivery_id=\$2 LIMIT \$3/,
    );
    assert.doesNotMatch(
      statements[1].sql,
      /ORDER BY|namespace=|retired=|epoch</,
    );
  } finally {
    await f.db.close();
  }
});

test("assignment storage never hides malformed cross-namespace or inconsistent history", async () => {
  const f = await fixture();
  try {
    const row = await f.put(1, "old");
    for (
      const binding of [
        { ...row.binding, namespace: "foreign" },
        { ...row.binding, sourceEventId: 1 },
        { ...row.binding, assignmentId: "other" },
        { ...row.binding, placement: "unknown" },
      ]
    ) {
      await f.db.query("UPDATE owner_assignments SET binding=$1::jsonb", [
        JSON.stringify(binding),
      ]);
      await assert.rejects(f.list(), /assignment|namespace/i);
    }
    await f.db.query(
      "UPDATE owner_assignments SET binding=$1::jsonb,assignment_key='wrong'",
      [JSON.stringify(row.binding)],
    );
    await assert.rejects(f.list(), /coordinates/);
    await f.db.query("UPDATE owner_assignments SET binding=$1::jsonb", [
      JSON.stringify({ ...row.binding, huge: "x".repeat(17000) }),
    ]);
    await assert.rejects(f.list(), /assignment/i);
  } finally {
    await f.db.close();
  }
});

test("assignment history helpers independently require current exact owner transaction fences", async () => {
  const f = await fixture();
  try {
    const row = await f.put(1, "old", false);
    for (
      const change of [{ epoch: 2 }, { epoch: 4 }, { epoch: 0 }, {
        holderId: "old",
      }, { ownerId: "other" }]
    ) {
      await f.db.transaction(async (tx) => {
        const ctx = { ...f.context(tx), ...change };
        await assert.rejects(
          f.store.listDelivery(ctx, {
            namespace: "space",
            deliveryId: f.value.deliveryId,
          }),
          { code: "ActionOwnershipLost" },
        );
        await assert.rejects(f.store.retirePrior(ctx, row), {
          code: "ActionOwnershipLost",
        });
      });
    }
    await assert.rejects(
      f.store.listDelivery(
        { ...f.context(f.db), transaction: undefined } as never,
        { namespace: "space", deliveryId: f.value.deliveryId },
      ),
      /transaction/,
    );
    await assert.rejects(
      f.store.retirePrior({ ...f.context(f.db), commandTime: "invalid" }, row),
      /time/,
    );
    assert.equal((await f.list())[0].retired, false);
  } finally {
    await f.db.close();
  }
});

test("exact prior retirement preserves mismatched current future and already retired rows", async () => {
  const f = await fixture();
  try {
    const prior = await f.put(1, "prior", false);
    const current = await f.put(3, "current");
    const future = await f.put(4, "future");
    await f.db.transaction(async (tx) => {
      for (
        const row of [current, future, { ...prior, epoch: 2 }, {
          ...prior,
          retired: true,
        }, { ...prior, binding: { ...prior.binding, sourceEventId: "other" } }]
      ) {
        assert.equal(await f.store.retirePrior(f.context(tx), row), false);
      }
      assert.equal(await f.store.retirePrior(f.context(tx), prior), true);
      assert.equal(await f.store.retirePrior(f.context(tx), prior), false);
    });
    const rows = await f.db.query(
      "SELECT assignment_key,retired,retired_at FROM owner_assignments",
    );
    const changed = rows.rows.find((row) => row.assignment_key === prior.key)!;
    assert.equal(changed.retired, true);
    assert.equal(
      new Date(changed.retired_at as string).toISOString(),
      commandTime,
    );
    assert.equal(rows.rows.filter((row) => row.retired_at !== null).length, 1);
  } finally {
    await f.db.close();
  }
});

test("assignment helpers snapshot command coordinates row facts and time before awaited locks", async () => {
  const f = await fixture();
  try {
    const row = await f.put(1, "prior", false);
    await f.db.transaction(async (tx) => {
      const args = {
        namespace: "space",
        deliveryId: f.value.deliveryId,
        maxAssignments: 1,
      };
      const ctx = { ...f.context(tx) };
      ctx.transaction = {
        async query<TRow extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) {
          const result = await tx.query<TRow>(sql, params);
          if (sql.includes('"owner_epochs"')) {
            Object.assign(ctx, {
              ownerId: "other",
              epoch: 999,
              holderId: "other",
              commandTime: "2199-01-01T00:00:00.000Z",
            });
            Object.assign(args, {
              namespace: "other",
              deliveryId: "other",
              maxAssignments: 1000,
            });
          }
          return result;
        },
      };
      assert.deepEqual(await f.store.listDelivery(ctx, args), [row]);
    });
    await f.db.transaction(async (tx) => {
      const supplied = structuredClone(row);
      const ctx = { ...f.context(tx) };
      ctx.transaction = {
        async query<TRow extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) {
          const result = await tx.query<TRow>(sql, params);
          if (sql.includes('"owner_epochs"')) {
            Object.assign(ctx, {
              epoch: 999,
              holderId: "other",
              commandTime: "2199-01-01T00:00:00.000Z",
            });
            Object.assign(supplied.binding, {
              deliveryId: "other",
              sourceEventId: "other",
            });
            Object.assign(supplied, { epoch: 3, key: "other" });
          }
          return result;
        },
      };
      assert.equal(await f.store.retirePrior(ctx, supplied), true);
    });
    const changed =
      (await f.db.query("SELECT retired,retired_at FROM owner_assignments"))
        .rows[0];
    assert.equal(changed.retired, true);
    assert.equal(
      new Date(changed.retired_at as string).toISOString(),
      commandTime,
    );
  } finally {
    await f.db.close();
  }
});

test("assignment retirement rolls back with the caller transaction and cannot retire a replaced row", async () => {
  const f = await fixture();
  try {
    const row = await f.put(1, "prior", false);
    await assert.rejects(
      f.db.transaction(async (tx) => {
        assert.equal(await f.store.retirePrior(f.context(tx), row), true);
        throw new Error("rollback all evidence");
      }),
      /rollback/,
    );
    assert.deepEqual(await f.list(), [row]);
    await f.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE owner_assignments SET binding=$1::jsonb WHERE assignment_key=$2",
        [JSON.stringify({ ...row.binding, sourceEventId: "changed" }), row.key],
      );
      assert.equal(await f.store.retirePrior(f.context(tx), row), false);
    });
    assert.equal(
      (await f.db.query("SELECT retired FROM owner_assignments")).rows[0]
        .retired,
      false,
    );
  } finally {
    await f.db.close();
  }
});

test("prior retirement refuses live current and future epoch reservations", async () => {
  const f = await fixture();
  try {
    for (const epoch of [3, 4]) {
      const row = await f.put(epoch, `live-${epoch}`, false);
      await f.db.transaction(async (tx) => {
        assert.equal(await f.store.retirePrior(f.context(tx), row), false);
      });
      assert.equal(
        (await f.db.query(
          "SELECT retired FROM owner_assignments WHERE assignment_key=$1",
          [row.key],
        )).rows[0].retired,
        false,
      );
      await f.db.query(
        "UPDATE owner_assignments SET retired=TRUE WHERE assignment_key=$1",
        [row.key],
      );
    }
  } finally {
    await f.db.close();
  }
});
