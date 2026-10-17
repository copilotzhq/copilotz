import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createEventStore,
  type EventStore,
  type OwnerEventCommitContext,
} from "../events/store.ts";
import type { EventDelivery } from "../events/types.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCommandContext,
  type OwnerJson,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const start = "2099-01-01T00:00:00.000Z";
const at = (milliseconds: number) =>
  new Date(Date.parse(start) + milliseconds).toISOString();
const unavailable: SqlSession = {
  query() {
    throw new Error("ambient query is forbidden");
  },
  transaction() {
    throw new Error("ambient transaction is forbidden");
  },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
async function within(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const context = (
  transaction: SqlExecutor,
  commandTime = start,
): OwnerEventCommitContext => ({
  transaction,
  ownerId: "owner",
  epoch: 1,
  holderId: "holder",
  commandTime,
});
async function seed(transaction: SqlExecutor, maxAttempts = 4) {
  return await createEventStore({
    session: unavailable,
    ownerCommit: context(transaction),
  }).commitMutation({
    transaction,
    draft: {
      type: "source",
      namespace: "space",
      payload: {},
      deduplicationId: "source",
    },
    consumers: [{ consumerId: "consumer", settlement: "inherit" }],
    maxAttempts,
  });
}
async function snapshot(db: SqlExecutor) {
  return {
    deliveries: (await db.query("SELECT * FROM event_deliveries ORDER BY id"))
      .rows,
    events: (await db.query("SELECT * FROM events ORDER BY position")).rows,
    receipts: (await db.query("SELECT * FROM owner_receipts ORDER BY key"))
      .rows,
    alarms: (await db.query("SELECT * FROM owner_alarms ORDER BY name")).rows,
    epochs: (await db.query("SELECT * FROM owner_epochs")).rows,
  };
}
async function createFixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  const gate = {
    enabled: false,
    held: false,
    reached: deferred(),
    release: deferred(),
  };
  const state = {
    time: start,
    attempt: "attempt-1",
    authorized: true,
    rejectRelease: false,
    rejectOuter: false,
    rollbackSnapshot: undefined as
      | Awaited<ReturnType<typeof snapshot>>
      | undefined,
    lastStore: undefined as EventStore | undefined,
    handlerCalls: 0,
    publications: [] as {
      key: string;
      receipts: number;
      terminals: number;
      gated: boolean;
    }[],
    publicationErrors: [] as unknown[],
    published: deferred(),
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(operation) {
      let gated = false;
      const result = await db.transaction(async (tx) => {
        const value = await operation({
          async query(sql, params) {
            if (
              state.rejectRelease && sql === "RELEASE SAVEPOINT owner_command_0"
            ) {
              state.rejectRelease = false;
              state.rollbackSnapshot = await snapshot(tx);
              throw new Error("rollback fixture after receipt insertion");
            }
            return await tx.query(sql, params);
          },
        });
        if (state.rejectOuter) {
          state.rejectOuter = false;
          state.rollbackSnapshot = await snapshot(tx);
          throw new Error("injected outer rollback before commit");
        }
        if (gate.enabled) {
          gate.enabled = false;
          gated = gate.held = true;
          gate.reached.resolve();
          await gate.release.promise;
        }
        return value;
      });
      if (gated) gate.held = false;
      return result;
    },
  };
  const mark = async (
    ctx: OwnerCommandContext,
    label: string,
  ) => {
    await createEventStore({
      session: unavailable,
      ownerCommit: { ...ctx.ownerCommit, afterCommit: ctx.afterCommit },
    }).commitMutation({
      transaction: ctx.tx,
      draft: {
        type: label,
        namespace: "space",
        payload: {},
        deduplicationId: `${ctx.command.key}:${label}`,
      },
      consumers: [],
    });
    await ctx.tx.query(
      "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,$2)",
      [`${ctx.command.key}:${label}`, ctx.commandTime],
    );
  };
  const boundary = createOwnerCommandBoundary({
    session,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => state.time,
    authorize(_tx, caller) {
      assert.equal(state.authorized, true, "current assignment revoked");
      assert.equal(
        caller.principal.kind === "worker"
          ? caller.principal.workerId
          : undefined,
        "worker",
      );
      assert.equal(caller.dispatchAttemptId, state.attempt);
    },
    authenticateReceipt(_tx, caller) {
      assert.equal(
        caller.principal.kind === "worker"
          ? caller.principal.workerId
          : undefined,
        "worker",
      );
    },
    onPostCommitError: (error) => state.publicationErrors.push(error),
    handlers: {
      async delivery(intent, ctx): Promise<OwnerJson> {
        state.handlerCalls++;
        const input = intent as {
          op: string;
          id: string;
          retryable?: boolean;
        };
        const store = createEventStore({
          session: unavailable,
          ownerCommit: {
            ...ctx.ownerCommit,
            afterCommit: ctx.afterCommit,
            ownerAttempt: {
              deliveryId: input.id,
              attemptId: String(ctx.caller.dispatchAttemptId),
            },
          },
          now: () => {
            throw new Error("command must use its timestamp");
          },
          lockSettlementScope(tx) {
            assert.equal(tx, ctx.tx);
            return Promise.resolve();
          },
          async settleActionOwners(tx) {
            assert.equal(tx, ctx.tx);
            await mark(ctx, "delivery.terminal");
            const key = ctx.command.key;
            return async () => {
              state.publications.push({
                key,
                receipts: (await db.query(
                  "SELECT key FROM owner_receipts WHERE key=$1",
                  [key],
                )).rows.length,
                terminals: (await db.query(
                  "SELECT id FROM events WHERE deduplication_id=$1",
                  [`${key}:delivery.terminal`],
                )).rows.length,
                gated: gate.held,
              });
              state.published.resolve();
            };
          },
        });
        state.lastStore = store;
        const owner = String(ctx.caller.dispatchAttemptId);
        let delivery: EventDelivery | null;
        if (input.op === "claim") {
          delivery = await store.claimDelivery({
            id: input.id,
            owner,
          });
        } else if (input.op === "succeed") {
          delivery = await store.succeedDelivery(input.id, owner);
        } else if (input.op === "cancel") {
          delivery = await store.cancelDelivery(input.id, owner);
        } else if (input.op === "fail") {
          delivery = await store.failDelivery({
            id: input.id,
            owner,
            error: "fixture failure",
            retryable: input.retryable,
            backoffMs: 25,
          });
        } else throw new Error("unknown fixture operation");
        if (!delivery) return { changed: false };
        await mark(ctx, "delivery.operation");
        return {
          changed: true,
          id: delivery.id,
          status: delivery.status,
          attempts: delivery.attempts,
          updatedAt: delivery.updatedAt,
          leaseExpiresAt: delivery.leaseExpiresAt ?? null,
          availableAt: delivery.availableAt,
        };
      },
    },
  });
  await boundary.acquire(0);
  const source = await db.transaction((tx) => seed(tx));
  const id = source.deliveries[0].id;
  const call = (
    key: string,
    op: string,
    extra: Record<string, OwnerJson> = {},
  ) =>
    boundary.execute({
      principal: { kind: "worker" as const, workerId: "worker" },
      ownerEpoch: 1,
      dispatchAttemptId: state.attempt,
    }, {
      kind: "delivery",
      domain: "incarnation",
      key,
      intent: { id, op, ...extra },
    });
  return {
    db,
    boundary,
    id,
    source,
    state,
    gate,
    call,
    async close() {
      gate.release.resolve();
      boundary.stop();
      await db.close();
    },
  };
}

test("owner claim and settlement roll back with receipt/event/alarm; replay changes nothing", async () => {
  const f = await createFixture();
  try {
    for (const [index, op] of ["claim", "succeed"].entries()) {
      f.state.time = at(index * 100);
      const before = await snapshot(f.db);
      f.state.rejectRelease = true;
      await assert.rejects(
        f.call(`${op}:rollback`, op),
        /rollback fixture/,
      );
      assert.equal(
        f.state.rollbackSnapshot?.receipts.length,
        before.receipts.length + 1,
      );
      assert.ok(f.state.rollbackSnapshot!.events.length > before.events.length);
      assert.ok(f.state.rollbackSnapshot!.alarms.length > before.alarms.length);
      assert.deepEqual(await snapshot(f.db), before);
      assert.equal(f.state.publications.length, 0);
      const first = await f.call(op, op);
      assert.equal(first.status, "committed");
      const committed = await snapshot(f.db);
      const calls = f.state.handlerCalls;
      assert.deepEqual(await f.call(op, op), { ...first, status: "duplicate" });
      assert.equal(f.state.handlerCalls, calls);
      assert.deepEqual(await snapshot(f.db), committed);
      f.state.authorized = false;
      await assert.rejects(f.call(op, op), /current assignment revoked/);
      f.state.authorized = true;
      assert.deepEqual(await snapshot(f.db), committed);
    }
    await within(f.state.published.promise);
    assert.deepEqual(f.state.publications, [{
      key: "succeed",
      receipts: 1,
      terminals: 1,
      gated: false,
    }]);
    assert.deepEqual(f.state.publicationErrors, []);
    const settled = await createEventStore({ session: f.db }).getDelivery(f.id);
    assert.equal(settled?.status, "succeeded");
    assert.equal(settled?.attempts, 1);
    assert.equal(settled?.settledAt, at(100));
    for (
      const read of [
        () => f.state.lastStore!.getDelivery(f.id),
        () => f.state.lastStore!.getEvent(f.source.event.id),
        () => f.state.lastStore!.session.query("SELECT 1"),
      ]
    ) await assert.rejects(read, { code: "owner_command_closed" });
  } finally {
    await f.close();
  }
});

test("injected outer rollback discards delivery transitions, receipts, events, alarms and publication", async () => {
  const f = await createFixture();
  try {
    const before = await snapshot(f.db);
    f.state.rejectOuter = true;
    const results = await Promise.allSettled([
      f.call("claim", "claim"),
      f.call("succeed", "succeed"),
    ]);
    assert.equal(f.state.rollbackSnapshot?.receipts.length, 2);
    assert.equal(f.state.rollbackSnapshot?.deliveries[0].status, "succeeded");
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "owner_commit_unknown");
    }
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(f.state.publications.length, 0);
    assert.equal(f.boundary.state, "stopped");
  } finally {
    await f.close();
  }
});

