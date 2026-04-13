import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createDatabase } from "../index.ts";

async function createTestDatabase() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  return await createDatabase({
    url: `file:///tmp/copilotz-admin-test-${suffix}.db`,
  });
}

async function updateThreadTimestamp(
  db: Awaited<ReturnType<typeof createDatabase>>,
  threadId: string,
  iso: string,
) {
  await db.query(
    `UPDATE "threads" SET "createdAt" = $1, "updatedAt" = $1 WHERE "id" = $2`,
    [iso, threadId],
  );
}

async function updateNodeTimestamp(
  db: Awaited<ReturnType<typeof createDatabase>>,
  nodeId: string,
  iso: string,
) {
  await db.query(
    `UPDATE "nodes" SET "created_at" = $1, "updated_at" = $1 WHERE "id" = $2`,
    [iso, nodeId],
  );
}

async function updateEventTimestamp(
  db: Awaited<ReturnType<typeof createDatabase>>,
  eventId: string,
  iso: string,
) {
  await db.query(
    `UPDATE "events" SET "createdAt" = $1, "updatedAt" = $1 WHERE "id" = $2`,
    [iso, eventId],
  );
}

async function seedAdminFixtures() {
  const db = await createTestDatabase();

  const threadAlpha = await db.ops.findOrCreateThread(undefined, {
    name: "Alpha Thread",
    summary: "Main tenant alpha thread",
    participants: ["user-alpha", "agent-alpha"],
    status: "active",
    mode: "immediate",
  });
  const threadBeta = await db.ops.findOrCreateThread(undefined, {
    name: "Beta Archive",
    summary: "Archived tenant beta thread",
    participants: ["user-beta", "agent-beta"],
    status: "archived",
    mode: "immediate",
  });

  await updateThreadTimestamp(db, threadAlpha.id as string, "2026-01-10T10:00:00.000Z");
  await updateThreadTimestamp(db, threadBeta.id as string, "2026-01-11T12:00:00.000Z");

  await db.ops.upsertParticipantNode("user-alpha", "human", "tenant-alpha", {
    name: "Alice Alpha",
  });
  await db.ops.upsertParticipantNode("agent-alpha", "agent", "tenant-alpha", {
    name: "Agent Alpha",
    agentId: "agent-alpha",
  });
  await db.ops.upsertParticipantNode("user-beta", "human", "tenant-beta", {
    name: "Beto Beta",
  });
  await db.ops.upsertParticipantNode("agent-beta", "agent", "tenant-beta", {
    name: "Agent Beta",
    agentId: "agent-beta",
  });
  await db.ops.upsertParticipantNode("global-agent", "agent", null, {
    name: "Global Agent",
    agentId: "global-agent",
  });

  const alphaUserMessage = await db.ops.createNode({
    namespace: threadAlpha.id as string,
    type: "message",
    name: "user-alpha:hello",
    content: "Hello from alpha",
    data: {
      senderId: "user-alpha",
      senderType: "user",
      toolCalls: null,
      toolCallId: null,
    },
    sourceType: "thread",
    sourceId: threadAlpha.id as string,
  });
  const alphaAgentMessage = await db.ops.createNode({
    namespace: threadAlpha.id as string,
    type: "message",
    name: "agent-alpha:tool",
    content: "Agent alpha used a tool",
    data: {
      senderId: "agent-alpha",
      senderType: "agent",
      toolCalls: [{ name: "lookupProfile" }],
      toolCallId: "tool-alpha-1",
    },
    sourceType: "thread",
    sourceId: threadAlpha.id as string,
  });
  const betaUserMessage = await db.ops.createNode({
    namespace: threadBeta.id as string,
    type: "message",
    name: "user-beta:hello",
    content: "Hello from beta",
    data: {
      senderId: "user-beta",
      senderType: "user",
      toolCalls: null,
      toolCallId: null,
    },
    sourceType: "thread",
    sourceId: threadBeta.id as string,
  });

  await updateNodeTimestamp(db, alphaUserMessage.id as string, "2026-01-10T10:15:00.000Z");
  await updateNodeTimestamp(db, alphaAgentMessage.id as string, "2026-01-10T11:30:00.000Z");
  await updateNodeTimestamp(db, betaUserMessage.id as string, "2026-01-11T13:45:00.000Z");

  const alphaUsage = await db.ops.createNode({
    namespace: threadAlpha.id as string,
    type: "llm_usage",
    name: "success:openai:gpt-5",
    data: {
      threadId: threadAlpha.id,
      agentId: "agent-alpha",
      provider: "openai",
      model: "gpt-5",
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 12,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 2,
      totalTokens: 177,
      inputCostUsd: 0.0012,
      outputCostUsd: 0.00045,
      reasoningCostUsd: 0.00012,
      cacheReadInputCostUsd: 0.00001,
      cacheCreationInputCostUsd: 0.000004,
      totalCostUsd: 0.001784,
      status: "success",
    },
    sourceType: "event",
    sourceId: "event-alpha",
  });
  const betaUsage = await db.ops.createNode({
    namespace: threadBeta.id as string,
    type: "llm_usage",
    name: "success:anthropic:claude",
    data: {
      threadId: threadBeta.id,
      agentId: "agent-beta",
      provider: "anthropic",
      model: "claude",
      inputTokens: 60,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 95,
      inputCostUsd: 0.0006,
      outputCostUsd: 0.0003,
      reasoningCostUsd: 0.00005,
      cacheReadInputCostUsd: 0,
      cacheCreationInputCostUsd: 0,
      totalCostUsd: 0.00095,
      status: "success",
    },
    sourceType: "event",
    sourceId: "event-beta",
  });

  await updateNodeTimestamp(db, alphaUsage.id as string, "2026-01-10T11:40:00.000Z");
  await updateNodeTimestamp(db, betaUsage.id as string, "2026-01-11T14:00:00.000Z");

  const alphaPending = await db.crud.events.create({
    threadId: threadAlpha.id as string,
    eventType: "TEST",
    payload: {},
    namespace: "tenant-alpha",
    status: "pending",
  });
  const alphaCompleted = await db.crud.events.create({
    threadId: threadAlpha.id as string,
    eventType: "TEST",
    payload: {},
    namespace: "tenant-alpha",
    status: "completed",
  });
  const betaFailed = await db.crud.events.create({
    threadId: threadBeta.id as string,
    eventType: "TEST",
    payload: {},
    namespace: "tenant-beta",
    status: "failed",
  });

  await updateEventTimestamp(db, alphaPending.id as string, "2026-01-10T10:01:00.000Z");
  await updateEventTimestamp(db, alphaCompleted.id as string, "2026-01-10T10:02:00.000Z");
  await updateEventTimestamp(db, betaFailed.id as string, "2026-01-11T12:30:00.000Z");

  return {
    db,
    threadAlphaId: threadAlpha.id as string,
    threadBetaId: threadBeta.id as string,
  };
}

