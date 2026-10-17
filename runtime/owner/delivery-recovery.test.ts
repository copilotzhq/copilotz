import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createEventStore,
  type EventStore,
  type OwnerEventCommitContext,
} from "../events/store.ts";
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
function context(
  transaction: SqlExecutor,
  commandTime = start,
): OwnerEventCommitContext {
  return {
    transaction,
    commandTime,
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    afterCommit() {
      throw new Error("seed must not publish");
    },
  };
}
async function snapshot(db: SqlExecutor) {
  return {
    deliveries: (await db.query("SELECT * FROM event_deliveries ORDER BY id"))
      .rows,
    events: (await db.query("SELECT * FROM events ORDER BY position")).rows,
    bodies:
      (await db.query("SELECT * FROM event_bodies ORDER BY event_body_id"))
        .rows,
    receipts: (await db.query("SELECT * FROM owner_receipts ORDER BY key"))
      .rows,
    readers: (await db.query(
      "SELECT * FROM owner_receipt_readers ORDER BY owner,domain,key,principal_kind,principal_id",
    )).rows,
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
    time: at(100),
    clockReads: 0,
    authorized: true,
    rejectRelease: false,
    rejectOuter: false,
    loseCommitReply: false,
    advanceClockOnLock: false,
    rollbackSnapshot: undefined as
      | Awaited<ReturnType<typeof snapshot>>
      | undefined,
    handlerCalls: 0,
    settlementCalls: 0,
    lastStore: undefined as EventStore | undefined,
    statements: [] as string[],
    recoveryLimits: [] as unknown[],
    publications: [] as {
      key: string;
      id: string;
      receipts: number;
      terminals: number;
      gated: boolean;
    }[],
    publicationErrors: [] as unknown[],
    publicationFailure: deferred(),
    failPublicationAt: 0,
    published: deferred(),
    publicationTarget: 1,
  };
  const session: SqlSession = {
    query: db.query,
    async transaction(operation) {
      let gated = false;
      const result = await db.transaction(async (tx) => {
        const value = await operation({
          async query(sql, params) {
            state.statements.push(sql);
            if (sql.includes("d.attempts >= d.max_attempts")) {
              state.recoveryLimits.push(params?.[1]);
            }
            if (
              state.rejectRelease && sql === "RELEASE SAVEPOINT owner_command_0"
            ) {
              state.rejectRelease = false;
              state.rollbackSnapshot = await snapshot(tx);
              throw new Error("recovery rollback after receipt insertion");
            }
            return await tx.query(sql, params);
          },
        });
        if (state.rejectOuter) {
          state.rejectOuter = false;
          state.rollbackSnapshot = await snapshot(tx);
          throw new Error("recovery outer rollback before commit");
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
      if (state.loseCommitReply) {
        state.loseCommitReply = false;
        throw new Error("lost COMMIT reply after durable recovery");
      }
      return result;
    },
  };
  const targets = new Map<
    string,
    Parameters<EventStore["recoverLostDelivery"]>[0]
  >();
  const recover = async (intent: OwnerJson, ctx: OwnerCommandContext) => {
    state.handlerCalls++;
    const store = createEventStore({
      session: unavailable,
      ownerCommit: { ...ctx.ownerCommit, afterCommit: ctx.afterCommit },
      now() {
        throw new Error("recovery must use the captured command timestamp");
      },
      lockSettlementScope(tx, scope) {
        assert.equal(tx, ctx.tx);
        assert.ok(scope);
        if (state.advanceClockOnLock) state.time = at(1000);
        return Promise.resolve();
      },
      async settleActionOwners(tx, delivery) {
        assert.equal(tx, ctx.tx);
        state.settlementCalls++;
        await store.commitMutation({
          transaction: tx,
          draft: {
            type: "recovery.terminal",
            namespace: "space",
            payload: {},
            deduplicationId: `${ctx.command.key}:${delivery.id}`,
          },
          body: {
            id: `terminal-body:${ctx.command.key}:${delivery.id}`,
            json: { status: "failed" },
          },
          consumers: [],
        });
        await tx.query(
          "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,$2)",
          [`${ctx.command.key}:${delivery.id}`, ctx.commandTime],
        );
        const key = ctx.command.key;
        return async () => {
          state.publications.push({
            key,
            id: delivery.id,
            receipts: (await db.query(
              "SELECT key FROM owner_receipts WHERE key=$1",
              [key],
            )).rows.length,
            terminals: (await db.query(
              "SELECT id FROM events WHERE deduplication_id=$1",
              [`${key}:${delivery.id}`],
            )).rows.length,
            gated: gate.held,
          });
          if (state.publications.length >= state.publicationTarget) {
            state.published.resolve();
          }
          if (state.publications.length === state.failPublicationAt) {
            throw new Error("injected publication failure");
          }
        };
      },
    });
    state.lastStore = store;
    const ids = (intent as { targetIds: string[] }).targetIds;
    assert.ok(
      Array.isArray(ids) && ids.length <= 16,
      "bounded explicit targets required",
    );
    const recovered = [];
    for (const id of ids) {
      const target = targets.get(id);
      assert.ok(target, "unconfigured recovery target");
      const result = await store.recoverLostDelivery({ ...target });
      if (result) recovered.push(result);
    }
    return recovered.map((delivery) => ({
      id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      updatedAt: delivery.updatedAt,
      settledAt: delivery.settledAt ?? null,
    }));
  };
  const boundary = createOwnerCommandBoundary({
    session,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => {
      state.clockReads++;
      return state.time;
    },
    authorize(_tx, caller) {
      assert.equal(
        state.authorized,
        true,
        "current recovery authority revoked",
      );
      assert.equal(
        caller.principal.kind === "worker"
          ? caller.principal.workerId
          : undefined,
        "owner-host",
      );
    },
    authenticateReceipt(_tx, caller) {
      assert.equal(
        caller.principal.kind === "worker"
          ? caller.principal.workerId
          : undefined,
        "owner-host",
      );
    },
    handlers: { recover },
    onPostCommitError(error) {
      state.publicationErrors.push(error);
      state.publicationFailure.resolve();
    },
  });
  await boundary.acquire(0);
  async function seed(
    key: string,
    options: { expires?: number; maxAttempts?: number; namespace?: string } =
      {},
  ) {
    return await db.transaction(async (tx) => {
      const store = createEventStore({
        session: unavailable,
        ownerCommit: context(tx),
      });
      const source = await store.commitMutation({
        transaction: tx,
        draft: {
          type: "source",
          namespace: options.namespace ?? "space",
          payload: {},
          deduplicationId: key,
        },
        consumers: [{ consumerId: "consumer", settlement: "inherit" }],
        maxAttempts: options.maxAttempts ?? 1,
      });
      const id = source.deliveries[0].id;
      const claimed = await createEventStore({
        session: unavailable,
        ownerCommit: {
          ...context(tx),
          ownerAttempt: { deliveryId: id, attemptId: `${key}:attempt-1` },
        },
      }).claimDelivery({ id, owner: `${key}:attempt-1` });
      assert.ok(claimed);
      targets.set(id, {
        namespace: options.namespace ?? "space",
        id,
        eventId: claimed.eventId,
        consumerId: claimed.consumerId,
        settlementScopeId: claimed.settlementScopeId,
        ...(claimed.actionScopeId
          ? { actionScopeId: claimed.actionScopeId }
          : {}),
        leaseOwner: claimed.leaseOwner!,
        leaseExpiresAt: null,
        attempts: claimed.attempts,
        maxAttempts: claimed.maxAttempts,
        disposition: claimed.attempts < claimed.maxAttempts
          ? "retry"
          : "exhausted",
      });
      return id;
    });
  }
  const call = (key: string, intent: OwnerJson = {}) =>
    boundary.execute({
      principal: { kind: "worker" as const, workerId: "owner-host" },
      ownerEpoch: 1,
    }, {
      kind: "recover",
      domain: "occurrence",
      key,
      intent: {
        ...intent as object,
        targetIds: (intent as { targetIds?: string[] }).targetIds ??
          [...targets.keys()],
      },
    });
  return {
    db,
    boundary,
    state,
    gate,
    seed,
    targets,
    call,
    async close() {
      gate.release.resolve();
      boundary.stop();
      await db.close();
    },
  };
}

test("owner exact recovery preserves captured time, retry eligibility and untargeted work", async () => {
  const f = await createFixture();
  try {
    f.state.publicationTarget = 1;
    const target = await f.seed("target"),
      retry = await f.seed("retry", { maxAttempts: 2 }),
      other = await f.seed("other", { namespace: "elsewhere" });
    const reads = createEventStore({ session: f.db });
    const beforeOther = await reads.getDelivery(other),
      beforeRetry = await reads.getDelivery(retry);
    f.state.advanceClockOnLock = true;
    const result = await f.call("exact", { targetIds: [target] });
    assert.deepEqual(result.result, [{
      id: target,
      status: "dead_letter",
      attempts: 1,
      updatedAt: at(100),
      settledAt: at(100),
    }]);
    assert.equal(f.state.clockReads, 1);
    assert.equal(f.state.time, at(1000));
    const body = (await snapshot(f.db)).bodies[0];
    assert.equal(
      (body.created_at instanceof Date
        ? body.created_at
        : new Date(String(body.created_at))).toISOString(),
      at(100),
    );
    assert.equal(
      f.state.statements.some((sql) => /\bNOW\s*\(/i.test(sql)),
      false,
    );
    assert.deepEqual(await reads.getDelivery(other), beforeOther);
    assert.deepEqual(await reads.getDelivery(retry), beforeRetry);
    assert.equal((await reads.getDelivery(other))?.status, "leased");
    assert.equal((await reads.getDelivery(retry))?.status, "leased");
    assert.equal(
      (await reads.getDelivery(target))?.lastError?.name,
      "AttemptLost",
    );
    f.state.time = at(100);
    await f.call("requeue", { targetIds: [retry] });
    const requeued = await reads.getDelivery(retry);
    assert.equal(requeued?.status, "retry_wait");
    assert.equal(requeued?.attempts, 1);
    assert.equal(requeued?.availableAt, beforeRetry?.availableAt);
    assert.deepEqual(await reads.getDelivery(other), beforeOther);
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: unavailable,
        ownerCommit: {
          ...context(tx, at(100)),
          afterCommit() {},
          ownerAttempt: { deliveryId: retry, attemptId: "retry:attempt-2" },
        },
      });
      const claimed = await store.claimDelivery({
        id: retry,
        owner: "retry:attempt-2",
      });
      assert.equal(claimed?.attempts, 2);
      assert.equal(claimed?.leaseExpiresAt, undefined);
      await assert.rejects(store.succeedDelivery(retry, "retry:attempt-1"));
    });
    await within(f.state.published.promise);
    assert.equal(f.state.publications.length, 1);
  } finally {
    await f.close();
  }
});

