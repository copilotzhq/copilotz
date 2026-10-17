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
  const seed = createEventStore({ session: db });
  const event = await seed.append({
    type: "seed",
    namespace: "space",
    payload: {},
  }, ["processor:test"]);
  const delivery = (await seed.listDeliveries({ eventId: event.event.id }))[0];
  await db.query(
    "CREATE TABLE owner_epochs (owner TEXT PRIMARY KEY, epoch BIGINT NOT NULL, holder TEXT NOT NULL, last_seq BIGINT NOT NULL)",
  );
  await db.query("INSERT INTO owner_epochs VALUES ('owner',1,'holder',0)");
  await db.query(
    "ALTER TABLE events ADD COLUMN owner_id TEXT, ADD COLUMN seq BIGINT",
  );
  await db.query("CREATE UNIQUE INDEX local_event_seq ON events(owner_id,seq)");
  const context = (transaction: SqlExecutor): OwnerEventCommitContext => ({
    transaction,
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    commandTime: "2199-01-01T00:00:00.000Z",
    ownerAttempt: { deliveryId: delivery.id, attemptId: "local" },
    afterCommit() {},
  });
  await db.transaction(async (tx) => {
    await createEventStore({ session: db, ownerCommit: context(tx) })
      .claimDelivery({ id: delivery.id, owner: "local" });
  });
  const draft = (key: string) => ({
    type: "local.changed",
    namespace: "space",
    payload: {},
    deduplicationId: key,
    deliveryLease: { deliveryId: delivery.id, owner: "local" },
  });
  return { db, delivery, context, draft };
}

test("local mutation uses exact epoch attempt without clock expiry and rolls back event sequence", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx),
      });
      const one = await store.commitMutation({
        transaction: tx,
        draft: f.draft("one"),
        consumers: [],
        body: { id: "local-body", json: { value: "one" } },
      });
      assert.equal(one.event.seq, "1");
      const duplicate = await store.commitMutation({
        transaction: tx,
        draft: f.draft("one"),
        consumers: [],
        body: { id: "local-body", json: { value: "one" } },
      });
      assert.equal(duplicate.deduplicated, true);
      await tx.query("SAVEPOINT local_mutation");
      await store.commitMutation({
        transaction: tx,
        draft: f.draft("discard"),
        consumers: [],
      });
      await tx.query("ROLLBACK TO SAVEPOINT local_mutation");
      const two = await store.commitMutation({
        transaction: tx,
        draft: f.draft("two"),
        consumers: [],
      });
      assert.equal(two.event.seq, "2");
    });
    assert.equal(
      String(
        (await f.db.query("SELECT last_seq FROM owner_epochs")).rows[0]
          .last_seq,
      ),
      "2",
    );
    assert.equal(
      (await f.db.query(
        "SELECT 1 FROM events WHERE deduplication_id='discard'",
      )).rows.length,
      0,
    );
  } finally {
    await f.db.close();
  }
});

test("local mutation refuses missing, substituted and stale authority before callbacks or duplicate recovery", async () => {
  const f = await fixture();
  try {
    let callbacks = 0;
    await f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: f.context(tx),
      });
      for (
        const lease of [undefined, { deliveryId: "other", owner: "local" }, {
          deliveryId: f.delivery.id,
          owner: "other",
        }]
      ) {
        await assert.rejects(
          store.commitMutation({
            transaction: tx,
            draft: { ...f.draft("bad"), deliveryLease: lease },
            consumers: [],
            mutate: () => {
              callbacks++;
              return Promise.resolve();
            },
          }),
        );
      }
      assert.equal(callbacks, 0);
      await store.commitMutation({
        transaction: tx,
        draft: f.draft("known"),
        consumers: [],
      });
      await tx.query(
        "UPDATE event_deliveries SET lease_owner='replacement' WHERE id=$1",
        [f.delivery.id],
      );
      await assert.rejects(
        store.commitMutation({
          transaction: tx,
          draft: f.draft("known"),
          consumers: [],
          recoverDuplicate: () => {
            callbacks++;
            return Promise.resolve();
          },
        }),
      );
      assert.equal(callbacks, 0);
    });
    await assert.rejects(f.db.transaction(async (tx) => {
      const store = createEventStore({
        session: f.db,
        ownerCommit: { ...f.context(tx), epoch: 0 },
      });
      await store.commitMutation({
        transaction: tx,
        draft: f.draft("stale"),
        consumers: [],
        mutate: () => {
          callbacks++;
          return Promise.resolve();
        },
      });
    }));
    assert.equal(callbacks, 0);
  } finally {
    await f.db.close();
  }
});

test("worker event gate refuses NULL deadline while owner control retains ordinary admission", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const { ownerAttempt: _, ...ownerCommit } = f.context(tx);
      const store = createEventStore({ session: f.db, ownerCommit });
      let calls = 0;
      await assert.rejects(
        store.commitMutation({
          transaction: tx,
          draft: f.draft("worker-null"),
          consumers: [],
          mutate: () => {
            calls++;
            return Promise.resolve();
          },
        }),
      );
      assert.equal(calls, 0);
      const result = await store.commitMutation({
        transaction: tx,
        draft: { ...f.draft("control"), deliveryLease: undefined },
        consumers: [],
      });
      assert.equal(result.event.seq, "1");
    });
  } finally {
    await f.db.close();
  }
});
