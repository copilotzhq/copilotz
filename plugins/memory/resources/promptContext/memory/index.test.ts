import { assertEquals, assertRejects } from "@std/assert";
import { memoryContextResource } from "./index.ts";
Deno.test("memory context has stable id", () =>
  assertEquals(memoryContextResource.id, "copilotz.long_term"));

Deno.test("disabled memory context does not advance a history boundary", async () => {
  const contribution = await memoryContextResource.contribute(
    {
      context: { resources: { memory: { config: { enabled: false } } } },
    } as never,
  );
  assertEquals(contribution, null);
});

Deno.test("memory context selects the newest ready checkpoint visible to this thread", async () => {
  const resource = memoryContextResource;
  const contribution = await resource.contribute({
    context: { resources: {} } as never,
    purpose: "conversation",
    agent: { id: "north", name: "North", role: "assistant", models: {} },
    participant: {
      id: "north-participant",
      namespace: "tenant-a",
      externalId: "north",
      participantType: "agent",
      agentId: "north",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    thread: {
      id: "thread-a",
      namespace: "tenant-a",
      status: "active",
      metadata: {},
      participants: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    collections: {
      thread: {
        get: ({ id }: { id: string }) => Promise.resolve({ id }),
        list: () => Promise.resolve([]),
      },
      space: { get: () => Promise.resolve(null) },
      memorySpace: {
        get: ({ id }: { id: string }) =>
          Promise.resolve({ id, scopeType: "custom" }),
      },
      memorySpaceAccess: {
        list: () => Promise.resolve([{ memorySpaceId: "shared" }]),
      },
      longTermMemory: {
        // Deliberately return all states: the resource itself must never expose
        // pending or failed checkpoints as a history boundary.
        list: () =>
          Promise.resolve([
            {
              id: "failed",
              status: "failed",
              sequence: 4,
              readMemorySpaceIds: ["shared"],
              content: [{ assetId: "failed" }],
              sourceEndMessageId: "m4",
            },
            {
              id: "pending",
              status: "pending",
              sequence: 3,
              readMemorySpaceIds: ["shared"],
              content: [{ assetId: "pending" }],
              sourceEndMessageId: "m3",
            },
            {
              id: "private-ready",
              status: "ready",
              sequence: 2,
              readMemorySpaceIds: ["private"],
              content: [{ assetId: "private" }],
              sourceEndMessageId: "m2",
            },
            {
              id: "shared-ready",
              status: "ready",
              agentId: "north",
              sequence: 1,
              readMemorySpaceIds: ["shared"],
              content: [{ assetId: "shared" }],
              sourceEndMessageId: "m1",
              metadata: {
                coverage: {
                  schema: "copilotz.memory.coverage.v1",
                  agentParticipantId: "north-participant",
                  branch: "public",
                  startMessageId: "m1",
                  endMessageId: "m1",
                  continuity: "Compass remains the active project.",
                },
              },
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ].map((item) => ({
            threadId: "thread-a",
            agentId: "north",
            ...item,
          }))),
      },
    },
    signal: new AbortController().signal,
    idempotencyKey: "test",
  } as never);

  const selected = contribution as {
    id: string;
    historyAfterMessageId?: string;
  } | null;
  assertEquals(
    selected && {
      id: selected.id,
      historyAfterMessageId: selected.historyAfterMessageId,
    },
    {
      id: "shared-ready",
      historyAfterMessageId: "m1",
    },
  );
});

Deno.test("pending compaction aborts without advancing its checkpoint", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled compaction");
  let reads = 0;
  const pending = {
    id: "pending",
    status: "pending",
    threadId: "thread",
    agentId: "north",
  };
  const participant = {
    id: "north-participant",
    participantType: "agent",
    agentId: "north",
    externalId: "north",
  };
  const resource = memoryContextResource;
  await assertRejects(
    async () =>
      await resource.compact!({
        agent: { id: "north" },
        participant,
        thread: { id: "thread" },
        triggerMessageId: "trigger",
        limitEstimatedTokens: 1000,
        signal: controller.signal,
        context: {
          resources: { agents: { north: {} } },
          collections: {
            message: {
              get: () =>
                Promise.resolve({
                  id: "trigger",
                  threadId: "thread",
                  senderId: "human",
                }),
            },
            participant: { get: () => Promise.resolve(participant) },
            longTermMemory: {
              list: () => Promise.resolve([pending]),
              get: () => {
                reads++;
                controller.abort(reason);
                return Promise.resolve(pending);
              },
            },
          },
        },
      } as never),
    Error,
    "cancelled compaction",
  );
  assertEquals(reads, 1);
  assertEquals(pending.status, "pending");
});
