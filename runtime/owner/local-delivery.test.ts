import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import {
  createEventStore,
  type OwnerEventCommitContext,
} from "../events/store.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  const legacy = createEventStore({ session: db });
  const event = await legacy.append({
    type: "local.test",
    namespace: "space",
    payload: {},
  }, ["processor:test"]);
  const delivery =
    (await legacy.listDeliveries({ eventId: event.event.id }))[0];
  await db.query(
    "CREATE TABLE owner_epochs (owner TEXT PRIMARY KEY, epoch BIGINT NOT NULL, holder TEXT NOT NULL)",
  );
  await db.query("INSERT INTO owner_epochs VALUES ('owner',1,'holder')");
  const context = (
    tx: SqlExecutor,
    time = "2099-01-01T00:00:00.000Z",
  ): OwnerEventCommitContext & {
    localAttempt: { deliveryId: string; attemptId: string };
  } => ({
    transaction: tx,
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    commandTime: time,
    localAttempt: { deliveryId: delivery.id, attemptId: "local-attempt" },
    afterCommit() {},
  });
  return { db, delivery, context };
}

test("local owner delivery has no clock lease and settles after arbitrary clock advance", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx),
      });
      const claimed = await store.claimDelivery({
        id: f.delivery.id,
        owner: "local-attempt",
      });
      assert.equal(claimed?.status, "leased");
      assert.equal(claimed?.leaseExpiresAt, undefined);
      assert.equal(claimed?.attempts, 1);
      await assert.rejects(
        store.heartbeatDelivery({ id: f.delivery.id, owner: "local-attempt" }),
      );
    });
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx, "2199-01-01T00:00:00.000Z"),
      });
      assert.equal(
        (await store.succeedDelivery(f.delivery.id, "local-attempt"))?.status,
        "succeeded",
      );
    });
  } finally {
    await f.db.close();
  }
});

test("local delivery authority is exact and private; generic mutation paths stay closed", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const supplied = f.context(tx);
      const store = createEventStore({ session: f.db, ownerCommit: supplied });
      supplied.localAttempt.deliveryId = "changed";
      supplied.localAttempt.attemptId = "changed";
      await assert.rejects(
        store.claimDelivery({ id: "other", owner: "local-attempt" }),
      );
      await assert.rejects(
        store.claimDelivery({ id: f.delivery.id, owner: "other" }),
      );
      await assert.rejects(store.claimNext({ owner: "local-attempt" }));
      await assert.rejects(store.recoverExpiredDeliveries());
      await assert.rejects(
        store.cancelScope("space", f.delivery.settlementScopeId),
      );
      assert.equal(
        (await store.claimDelivery({
          id: f.delivery.id,
          owner: "local-attempt",
        }))?.attempts,
        1,
      );
      await assert.rejects(store.succeedDelivery(f.delivery.id, "other"));
      await assert.rejects(store.cancelDelivery("other", "local-attempt"));
      assert.equal(
        (await store.cancelDelivery(f.delivery.id, "local-attempt"))?.status,
        "cancelled",
      );
    });
  } finally {
    await f.db.close();
  }
});

test("local delivery refuses stale owner fences and never converts a worker lease", async () => {
  const f = await fixture();
  try {
    for (const overrides of [{ epoch: 0 }, { holderId: "other" }]) {
      await assert.rejects(
        f.db.transaction(async (tx) => {
          const store = createEventStore({
            session: f.db,
            ownerCommit: { ...f.context(tx), ...overrides },
          });
          await store.claimDelivery({
            id: f.delivery.id,
            owner: "local-attempt",
          });
        }),
        { code: "ActionOwnershipLost" },
      );
    }
    await f.db.transaction(async (tx) => {
      const { localAttempt: _, ...ownerCommit } = f.context(tx);
      const worker = createEventStore({ session: f.db, ownerCommit });
      assert.equal(
        (await worker.claimDelivery({
          id: f.delivery.id,
          owner: "worker-attempt",
        }))?.attempts,
        1,
      );
      const local = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx),
      });
      assert.equal(
        await local.claimDelivery({
          id: f.delivery.id,
          owner: "local-attempt",
        }),
        null,
      );
      await tx.query(
        "UPDATE event_deliveries SET lease_expires_at='2000-01-01'",
      );
      assert.equal(
        await local.claimDelivery({
          id: f.delivery.id,
          owner: "local-attempt",
        }),
        null,
      );
    });
  } finally {
    await f.db.close();
  }
});

test("a NULL worker deadline is never local authority and local failure remains transactional", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx),
      });
      await store.claimDelivery({ id: f.delivery.id, owner: "local-attempt" });
      const { localAttempt: _, ...ownerCommit } = f.context(tx);
      const worker = createEventStore({ session: f.db, ownerCommit });
      assert.equal(
        await worker.succeedDelivery(f.delivery.id, "local-attempt"),
        null,
      );
      assert.equal(
        await worker.heartbeatDelivery({
          id: f.delivery.id,
          owner: "local-attempt",
        }),
        false,
      );
      assert.equal(
        await worker.failDelivery({
          id: f.delivery.id,
          owner: "local-attempt",
          error: new Error("worker"),
        }),
        null,
      );
    });
    await assert.rejects(
      f.db.transaction(async (tx) => {
        const store = createEventStore({
          session: f.db,
          ownerCommit: f.context(tx, "2199-01-01T00:00:00.000Z"),
        });
        assert.equal(
          (await store.failDelivery({
            id: f.delivery.id,
            owner: "local-attempt",
            error: new Error("failed"),
            retryable: false,
          }))?.status,
          "dead_letter",
        );
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(
      (await f.db.query("SELECT status FROM event_deliveries")).rows[0].status,
      "leased",
    );
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx, "2199-01-01T00:00:00.000Z"),
      });
      assert.equal(
        (await store.failDelivery({
          id: f.delivery.id,
          owner: "local-attempt",
          error: new Error("failed"),
          retryable: false,
        }))?.status,
        "dead_letter",
      );
    });
  } finally {
    await f.db.close();
  }
});

test("local attempt configuration fails closed before touching storage", () => {
  const session = {
    query() {
      throw new Error("unexpected SQL");
    },
    transaction() {
      throw new Error("unexpected transaction");
    },
  };
  for (
    const localAttempt of [null, {}, { deliveryId: "x", attemptId: " " }, {
      deliveryId: "x",
      attemptId: "a",
      extra: true,
    }]
  ) {
    assert.throws(
      () =>
        createEventStore({
          session,
          ownerCommit: {
            transaction: session,
            ownerId: "owner",
            epoch: 1,
            holderId: "holder",
            commandTime: "2099-01-01",
            localAttempt,
          } as unknown as OwnerEventCommitContext,
        }),
      /Invalid owner-local/,
    );
  }
});