Deno.test("admin overview returns zeroed metrics for an empty database", async () => {
  const db = await createTestDatabase();

  const overview = await db.ops.getAdminOverview();

  assertEquals(overview, {
    threadTotals: { total: 0, active: 0, archived: 0 },
    queueTotals: {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      expired: 0,
      overwritten: 0,
    },
    messageTotals: { total: 0, toolCallMessages: 0 },
    participantTotals: { total: 0, humans: 0, agents: 0 },
    llmTotals: {
      totalCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      inputCostUsd: 0,
      outputCostUsd: 0,
      reasoningCostUsd: 0,
      cacheReadInputCostUsd: 0,
      cacheCreationInputCostUsd: 0,
      totalCostUsd: 0,
    },
  });
});

Deno.test("admin overview aggregates threads, events, messages, participants, and usage with namespace filters", async () => {
  const { db } = await seedAdminFixtures();

  const allOverview = await db.ops.getAdminOverview();
  assertEquals(allOverview.threadTotals, { total: 2, active: 1, archived: 1 });
  assertEquals(allOverview.queueTotals.pending, 1);
  assertEquals(allOverview.queueTotals.completed, 1);
  assertEquals(allOverview.queueTotals.failed, 1);
  assertEquals(allOverview.messageTotals, { total: 3, toolCallMessages: 1 });
  assertEquals(allOverview.participantTotals, { total: 5, humans: 2, agents: 3 });
  assertEquals(allOverview.llmTotals.totalCalls, 2);
  assertEquals(allOverview.llmTotals.totalTokens, 272);
  assertEquals(allOverview.llmTotals.totalCostUsd, 0.002734);

  const alphaOverview = await db.ops.getAdminOverview({
    namespace: "tenant-alpha",
  });
  assertEquals(alphaOverview.threadTotals, { total: 1, active: 1, archived: 0 });
  assertEquals(alphaOverview.queueTotals.total, 2);
  assertEquals(alphaOverview.messageTotals, { total: 2, toolCallMessages: 1 });
  assertEquals(alphaOverview.participantTotals, { total: 3, humans: 1, agents: 2 });
  assertEquals(alphaOverview.llmTotals.totalCalls, 1);
  assertEquals(alphaOverview.llmTotals.totalTokens, 177);
  assertEquals(alphaOverview.llmTotals.totalCostUsd, 0.001784);
});