test("owner delivery settlement output and callbacks wait for the outer commit", async () => {
  const f = await createFixture();
  try {
    await f.call("claim", "claim");
    f.state.time = at(100);
    f.gate.enabled = true;
    let output = false;
    const settling = f.call("succeed", "succeed").then((value) => {
      output = true;
      return value;
    });
    await within(f.gate.reached.promise);
    assert.equal(output, false);
    assert.equal(f.gate.held, true);
    assert.equal(f.state.publications.length, 0);
    f.gate.release.resolve();
    assert.equal((await settling).status, "committed");
    await within(f.state.published.promise);
    assert.deepEqual(f.state.publications, [{
      key: "succeed",
      receipts: 1,
      terminals: 1,
      gated: false,
    }]);
    assert.equal((await f.call("succeed", "succeed")).status, "duplicate");
    assert.equal(f.state.publications.length, 1);
  } finally {
    await f.close();
  }
});

test("owner attempts do not expire; exact tokens and stale epochs fence mutations", async () => {
  const f = await createFixture();
  try {
    await f.db.transaction(async (tx) => {
      const store = (time: number, token = "attempt-old", epoch = 1) =>
        createEventStore({
          session: unavailable,
          ownerCommit: {
            ...context(tx, at(time)),
            epoch,
            afterCommit() {},
            ownerAttempt: { deliveryId: f.id, attemptId: token },
          },
        });
      assert.equal(
        (await store(0).claimDelivery({ id: f.id, owner: "attempt-old" }))
          ?.attempts,
        1,
      );
      assert.equal(
        (await store(120_000).getDelivery(f.id))?.leaseExpiresAt,
        undefined,
      );
      assert.equal(
        await store(120_000, "attempt-new").claimDelivery({
          id: f.id,
          owner: "attempt-new",
        }),
        null,
        "elapsed time cannot reclaim running work",
      );
      const before = await snapshot(tx);
      await assert.rejects(
        store(120_000).heartbeatDelivery({ id: f.id, owner: "attempt-old" }),
        /does not support/,
      );
      await assert.rejects(
        store(120_000).claimNext({ owner: "attempt-old" }),
        /does not support/,
      );
      await assert.rejects(
        store(120_000).succeedDelivery(f.id, "attempt-new"),
        /different owner delivery attempt/,
      );
      await assert.rejects(
        store(120_000, "attempt-old", 0).succeedDelivery(f.id, "attempt-old"),
        { code: "ActionOwnershipLost" },
      );
      assert.deepEqual(await snapshot(tx), before);
      assert.equal(
        (await store(120_000).succeedDelivery(f.id, "attempt-old"))?.status,
        "succeeded",
      );
    });
  } finally {
    await f.close();
  }
});

