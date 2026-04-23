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
    isThreadWorkerLeaseOwner: async () => true,
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

  const emittedEvents: unknown[] = [];

  await startEventWorker(
    fakeDb as never,
    threadId,
    {
      processors: {
        NEW_MESSAGE: [
          {
            shouldProcess: () => true,
            process: async (event: import("@/types/index.ts").Event) => {
              processedEventIds.push(event.id as string);
              return { producedEvents: [] };
            },
          },
        ],
      },
      emitToStream: (ev: unknown) => {
        emittedEvents.push(ev);
      },
      stream: false,
    },
    async () =>
      ({
        db: fakeDb,
        thread: { id: threadId },
        context: {},
        emitToStream: () => {},
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

Deno.test("startEventWorker emits queued event before processor execution", async () => {
  const threadId = "thread-emit-first";
  const queuedEvent = {
    id: "event-emit-first",
    threadId,
    eventType: "TOOL_CALL",
    payload: { toolCall: { id: "tool-1" } },
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

  let nextCalls = 0;
  const emittedEvents: Array<{ id?: string; type?: string }> = [];
  const observations: string[] = [];

  const ops = {
    getThreadWorkerLeaseConfig: () => ({
      leaseMs: 60_000,
      heartbeatMs: 60_000,
    }),
    acquireThreadWorkerLease: async () => true,
    renewThreadWorkerLease: async () => true,
    isThreadWorkerLeaseOwner: async () => true,
    recoverThreadProcessingQueueItems: async () => 0,
    getNextPendingQueueItem: async () => {
      nextCalls += 1;
      return nextCalls === 1 ? queuedEvent : undefined;
    },
    updateQueueItemStatus: async () => {},
    releaseThreadWorkerLeaseIfNoPendingWork: async () => true,
    releaseThreadWorkerLease: async () => {},
  };

  const fakeDb = { ops };

  await startEventWorker(
    fakeDb as never,
    threadId,
    {
      processors: {
        TOOL_CALL: [
          {
            shouldProcess: () => true,
            process: async (event: import("@/types/index.ts").Event) => {
              observations.push(
                emittedEvents.some((emitted) =>
                    emitted.id === event.id && emitted.type === "TOOL_CALL"
                  )
                  ? "emitted-before-process"
                  : "missing-before-process",
              );
              return { producedEvents: [] };
            },
          },
        ],
      },
      emitToStream: (ev: import("@/types/index.ts").Event) => {
        emittedEvents.push({ id: ev.id as string | undefined, type: ev.type });
      },
      stream: true,
    },
    async () =>
      ({
        db: fakeDb,
        thread: { id: threadId },
        context: {},
        emitToStream: () => {},
      }) as never,
  );

  assertEquals(observations, ["emitted-before-process"]);
  assertEquals(emittedEvents, [{ id: "event-emit-first", type: "TOOL_CALL" }]);
});

Deno.test("startEventWorker marks the queue item failed when no processor recovers from an error", async () => {
  const threadId = "thread-failure";
  const queuedEvent = {
    id: "event-failure",
    threadId,
    eventType: "NEW_MESSAGE",
    payload: { content: "hello" },
    parentEventId: null,
    traceId: "trace-1",
    priority: 0,
    metadata: null,
    ttlMs: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    status: "pending",
  };

  let nextCalls = 0;
  const statusUpdates: Array<{ id: string; status: string }> = [];

  const ops = {
    getThreadWorkerLeaseConfig: () => ({
      leaseMs: 60_000,
      heartbeatMs: 60_000,
    }),
    acquireThreadWorkerLease: async () => true,
    renewThreadWorkerLease: async () => true,
    isThreadWorkerLeaseOwner: async () => true,
    recoverThreadProcessingQueueItems: async () => 0,
    getNextPendingQueueItem: async () => {
      nextCalls += 1;
      return nextCalls === 1 ? queuedEvent : undefined;
    },
    updateQueueItemStatus: async (id: string, status: string) => {
      statusUpdates.push({ id, status });
    },
    releaseThreadWorkerLeaseIfNoPendingWork: async () => true,
    releaseThreadWorkerLease: async () => {},
  };

  const fakeDb = { ops };

  await startEventWorker(
    fakeDb as never,
    threadId,
    {
      processors: {
        NEW_MESSAGE: [{
          shouldProcess: () => true,
          process: async () => {
            throw new Error("synthetic processor failure");
          },
        }],
      },
      emitToStream: () => {},
      stream: false,
    },
    async () =>
      ({
        db: fakeDb,
        thread: { id: threadId },
        context: {},
        emitToStream: () => {},
      }) as never,
  );

  assertEquals(
    statusUpdates,
    [
      { id: "event-failure", status: "processing" },
      { id: "event-failure", status: "failed" },
    ],
  );
});
