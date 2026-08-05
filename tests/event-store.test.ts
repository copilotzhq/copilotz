import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDatabase } from "../database/database.ts";
import { EventStore } from "../database/event-store.ts";

Deno.test("graph mutation, event, and delivery obligations are atomic", async () => {
  const database = await createDatabase({ url: ":memory:" });
  const store = new EventStore(database.session, database.schema);
  try {
    await assertRejects(() =>
      store.commitMutation({
        draft: {
          type: "widget.created",
          namespace: "tenant-a",
          payload: 1n,
          correlationId: "rollback-correlation",
        },
        consumerIds: ["widget.index"],
        mutate: async (transaction) => {
          await transaction.query(
            `INSERT INTO ${store.table("nodes")} (
              id, namespace, type, name, data, created_at, updated_at
            ) VALUES ('rollback-node', 'tenant-a', 'widget', 'rollback', '{}', NOW(), NOW())`,
          );
          return undefined;
        },
      })
    );
    assertEquals(
      Number(
        (await store.read<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM ${store.table("nodes")}
         WHERE id = 'rollback-node'`,
        )).rows[0].count,
      ),
      0,
    );
    assertEquals(
      await store.listEvents({ namespace: "tenant-a" }),
      [],
    );

    const first = await store.append({
      type: "widget.created",
      namespace: "tenant-a",
      payload: { id: "one" },
      correlationId: "ordered",
      deduplicationId: "widget:one",
    }, ["widget.index", "widget.index"]);
    const duplicate = await store.append({
      type: "widget.created",
      namespace: "tenant-a",
      payload: { id: "ignored" },
      correlationId: "ordered",
      deduplicationId: "widget:one",
    }, ["widget.index"]);
    const second = await store.append({
      type: "widget.updated",
      namespace: "tenant-a",
      payload: { id: "one" },
      correlationId: "ordered",
    }, []);

    assert(first.event.position < second.event.position);
    assertEquals(duplicate.deduplicated, true);
    assertEquals(duplicate.event.id, first.event.id);
    assertEquals(first.deliveries.length, 1);
    assertEquals(
      (await store.listEvents({ namespace: "tenant-a" })).map((event) =>
        event.type
      ),
      ["widget.created", "widget.updated"],
    );
    assertEquals(
      await store.listEvents({ namespace: "tenant-b" }),
      [],
    );
  } finally {
    await database.close();
  }
});

Deno.test("delivery leases retry three times, dead-letter, retry, and discard", async () => {
  const database = await createDatabase({ url: ":memory:" });
  const store = new EventStore(database.session, database.schema);
  try {
    const committed = await store.append({
      type: "work.created",
      namespace: "default",
      payload: {},
      correlationId: "retry-scope",
    }, ["worker"]);
    const id = committed.deliveries[0].id;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const owner = `owner-${attempt}`;
      const claimed = await store.claimDelivery({ id, owner });
      assertEquals(claimed?.attempts, attempt);
      const failed = await store.failDelivery({
        id,
        owner,
        error: new Error(`failure-${attempt}`),
        backoffMs: 0,
      });
      assertEquals(
        failed?.status,
        attempt === 3 ? "dead_letter" : "retry_wait",
      );
    }
    assertEquals(
      await store.correlationSettlement("default", "retry-scope"),
      { unsettled: 0, deadLetters: 1, cancelled: 0 },
    );
    assertEquals(await store.retryDeadLetter(id), true);
    const retried = await store.getDelivery(id);
    assertEquals(retried?.status, "pending");
    assertEquals(retried?.attempts, 0);
    const owner = "final-owner";
    await store.claimDelivery({ id, owner });
    await store.failDelivery({ id, owner, error: "again", backoffMs: 0 });
    await store.claimDelivery({ id, owner });
    await store.failDelivery({ id, owner, error: "again", backoffMs: 0 });
    await store.claimDelivery({ id, owner });
    await store.failDelivery({ id, owner, error: "again", backoffMs: 0 });
    assertEquals(await store.discardDeadLetter(id), true);
    assertEquals((await store.getDelivery(id))?.status, "cancelled");

    const expired = await store.append({
      type: "lease.expired",
      namespace: "default",
      payload: {},
      correlationId: "expired-lease",
    }, ["worker"]);
    const expiredId = expired.deliveries[0].id;
    await store.claimDelivery({ id: expiredId, owner: "gone", leaseMs: 0 });
    assertEquals(
      (await store.listRecoverable()).some((delivery) =>
        delivery.id === expiredId
      ),
      true,
    );
    assertEquals(
      (await store.claimDelivery({ id: expiredId, owner: "replacement" }))
        ?.attempts,
      2,
    );
  } finally {
    await database.close();
  }
});

Deno.test("compaction removes only old fully settled work", async () => {
  const database = await createDatabase({ url: ":memory:" });
  const store = new EventStore(database.session, database.schema);
  try {
    const settled = await store.append({
      type: "old.settled",
      namespace: "default",
      payload: {},
      correlationId: "old-settled",
      createdAt: "2020-01-01T00:00:00.000Z",
    }, ["consumer"]);
    const settledDelivery = settled.deliveries[0];
    await store.claimDelivery({ id: settledDelivery.id, owner: "owner" });
    await store.succeedDelivery(settledDelivery.id, "owner");

    const dead = await store.append({
      type: "old.dead",
      namespace: "default",
      payload: {},
      correlationId: "old-dead",
      createdAt: "2020-01-01T00:00:00.000Z",
    }, ["consumer"]);
    const deadId = dead.deliveries[0].id;
    for (let attempt = 0; attempt < 3; attempt++) {
      const owner = `dead-${attempt}`;
      await store.claimDelivery({ id: deadId, owner });
      await store.failDelivery({
        id: deadId,
        owner,
        error: "failure",
        backoffMs: 0,
      });
    }

    const compacted = await store.compact({
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      now: new Date("2021-01-01T00:00:00.000Z"),
    });
    assertEquals(compacted, { events: 1, deliveries: 1 });
    assertEquals(await store.getEvent(settled.event.id), null);
    assertEquals((await store.getDelivery(deadId))?.status, "dead_letter");
  } finally {
    await database.close();
  }
});