test("owner recovery replays receipts without repeated transitions or publication", async () => {
  const f = await createFixture();
  try {
    const id = await f.seed("final");
    const first = await f.call("recover");
    await within(f.state.published.promise);
    const committed = await snapshot(f.db);
    assert.deepEqual(await f.call("recover"), {
      ...first,
      status: "duplicate",
    });
    assert.equal(f.state.handlerCalls, 1);
    assert.equal(f.state.settlementCalls, 1);
    assert.deepEqual(await snapshot(f.db), committed);
    assert.deepEqual(f.state.publications, [{
      key: "recover",
      id,
      receipts: 1,
      terminals: 1,
      gated: false,
    }]);
    f.state.authorized = false;
    await assert.rejects(
      f.call("recover"),
      /current recovery authority revoked/,
    );
    f.state.authorized = true;
    await assert.rejects(f.call("recover", { limit: 1 }), {
      code: "owner_intent_conflict",
    });
    assert.deepEqual((await f.call("scan-again")).result, []);
    assert.equal(f.state.settlementCalls, 1);
    assert.equal(f.state.publications.length, 1);
    assert.deepEqual(f.state.publicationErrors, []);
    await assert.rejects(
      () => f.state.lastStore!.recoverLostDelivery(f.targets.get(id)!),
      {
        code: "owner_command_closed",
      },
    );
  } finally {
    await f.close();
  }
});

