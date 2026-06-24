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

Deno.test({
  name: "default thread worker lease config recovers crashed workers faster",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    assertEquals(db.ops.getThreadWorkerLeaseConfig(), {
      leaseMs: 60_000,
      heartbeatMs: 15_000,
    });
  },
});

Deno.test({
  name: "releaseThreadWorkerLeaseIfNoPendingWork releases an idle worker lease",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name:
    "releaseThreadWorkerLeaseIfNoPendingWork keeps the lease when eligible work is pending",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name:
    "releaseThreadWorkerLeaseIfNoPendingWork ignores lower-priority pending work",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name: "database query boundary strips NUL chars from queued event payloads",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, thread } = await createTestThread();

    const queued = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: {
        content: "before\u0000after",
        nested: { "bad\u0000key": "ok\u0000now" },
      },
      metadata: { reason: "meta\u0000data" },
      priority: 0,
    });

    const persisted = await db.ops.getQueueItemById(queued.id as string);
    assertExists(persisted);
    assertEquals(persisted.payload, {
      content: "beforeafter",
      nested: { badkey: "oknow" },
    });
    assertEquals(persisted.metadata, { reason: "metadata" });
  },
});

Deno.test({
  name: "recoverThreadProcessingQueueItems resets only stale processing events",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
  },
});

Deno.test({
  name:
    "recoverThreadProcessingQueueItems fails stale visible LLM events instead of replaying them",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({
      url: ":memory:",
      staleProcessingThresholdMs: 60_000,
    });
    const thread = await db.ops.findOrCreateThread(undefined, {
      name: "Visible Recovery Test",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });

    const staleVisible = await db.ops.addToQueue(thread.id as string, {
      eventType: "LLM_CALL",
      payload: { content: "visible partial" },
      metadata: { visibleOutputStarted: true },
      priority: 0,
      status: "processing",
    });
    const staleNormal = await db.ops.addToQueue(thread.id as string, {
      eventType: "NEW_MESSAGE",
      payload: { content: "safe to replay" },
      priority: 0,
      status: "processing",
    });
    const staleTimestamp = new Date(Date.now() - 86_400_000).toISOString();

    await db.query(
      `UPDATE "events"
       SET "updatedAt" = $2
       WHERE "id" IN ($1, $3)`,
      [String(staleVisible.id), staleTimestamp, String(staleNormal.id)],
    );

    const recovered = await db.ops.recoverThreadProcessingQueueItems(
      thread.id as string,
    );

    assertEquals(recovered, 1);

    const visibleItem = await db.ops.getQueueItemById(String(staleVisible.id));
    const normalItem = await db.ops.getQueueItemById(String(staleNormal.id));
    const metadata = visibleItem?.metadata as Record<string, unknown>;

    assertEquals(visibleItem?.status, "failed");
    assertEquals(metadata.recoverySkipped, true);
    assertEquals(metadata.recoveryReason, "visible_output_started");
    assertEquals(normalItem?.status, "pending");
  },
});

Deno.test({
  name: "getThreadActivity treats newer completed work as idle after a failure",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, thread } = await createTestThread();
    const threadId = thread.id as string;

    const failed = await db.ops.addToQueue(threadId, {
      eventType: "LLM_CALL",
      payload: { content: "failed" },
      priority: 2000,
      status: "failed",
    });
    const completed = await db.ops.addToQueue(threadId, {
      eventType: "LLM_CALL",
      payload: { content: "completed later" },
      priority: 2000,
      status: "completed",
    });

    await db.query(
      `UPDATE "events" SET "updatedAt" = $2 WHERE "id" = $1`,
      [String(failed.id), new Date(Date.now() - 10_000).toISOString()],
    );
    await db.query(
      `UPDATE "events" SET "updatedAt" = $2 WHERE "id" = $1`,
      [String(completed.id), new Date(Date.now() + 10_000).toISOString()],
    );

    const activity = await db.ops.getThreadActivity(threadId, {
      minPriority: 0,
    });

    assertEquals(activity.status, "idle");
    assertEquals(activity.activeCount, 0);
    assertEquals(activity.lastFailure?.id, failed.id);
  },
});

Deno.test({
  name: "getThreadActivity reports failed when the latest settled work failed",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, thread } = await createTestThread();
    const threadId = thread.id as string;

    const completed = await db.ops.addToQueue(threadId, {
      eventType: "LLM_CALL",
      payload: { content: "completed first" },
      priority: 2000,
      status: "completed",
    });
    const failed = await db.ops.addToQueue(threadId, {
      eventType: "LLM_CALL",
      payload: { content: "failed later" },
      priority: 2000,
      status: "failed",
    });

    await db.query(
      `UPDATE "events" SET "updatedAt" = $2 WHERE "id" = $1`,
      [String(completed.id), new Date(Date.now() - 10_000).toISOString()],
    );
    await db.query(
      `UPDATE "events" SET "updatedAt" = $2 WHERE "id" = $1`,
      [String(failed.id), new Date(Date.now() + 10_000).toISOString()],
    );

    const activity = await db.ops.getThreadActivity(threadId, {
      minPriority: 0,
    });

    assertEquals(activity.status, "failed");
    assertEquals(activity.activeCount, 0);
    assertEquals(activity.lastFailure?.id, failed.id);
  },
});

