import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import {
  createEventStore,
  type OwnerEventCommitContext,
} from "../events/store.ts";
import type { SqlExecutor } from "../events/session.ts";

async function fixture() {
  const db = await createTestDatabase();
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  // Explicit fresh fixture; existing schemas are not migrated by the runtime.
  await db.query(`CREATE TABLE owner_epochs (owner TEXT PRIMARY KEY,
    epoch BIGINT NOT NULL, holder TEXT NOT NULL, last_seq BIGINT NOT NULL)`);
  await db.query("INSERT INTO owner_epochs VALUES ('tenant', 1, 'host', 0)");
  await db.query(
    "ALTER TABLE events ADD COLUMN owner_id TEXT, ADD COLUMN seq BIGINT",
  );
  await db.query(
    "ALTER TABLE events ADD CHECK (owner_id IS NOT NULL AND seq IS NOT NULL)",
  );
  await db.query(
    "CREATE UNIQUE INDEX owner_event_sequence ON events(owner_id, seq)",
  );
  const context = (transaction: SqlExecutor): OwnerEventCommitContext => ({
    transaction,
    ownerId: "tenant",
    epoch: 1,
    holderId: "host",
    commandTime: "2026-10-16T00:00:00.000Z",
  });
  const write = (ownerCommit: OwnerEventCommitContext, key: string) =>
    createEventStore({ session: db, ownerCommit }).commitMutation({
      transaction: ownerCommit.transaction,
      draft: {
        type: "note.created",
        namespace: "space",
        payload: {},
        deduplicationId: key,
      },
      consumers: [],
    });
  return { db, context, write };
}

test("owner event sequence is inserted atomically; duplicates consume none", async () => {
  const { db, context, write } = await fixture();
  try {
    await db.transaction(async (tx) => {
      const one = await write(context(tx), "one");
      const duplicate = await write(context(tx), "one");
      const two = await write(context(tx), "two");
      assert.equal(one.event.seq, "1");
      assert.equal(one.event.ownerId, "tenant");
      assert.equal(duplicate.deduplicated, true);
      assert.equal(duplicate.event.seq, "1");
      assert.equal(two.event.seq, "2");
      assert.equal(two.event.createdAt, "2026-10-16T00:00:00.000Z");
    });
    assert.equal(
      String(
        (await db.query("SELECT last_seq FROM owner_epochs")).rows[0].last_seq,
      ),
      "2",
    );
    await assert.rejects(db.query("UPDATE events SET seq = 99"), /immutable/);
  } finally {
    await db.close();
  }
});

test("owner event counter rolls back with savepoint and outer transaction", async () => {
  const { db, context, write } = await fixture();
  try {
    await db.transaction(async (tx) => {
      await write(context(tx), "one");
      await tx.query("SAVEPOINT failed_command");
      await write(context(tx), "discarded");
      await tx.query("ROLLBACK TO SAVEPOINT failed_command");
      assert.equal((await write(context(tx), "two")).event.seq, "2");
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await write(context(tx), "outer-discarded");
        throw new Error("rollback outer");
      }),
      /rollback outer/,
    );
    await db.transaction(async (tx) =>
      assert.equal((await write(context(tx), "three")).event.seq, "3")
    );
    assert.equal((await db.query("SELECT id FROM events")).rows.length, 3);
  } finally {
    await db.close();
  }
});

test("owner event insertion rejects stale fence, unjoined writes and legacy writers", async () => {
  const { db, context, write } = await fixture();
  try {
    await assert.rejects(
      db.transaction((tx) => write({ ...context(tx), epoch: 0 }, "stale")),
      /not inserted/,
    );
    const store = createEventStore({ session: db, ownerCommit: context(db) });
    await assert.rejects(
      store.commitMutation({
        draft: { type: "x", namespace: "space", payload: {} },
        consumers: [],
      }),
      /join their command/,
    );
    await assert.rejects(
      createEventStore({ session: db }).commitMutation({
        draft: { type: "x", namespace: "space", payload: {} },
        consumers: [],
      }),
    );
    assert.equal((await db.query("SELECT id FROM events")).rows.length, 0);
    assert.equal(
      String(
        (await db.query("SELECT last_seq FROM owner_epochs")).rows[0].last_seq,
      ),
      "0",
    );
  } finally {
    await db.close();
  }
});

test("owner event allocation does not advance when statement admission refuses", async () => {
  const { db, context, write } = await fixture();
  try {
    await db.transaction(async (tx) => {
      const store = createEventStore({ session: db, ownerCommit: context(tx) });
      await assert.rejects(
        store.commitMutation({
          transaction: tx,
          draft: { type: "x", namespace: "space", payload: {} },
          consumers: [],
          statement: () => ({
            ctes: [],
            gate: "FALSE",
            effects: () => [],
            report: "'{}'::jsonb",
            resolve() {
              throw new Error("denied");
            },
          }),
        }),
        /denied/,
      );
      assert.equal((await write(context(tx), "one")).event.seq, "1");
    });
  } finally {
    await db.close();
  }
});

test("owner event lease admission uses command timestamp instead of outer transaction start", async () => {
  const { db, context } = await fixture();
  try {
    await db.transaction(async (tx) => {
      const initial = createEventStore({
        session: db,
        ownerCommit: context(tx),
      });
      const source = await initial.commitMutation({
        transaction: tx,
        draft: { type: "source", namespace: "space", payload: {} },
        consumers: [{ consumerId: "worker", settlement: "inherit" }],
      });
      const delivery = source.deliveries[0];
      await tx.query(
        "UPDATE event_deliveries SET status = 'leased', lease_owner = 'attempt', lease_expires_at = $1 WHERE id = $2",
        ["2099-01-01T00:00:00Z", delivery.id],
      );
      const later = createEventStore({
        session: db,
        ownerCommit: { ...context(tx), commandTime: "2099-01-01T00:00:01Z" },
      });
      await assert.rejects(
        later.commitMutation({
          transaction: tx,
          draft: {
            type: "too-late",
            namespace: "space",
            payload: {},
            deliveryLease: { deliveryId: delivery.id, owner: "attempt" },
          },
          consumers: [],
        }),
      );
      assert.equal(
        String(
          (await tx.query("SELECT last_seq FROM owner_epochs")).rows[0]
            .last_seq,
        ),
        "1",
      );
      assert.equal((await tx.query("SELECT id FROM events")).rows.length, 1);
    });
  } finally {
    await db.close();
  }
});