test("owner recovery rollback includes delivery, receipt, terminal event, alarm and sequence", async () => {
  const f = await createFixture();
  try {
    await f.seed("final");
    const before = await snapshot(f.db);
    f.state.rejectRelease = true;
    await assert.rejects(f.call("rolled-back"), /recovery rollback/);
    assert.equal(f.state.rollbackSnapshot?.receipts.length, 1);
    assert.equal(f.state.rollbackSnapshot?.readers.length, 1);
    assert.equal(f.state.rollbackSnapshot?.deliveries[0].status, "dead_letter");
    assert.equal(f.state.rollbackSnapshot?.events.length, 2);
    assert.equal(f.state.rollbackSnapshot?.bodies.length, 1);
    assert.equal(f.state.rollbackSnapshot?.alarms.length, 1);
    assert.deepEqual(await snapshot(f.db), before);
    assert.equal(f.state.publications.length, 0);
    assert.equal((await f.call("rolled-back")).status, "committed");
    await within(f.state.published.promise);
    const after = await snapshot(f.db);
    assert.deepEqual(after.events.map((event) => Number(event.seq)), [1, 2]);
    assert.equal(after.receipts.length, 1);
    assert.equal(after.alarms.length, 1);
    assert.equal(f.state.publications.length, 1);
  } finally {
    await f.close();
  }
});

