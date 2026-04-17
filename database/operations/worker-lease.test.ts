import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "../index.ts";

async function createTestThread() {
  const db = await createDatabase({ url: ":memory:" });
  const thread = await db.ops.findOrCreateThread(undefined, {
    name: "Worker Lease Test",
    participants: ["user-1"],
    status: "active",
    mode: "immediate",
  });
  return { db, thread };
}

async function getLeaseState(
  db: Awaited<ReturnType<typeof createDatabase>>,
  threadId: string,
) {
  const result = await db.query<{
    workerLockedBy: string | null;
    workerLeaseExpiresAt: string | Date | null;
  }>(
    `SELECT
       "workerLockedBy" AS "workerLockedBy",
       "workerLeaseExpiresAt" AS "workerLeaseExpiresAt"
     FROM "threads"
     WHERE "id" = $1`,
    [threadId],
  );

  const row = result.rows[0];
  assertExists(row);
  return row;
}

Deno.test("releaseThreadWorkerLeaseIfNoPendingWork releases an idle worker lease", async () => {
  const { db, thread } = await createTestThread();
  const workerId = "worker-idle";

  const acquired = await db.ops.acquireThreadWorkerLease(
    thread.id as string,
    workerId,
  );
  assertEquals(acquired, true);

  const released = await db.ops.releaseThreadWorkerLeaseIfNoPendingWork(
    thread.id as string,
    workerId,
    0,
  );

  assertEquals(released, true);

  const leaseState = await getLeaseState(db, thread.id as string);
  assertEquals(leaseState.workerLockedBy, null);
  assertEquals(leaseState.workerLeaseExpiresAt, null);
});

Deno.test("releaseThreadWorkerLeaseIfNoPendingWork keeps the lease when eligible work is pending", async () => {
  const { db, thread } = await createTestThread();
  const workerId = "worker-busy";

  const acquired = await db.ops.acquireThreadWorkerLease(
    thread.id as string,
    workerId,
  );
  assertEquals(acquired, true);

  await db.ops.addToQueue(thread.id as string, {
    eventType: "NEW_MESSAGE",
    payload: { content: "hello" },
    priority: 0,
  });

  const released = await db.ops.releaseThreadWorkerLeaseIfNoPendingWork(
    thread.id as string,
    workerId,
    0,
  );

  assertEquals(released, false);

  const leaseState = await getLeaseState(db, thread.id as string);
  assertEquals(leaseState.workerLockedBy, workerId);
  assertExists(leaseState.workerLeaseExpiresAt);
});

Deno.test("releaseThreadWorkerLeaseIfNoPendingWork ignores lower-priority pending work", async () => {
  const { db, thread } = await createTestThread();
  const workerId = "worker-priority";

  const acquired = await db.ops.acquireThreadWorkerLease(
    thread.id as string,
    workerId,
  );
  assertEquals(acquired, true);

  await db.ops.addToQueue(thread.id as string, {
    eventType: "ENTITY_EXTRACT",
    payload: { content: "background" },
    priority: -1,
  });

  const released = await db.ops.releaseThreadWorkerLeaseIfNoPendingWork(
    thread.id as string,
    workerId,
    0,
  );

  assertEquals(released, true);

  const leaseState = await getLeaseState(db, thread.id as string);
  assertEquals(leaseState.workerLockedBy, null);
});

Deno.test("recoverThreadProcessingQueueItems resets only stale processing events", async () => {
  const db = await createDatabase({
    url: ":memory:",
    staleProcessingThresholdMs: 60_000,
  });
  const thread = await db.ops.findOrCreateThread(undefined, {
    name: "Recovery Test",
    participants: ["user-1"],
    status: "active",
    mode: "immediate",
  });

  const stale = await db.ops.addToQueue(thread.id as string, {
    eventType: "NEW_MESSAGE",
    payload: { content: "stale" },
    priority: 0,
    status: "processing",
  });

  const active = await db.ops.addToQueue(thread.id as string, {
    eventType: "NEW_MESSAGE",
    payload: { content: "active" },
    priority: 0,
    status: "processing",
  });
  const staleTimestamp = new Date(Date.now() - 86_400_000).toISOString();

  await db.query(
    `UPDATE "events"
     SET "updatedAt" = $2
     WHERE "id" = $1`,
    [String(stale.id), staleTimestamp],
  );

  const recovered = await db.ops.recoverThreadProcessingQueueItems(
    thread.id as string,
  );

  assertEquals(recovered, 1);

  const staleItem = await db.ops.getQueueItemById(String(stale.id));
  const activeItem = await db.ops.getQueueItemById(String(active.id));

  assertEquals(staleItem?.status, "pending");
  assertEquals(activeItem?.status, "processing");
});

Deno.test("isThreadWorkerLeaseOwner reports active ownership accurately", async () => {
  const { db, thread } = await createTestThread();
  const workerId = "worker-owner";
  const otherWorkerId = "worker-other";

  const acquired = await db.ops.acquireThreadWorkerLease(
    thread.id as string,
    workerId,
  );
  assertEquals(acquired, true);

  assert(await db.ops.isThreadWorkerLeaseOwner(thread.id as string, workerId));
  assertEquals(
    await db.ops.isThreadWorkerLeaseOwner(thread.id as string, otherWorkerId),
    false,
  );
});