Deno.test({
  name:
    "acquireThreadWorkerLease resets processing events after expired lease takeover",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, thread } = await createTestThread();
    const threadId = thread.id as string;

    assertEquals(
      await db.ops.acquireThreadWorkerLease(threadId, "worker-old"),
      true,
    );

    const processing = await db.ops.addToQueue(threadId, {
      eventType: "NEW_MESSAGE",
      payload: { content: "in-flight" },
      priority: 0,
      status: "processing",
    });
    const visibleLlm = await db.ops.addToQueue(threadId, {
      eventType: "LLM_CALL",
      payload: { content: "visible partial" },
      metadata: { visibleOutputStarted: true },
      priority: 0,
      status: "processing",
    });

    await db.query(
      `UPDATE "threads"
       SET "workerLeaseExpiresAt" = NOW() - INTERVAL '1 second'
       WHERE "id" = $1`,
      [threadId],
    );

    assertEquals(
      await db.ops.acquireThreadWorkerLease(threadId, "worker-new"),
      true,
    );

    const recovered = await db.ops.getQueueItemById(String(processing.id));
    const skipped = await db.ops.getQueueItemById(String(visibleLlm.id));
    const skippedMetadata = skipped?.metadata as Record<string, unknown>;

    assertEquals(recovered?.status, "pending");
    assertEquals(skipped?.status, "failed");
    assertEquals(skippedMetadata.recoverySkipped, true);
    assertEquals(skippedMetadata.recoveryReason, "visible_output_started");

    const leaseState = await getLeaseState(db, threadId);
    assertEquals(leaseState.workerLockedBy, "worker-new");
  },
});

Deno.test({
  name:
    "acquireThreadWorkerLease leaves processing events alone when active lease blocks takeover",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, thread } = await createTestThread();
    const threadId = thread.id as string;

    assertEquals(
      await db.ops.acquireThreadWorkerLease(threadId, "worker-active"),
      true,
    );

    const processing = await db.ops.addToQueue(threadId, {
      eventType: "NEW_MESSAGE",
      payload: { content: "active" },
      priority: 0,
      status: "processing",
    });

    assertEquals(
      await db.ops.acquireThreadWorkerLease(threadId, "worker-contender"),
      false,
    );

    const stillProcessing = await db.ops.getQueueItemById(
      String(processing.id),
    );
    assertEquals(stillProcessing?.status, "processing");
  },
});

Deno.test({
  name: "findRecoverableThreadIds returns pending work without an active lease",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({ url: ":memory:" });
    const recoverable = await db.ops.findOrCreateThread(undefined, {
      name: "Recoverable",
      namespace: "tenant-a",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const locked = await db.ops.findOrCreateThread(undefined, {
      name: "Locked",
      namespace: "tenant-a",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const otherTenant = await db.ops.findOrCreateThread(undefined, {
      name: "Other Tenant",
      namespace: "tenant-b",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });

    await db.ops.addToQueue(recoverable.id as string, {
      eventType: "NEW_MESSAGE",
      namespace: "tenant-a",
      payload: { content: "wake me" },
      priority: 0,
    });
    await db.ops.addToQueue(locked.id as string, {
      eventType: "NEW_MESSAGE",
      namespace: "tenant-a",
      payload: { content: "already running" },
      priority: 0,
    });
    await db.ops.addToQueue(otherTenant.id as string, {
      eventType: "NEW_MESSAGE",
      namespace: "tenant-b",
      payload: { content: "not this tenant" },
      priority: 0,
    });
    assertEquals(
      await db.ops.acquireThreadWorkerLease(locked.id as string, "worker-live"),
      true,
    );

    const threadIds = await db.ops.findRecoverableThreadIds({
      namespace: "tenant-a",
    });

    assertEquals(threadIds, [recoverable.id]);
  },
});

Deno.test({
  name:
    "findRecoverableThreadIds returns stale processing work after lease expiry",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createDatabase({
      url: ":memory:",
      staleProcessingThresholdMs: 60_000,
    });
    const staleThread = await db.ops.findOrCreateThread(undefined, {
      name: "Stale",
      namespace: "stale-recovery-test",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });
    const freshThread = await db.ops.findOrCreateThread(undefined, {
      name: "Fresh",
      namespace: "stale-recovery-test",
      participants: ["user-1"],
      status: "active",
      mode: "immediate",
    });

    const stale = await db.ops.addToQueue(staleThread.id as string, {
      eventType: "NEW_MESSAGE",
      namespace: "stale-recovery-test",
      payload: { content: "stale" },
      priority: 0,
      status: "processing",
    });
    await db.ops.addToQueue(freshThread.id as string, {
      eventType: "NEW_MESSAGE",
      namespace: "stale-recovery-test",
      payload: { content: "fresh" },
      priority: 0,
      status: "processing",
    });

    await db.query(
      `UPDATE "events"
       SET "updatedAt" = $2
       WHERE "id" = $1`,
      [String(stale.id), new Date(Date.now() - 86_400_000).toISOString()],
    );
    assertEquals(
      await db.ops.acquireThreadWorkerLease(staleThread.id as string, "old"),
      true,
    );
    await db.query(
      `UPDATE "threads"
       SET "workerLeaseExpiresAt" = NOW() - INTERVAL '1 second'
       WHERE "id" = $1`,
      [staleThread.id as string],
    );

    const threadIds = await db.ops.findRecoverableThreadIds({
      namespace: "stale-recovery-test",
    });

    assertEquals(threadIds, [staleThread.id]);
  },
});

Deno.test({
  name: "isThreadWorkerLeaseOwner reports active ownership accurately",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, thread } = await createTestThread();
    const workerId = "worker-owner";
    const otherWorkerId = "worker-other";

    const acquired = await db.ops.acquireThreadWorkerLease(
      thread.id as string,
      workerId,
    );
    assertEquals(acquired, true);

    assert(
      await db.ops.isThreadWorkerLeaseOwner(thread.id as string, workerId),
    );
    assertEquals(
      await db.ops.isThreadWorkerLeaseOwner(
        thread.id as string,
        otherWorkerId,
      ),
      false,
    );
  },
});