test("owner recovery output and settlement publication wait for the outer commit", async () => {
  const f = await createFixture();
  try {
    const id = await f.seed("final");
    f.gate.enabled = true;
    let returned = false;
    const recovering = f.call("recover").then((value) => {
      returned = true;
      return value;
    });
    await within(f.gate.reached.promise);
    assert.equal(returned, false);
    assert.equal(f.state.settlementCalls, 1);
    assert.equal(f.state.publications.length, 0);
    f.gate.release.resolve();
    assert.equal((await recovering).status, "committed");
    await within(f.state.published.promise);
    assert.deepEqual(f.state.publications, [{
      key: "recover",
      id,
      receipts: 1,
      terminals: 1,
      gated: false,
    }]);
  } finally {
    await f.close();
  }
});

test("owner recovery requires the current locking fence and publication boundary", async () => {
  const f = await createFixture();
  try {
    const targetId = await f.seed("final");
    const before = await snapshot(f.db);
    await f.db.transaction(async (tx) => {
      const statements: string[] = [];
      const transaction: SqlExecutor = {
        query(sql, params) {
          statements.push(sql);
          return tx.query(sql, params);
        },
      };
      const authority = context(transaction, at(100));
      const missingPublication = createEventStore({
        session: unavailable,
        ownerCommit: { ...authority, afterCommit: undefined },
        lockSettlementScope: () => Promise.resolve(),
        settleActionOwners: () => Promise.resolve(),
      });
      await assert.rejects(
        () => missingPublication.recoverLostDelivery(f.targets.get(targetId)!),
        /without afterCommit/,
      );
      assert.equal(statements.length, 0);
      for (const stale of [{ epoch: 0 }, { holderId: "old-holder" }]) {
        const store = createEventStore({
          session: unavailable,
          ownerCommit: { ...authority, ...stale },
          lockSettlementScope: () => Promise.resolve(),
          settleActionOwners: () => Promise.resolve(),
        });
        await assert.rejects(
          () => store.recoverLostDelivery(f.targets.get(targetId)!),
          {
            code: "ActionOwnershipLost",
          },
        );
      }
      assert.equal(statements.length, 2);
      for (const sql of statements) {
        assert.ok(sql.includes("owner_epochs"));
        assert.ok(sql.includes("FOR UPDATE"));
      }
    });
    assert.deepEqual(await snapshot(f.db), before);
    await f.db.query(
      "UPDATE owner_epochs SET epoch=2,holder='successor' WHERE owner='owner'",
    );
    await assert.rejects(f.call("stale"), { code: "ActionOwnershipLost" });
    assert.equal(f.state.handlerCalls, 0);
    assert.equal(f.state.publications.length, 0);
  } finally {
    await f.close();
  }
});

