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
      memoryRecord: { list: () => Promise.resolve([]) },
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

Deno.test("foreground compaction skips an already-consumed pending checkpoint", async () => {
  const participant = {
    id: "west-participant",
    participantType: "agent",
    agentId: "west",
    externalId: "west",
  };
  const checkpoint = (id: string, end: string) => ({
    id,
    threadId: "thread",
    agentId: "west",
    status: "pending",
    metadata: {
      coverage: {
        schema: "copilotz.memory.coverage.v1",
        agentParticipantId: participant.id,
        branch: "public",
        startMessageId: "start",
        endMessageId: end,
        continuity: "Owned continuity",
      },
    },
  });
  const old = checkpoint("duplicate", "covered");
  const next = checkpoint("successor", "later");
  let reservations = 0;
  const context = {
    resources: { agents: { west: { id: "west" } } },
    collections: {
      message: {
        get: ({ id }: { id: string }) =>
          Promise.resolve({
            id,
            threadId: "thread",
            senderId: "human",
            createdAt: id === "later"
              ? "2026-10-02T00:00:00Z"
              : "2026-10-01T00:00:00Z",
          }),
      },
      participant: { get: () => Promise.resolve(participant) },
      thread: {
        get: () =>
          Promise.resolve({ id: "thread", participantIds: [participant.id] }),
      },
      longTermMemory: {
        list: () => Promise.resolve([++reservations === 1 ? old : next]),
        get: ({ id }: { id: string }) =>
          Promise.resolve({ ...(id === old.id ? old : next), status: "ready" }),
      },
    },
  };
  assertEquals(
    await memoryContextResource.compact!({
      context,
      agent: { id: "west" },
      participant,
      thread: { id: "thread" },
      triggerMessageId: "trigger",
      historyAfterMessageId: "covered",
      historyLimitEstimatedTokens: 80_000,
      signal: new AbortController().signal,
    } as never),
    true,
  );
  assertEquals(reservations, 2);
});

Deno.test("memory settles preparation failure only for its authenticated private task", async () => {
  const { deriveWorkflowId } = await import("@copilotz/copilotz/events");
  const { memoryTaskMetadata } = await import("../../../shared/task.ts");
  const { coreAgentTurnMetadata } = await import("@copilotz/copilotz/core");
  const id = await deriveWorkflowId(
    "message",
    "memory-agent-turn",
    "checkpoint",
  );
  const task = {
    id,
    visibility: { kind: "internal" },
    historyScopeId: "checkpoint",
    metadata: memoryTaskMetadata("checkpoint", "north"),
  };
  const updates: unknown[] = [];
  const context = {
    signal: new AbortController().signal,
    collections: {
      message: { get: () => Promise.resolve(task) },
      longTermMemory: {
        get: () => Promise.resolve({ id: "checkpoint", status: "pending" }),
        update: (input: unknown) => {
          updates.push(input);
          return Promise.resolve({});
        },
      },
    },
  };
  const turn = coreAgentTurnMetadata(task.metadata)!;
  assertEquals(
    await memoryContextResource.onTurnPreparationError!({
      context: context as never,
      turn,
      triggerMessageId: id,
      error: new Error("source changed"),
    }),
    true,
  );
  assertEquals(updates.length, 1);
  assertEquals(
    (updates[0] as { set: { status: string } }).set.status,
    "failed",
  );
  task.visibility.kind = "public";
  assertEquals(
    await memoryContextResource.onTurnPreparationError!({
      context: context as never,
      turn,
      triggerMessageId: id,
      error: new Error("untrusted failure"),
    }),
    false,
  );
  assertEquals(updates.length, 1);
});

Deno.test("prepared history below the threshold performs no collection or content access", async () => {
  const unavailable = new Proxy({}, {
    get() {
      throw new Error("unexpected persistence access");
    },
  });
  await memoryContextResource.onHistoryPrepared!({
    context: {
      resources: { memory: { config: { triggerEstimatedTokens: 120_000 } } },
      collections: unavailable,
      content: unavailable,
    },
    agent: { models: { generate: [{ connection: "test", model: "test" }] } },
    history: [],
    transcript: [{
      sourceId: "human",
      message: {
        role: "user",
        content: [{ kind: "text", value: "A short ordinary turn." }],
      },
    }],
  } as never);
});

Deno.test("ordinary history with an attachment stays below the memory trigger without persistence access", async () => {
  const unavailable = new Proxy({}, {
    get() {
      throw new Error("unexpected persistence access");
    },
  });
  await memoryContextResource.onHistoryPrepared!({
    context: {
      namespace: "tenant-a",
      resources: {
        memory: { config: { triggerEstimatedTokens: 120_000 } },
        llmConnections: { test: { provider: "openai" } },
      },
      collections: unavailable,
      content: unavailable,
    },
    agent: {
      models: { generate: [{ connection: "test", model: "gpt-6.1-sol" }] },
    },
    history: [],
    transcript: [{
      sourceId: "human",
      message: {
        role: "user",
        content: [{
          kind: "file",
          assetId: "voice-note",
          role: "attachment",
          name: "voice.webm",
          mediaType: "audio/webm",
          disposition: "attachment",
          resolve: false,
        }],
      },
    }],
  } as never);
});