test("owner failure retry and dead letter share command timestamps and deferred settlement", async () => {
  const f = await createFixture();
  try {
    await f.call("claim", "claim");
    f.state.time = at(100);
    const retry = await f.call("retry", "fail");
    assert.equal((retry.result as { status: string }).status, "retry_wait");
    assert.equal(
      (retry.result as { availableAt: string }).availableAt,
      at(125),
    );
    assert.equal(f.state.publications.length, 0);
    f.state.time = at(125);
    f.state.attempt = "attempt-2";
    assert.equal(
      ((await f.call("reclaim", "claim")).result as { attempts: number })
        .attempts,
      2,
    );
    const terminal = await f.call("dead-letter", "fail", { retryable: false });
    assert.equal((terminal.result as { status: string }).status, "dead_letter");
    assert.equal(
      (await f.call("dead-letter", "fail", { retryable: false })).status,
      "duplicate",
    );
    await within(f.state.published.promise);
    assert.deepEqual(f.state.publications, [{
      key: "dead-letter",
      receipts: 1,
      terminals: 1,
      gated: false,
    }]);
    assert.equal(
      (await createEventStore({ session: f.db }).getDelivery(f.id))?.status,
      "dead_letter",
    );
  } finally {
    await f.close();
  }
});

test("owner read helpers use their executor; unsupported delivery mutation paths fail closed", async () => {
  const f = await createFixture();
  try {
    await f.db.transaction(async (tx) => {
      let queries = 0;
      const transaction: SqlExecutor = {
        query(sql, params) {
          queries++;
          return tx.query(sql, params);
        },
      };
      const store = createEventStore({
        session: unavailable,
        ownerCommit: context(transaction),
      });
      assert.equal(
        (await store.getEvent(f.source.event.id))?.id,
        f.source.event.id,
      );
      assert.equal(
        (await store.getEventByDeduplicationId("space", "source"))?.id,
        f.source.event.id,
      );
      assert.equal((await store.listEvents({ namespace: "space" })).length, 1);
      assert.equal((await store.getDelivery(f.id))?.status, "pending");
      assert.equal((await store.listDeliveries({ ids: [f.id] })).length, 1);
      assert.equal((await store.listRecoverable()).length, 1);
      assert.equal(await store.nextRecoveryDelayMs(), 0);
      assert.equal(
        (await store.scopeSettlement("space", f.source.event.id)).unsettled,
        1,
      );
      assert.equal(
        (await store.scopeOutstanding("space", f.source.event.id)).unsettled,
        1,
      );
      assert.equal((await store.session.query("SELECT 1")).rows.length, 1);
      assert.equal(queries, 10);
      const before = queries;
      for (
        const mutate of [
          () => store.claimDelivery({ id: f.id, owner: "attempt" }),
          () => store.claimNext({ owner: "attempt" }),
          () => store.heartbeatDelivery({ id: f.id, owner: "attempt" }),
          () => store.succeedDelivery(f.id, "attempt"),
          () => store.cancelDelivery(f.id, "attempt"),
          () =>
            store.failDelivery({
              id: f.id,
              owner: "attempt",
              error: "failure",
            }),
          () => store.recoverExpiredDeliveries(),
          () => store.cancelScope("space", f.source.event.id),
          () => store.compactDeliveries(),
          () => store.compactDeliveries({ retentionMs: null }),
          () => store.listEvents({ namespace: "space" }, f.db),
          async () => {
            await store.session.transaction(() => Promise.resolve());
          },
        ]
      ) await assert.rejects(mutate, /does not support/);
      assert.equal(queries, before);
      const scheduled = createEventStore({
        session: unavailable,
        ownerCommit: { ...context(transaction), afterCommit() {} },
      });
      await assert.rejects(scheduled.cancelDelivery(f.id), /attempt token/);
      await assert.rejects(
        scheduled.claimDelivery({ id: f.id, owner: "" }),
        /exact owner attempt/,
      );
      assert.equal(queries, before);
    });
  } finally {
    await f.close();
  }
});