Deno.test("admin activity series buckets message and usage data by interval", async () => {
  const { db } = await seedAdminFixtures();

  const hourly = await db.ops.getAdminActivitySeries({ interval: "hour" });
  assertEquals(hourly.length, 4);
  assertEquals(hourly[0], {
    bucket: "2026-01-10T10:00:00.000Z",
    messageCount: 1,
    llmCallCount: 0,
    toolCallMessageCount: 0,
    totalTokens: 0,
  });
  assertEquals(hourly[1], {
    bucket: "2026-01-10T11:00:00.000Z",
    messageCount: 1,
    llmCallCount: 1,
    toolCallMessageCount: 1,
    totalTokens: 177,
  });

  const dailyAlpha = await db.ops.getAdminActivitySeries({
    interval: "day",
    namespace: "tenant-alpha",
  });
  assertEquals(dailyAlpha, [{
    bucket: "2026-01-10T00:00:00.000Z",
    messageCount: 2,
    llmCallCount: 1,
    toolCallMessageCount: 1,
    totalTokens: 177,
  }]);
});

Deno.test("admin thread list supports namespace filtering, search, and pagination", async () => {
  const { db, threadAlphaId, threadBetaId } = await seedAdminFixtures();

  const allThreads = await db.ops.listAdminThreads();
  assertEquals(allThreads.length, 2);
  assertEquals(allThreads[0]?.threadId, threadBetaId);

  const alphaThreads = await db.ops.listAdminThreads({
    namespace: "tenant-alpha",
    search: "alpha",
  });
  assertEquals(alphaThreads.length, 1);
  assertEquals({
    threadId: threadAlphaId,
    name: "Alpha Thread",
    status: "active",
    summary: "Main tenant alpha thread",
    participantIds: ["user-alpha", "agent-alpha"],
    messageCount: 2,
    lastActivityAt: "2026-01-10T11:30:00.000Z",
    lastMessagePreview: "Agent alpha used a tool",
  }, {
    threadId: alphaThreads[0]?.threadId,
    name: alphaThreads[0]?.name,
    status: alphaThreads[0]?.status,
    summary: alphaThreads[0]?.summary,
    participantIds: alphaThreads[0]?.participantIds,
    messageCount: alphaThreads[0]?.messageCount,
    lastActivityAt: alphaThreads[0]?.lastActivityAt,
    lastMessagePreview: alphaThreads[0]?.lastMessagePreview,
  });
  assert(alphaThreads[0]?.createdAt);
  assert(alphaThreads[0]?.updatedAt);

  const paged = await db.ops.listAdminThreads({ limit: 1, offset: 1 });
  assertEquals(paged.length, 1);
});

Deno.test("admin participant list supports participant filtering, search, and namespace scoping", async () => {
  const { db } = await seedAdminFixtures();

  const humans = await db.ops.listAdminParticipants({
    participantType: "human",
    search: "alice",
    namespace: "tenant-alpha",
  });
  assertEquals(humans, [{
    externalId: "user-alpha",
    displayName: "Alice Alpha",
    participantType: "human",
    namespace: "tenant-alpha",
    isGlobal: false,
    messageCount: 1,
    threadCount: 1,
    lastActivityAt: "2026-01-10T10:15:00.000Z",
  }]);

  const agents = await db.ops.listAdminParticipants({
    participantType: "agent",
    namespace: "tenant-alpha",
  });
  assertEquals(agents.length, 2);
  assertEquals(agents[0]?.externalId, "agent-alpha");
});

Deno.test("admin agent list merges graph metrics with configured agents", async () => {
  const { db } = await seedAdminFixtures();

  const agents = await db.ops.listAdminAgents({
    namespace: "tenant-alpha",
    configuredAgents: [
      {
        id: "agent-alpha",
        name: "Configured Alpha",
        description: "Primary alpha agent",
      },
      {
        id: "planner-agent",
        name: "Planner Agent",
        description: "Configured but unused",
      },
    ],
  });

  assertEquals(agents.length, 3);
  assertEquals(agents[0], {
    agentId: "agent-alpha",
    displayName: "Configured Alpha",
    description: "Primary alpha agent",
    isConfigured: true,
    namespace: "tenant-alpha",
    isGlobal: false,
    messageCount: 1,
    llmCallCount: 1,
    toolCallMessageCount: 1,
    inputTokens: 120,
    outputTokens: 45,
    reasoningTokens: 12,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 2,
    totalTokens: 177,
    inputCostUsd: 0.0012,
    outputCostUsd: 0.00045,
    reasoningCostUsd: 0.00012,
    cacheReadInputCostUsd: 0.00001,
    cacheCreationInputCostUsd: 0.000004,
    totalCostUsd: 0.001784,
    lastActivityAt: "2026-01-10T11:40:00.000Z",
  });
  assert(
    agents.some((agent) =>
      agent.agentId === "planner-agent" &&
      agent.messageCount === 0 &&
      agent.isConfigured === true
    ),
  );
});
