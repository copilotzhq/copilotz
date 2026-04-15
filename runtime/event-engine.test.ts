import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { startEventWorker } from "./event-engine.ts";

Deno.test("startEventWorker keeps polling when conditional lease release fails", async () => {
  const threadId = "thread-1";
  const processedEventIds: string[] = [];
  const statusUpdates: Array<{ id: string; status: string }> = [];

  let nextCalls = 0;
  let conditionalReleaseCalls = 0;
  let blindReleaseCalls = 0;

  const queuedEvent = {
    id: "event-1",
    threadId,
    eventType: "NEW_MESSAGE",
    payload: { content: "hello" },
    parentEventId: null,
    traceId: null,
    priority: 0,
    metadata: null,
    ttlMs: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    status: "pending",
  };

  const ops = {
    getThreadWorkerLeaseConfig: () => ({
      leaseMs: 60_000,
      heartbeatMs: 60_000,
    }),
    acquireThreadWorkerLease: async () => true,
    renewThreadWorkerLease: async () => true,
    recoverThreadProcessingQueueItems: async () => 0,
    getNextPendingQueueItem: async () => {
      nextCalls += 1;
      if (nextCalls === 1) return undefined;
      if (nextCalls === 2) return queuedEvent;
      return undefined;
    },
    updateQueueItemStatus: async (id: string, status: string) => {
      statusUpdates.push({ id, status });
    },
    releaseThreadWorkerLeaseIfNoPendingWork: async () => {
      conditionalReleaseCalls += 1;
      return conditionalReleaseCalls >= 2;
    },
    releaseThreadWorkerLease: async () => {
      blindReleaseCalls += 1;
    },
  };

  const fakeDb = {
    ops,
  };

  await startEventWorker(
    fakeDb as never,
    threadId,
    {},
    {
      NEW_MESSAGE: {
        shouldProcess: () => true,
        process: async (event) => {
          processedEventIds.push(event.id as string);
          return { producedEvents: [] };
        },
      },
    },
    async () =>
      ({
        db: fakeDb,
        thread: { id: threadId },
        context: {},
      }) as never,
  );

  assertEquals(processedEventIds, ["event-1"]);
  assertEquals(
    statusUpdates,
    [
      { id: "event-1", status: "processing" },
      { id: "event-1", status: "completed" },
    ],
  );
  assertEquals(nextCalls, 3);
  assertEquals(conditionalReleaseCalls, 2);
  assertEquals(blindReleaseCalls, 0);
});