for (const committed of [false, true]) {
  test(`owner recovery unknown ${committed ? "committed" : "aborted"} outcome stops holder without replay`, async () => {
    const f = await createFixture();
    try {
      await f.seed("final");
      const before = await snapshot(f.db);
      if (committed) f.state.loseCommitReply = true;
      else f.state.rejectOuter = true;
      await assert.rejects(f.call("uncertain"), {
        code: "owner_commit_unknown",
      });
      assert.equal(f.state.handlerCalls, 1);
      assert.equal(f.state.settlementCalls, 1);
      assert.equal(f.state.publications.length, 0);
      assert.equal(f.boundary.state, "stopped");
      await assert.rejects(f.call("uncertain"), {
        code: "owner_commit_unknown",
      });
      assert.equal(f.state.handlerCalls, 1);
      const after = await snapshot(f.db);
      if (committed) {
        assert.equal(after.deliveries[0].status, "dead_letter");
        assert.equal(after.receipts.length, 1);
        assert.equal(after.events.length, 2);
        assert.equal(after.alarms.length, 1);
      } else assert.deepEqual(after, before);
    } finally {
      await f.close();
    }
  });
}

for (const failFirst of [false, true]) {
  test(`twenty explicit owner recovery commands preserve ordered publication with failure=${failFirst}`, async () => {
    const f = await createFixture();
    try {
      const ids: string[] = [];
      f.state.publicationTarget = 20;
      f.state.failPublicationAt = failFirst ? 1 : 0;
      for (let i = 0; i < 20; i++) ids.push(await f.seed(`batch:${i}`));
      const results = await Promise.all(
        ids.map((id, i) => f.call(`recover:${i}`, { targetIds: [id] })),
      );
      assert.ok(results.every((r) => r.status === "committed"));
      await within(f.state.published.promise);
      assert.deepEqual(f.state.publications.map((p) => p.id), ids);
      assert.ok(
        f.state.publications.every((p) => p.receipts === 1 && !p.gated),
      );
      if (failFirst) await within(f.state.publicationFailure.promise);
      assert.equal(f.state.publicationErrors.length, failFirst ? 1 : 0);
      assert.equal((await snapshot(f.db)).receipts.length, 20);
      assert.equal(
        (await f.call("recover:0", { targetIds: [ids[0]] })).status,
        "duplicate",
      );
      assert.equal(f.state.settlementCalls, 20);
      assert.equal(f.state.publications.length, 20);
    } finally {
      await f.close();
    }
  });
}

test("owner recovery publication failure leaves commit durable and attempts later callbacks", async () => {
  const f = await createFixture();
  try {
    const first = await f.seed("first", { expires: 1 });
    const second = await f.seed("second", { expires: 2 });
    f.state.publicationTarget = 2;
    f.state.failPublicationAt = 1;
    assert.equal((await f.call("recover")).status, "committed");
    await within(f.state.published.promise);
    await within(f.state.publicationFailure.promise);
    assert.deepEqual(f.state.publications.map((p) => p.id), [first, second]);
    assert.equal(f.state.publicationErrors.length, 1);
    const error = f.state.publicationErrors[0];
    assert.ok(error instanceof Error);
    assert.match(error.message, /injected publication failure/);
    const committed = await snapshot(f.db);
    assert.ok(committed.deliveries.every((d) => d.status === "dead_letter"));
    assert.equal(committed.receipts.length, 1);
    assert.equal(committed.alarms.length, 2);
    assert.equal(committed.bodies.length, 2);
    assert.equal((await f.call("recover")).status, "duplicate");
    assert.deepEqual(await snapshot(f.db), committed);
    assert.equal(f.state.publications.length, 2);
  } finally {
    await f.close();
  }
});
