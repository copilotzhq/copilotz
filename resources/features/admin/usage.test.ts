import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import usage from "./usage.ts";
import { createDatabase } from "@/database/index.ts";
import { createCollectionsManager } from "@/database/collections/index.ts";
import participantCollection from "@/resources/collections/participant.ts";
import { createUsageService } from "@/runtime/collections/native.ts";
import activity from "./activity.ts";
import agents from "./agents.ts";
import overview from "./overview.ts";

Deno.test("admin usage groups canonical usage ledger rows", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Usage Thread",
    participants: ["user-1", "agent-1"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-1",
    participantType: "agent",
    name: "Agent One",
    agentId: "agent-1",
  });
  await collections.participant.upsertIdentity({
    externalId: "user-1",
    participantType: "human",
    name: "User One",
  });

  const eventId = "event-1";
  const usagePayload = {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    source: "provider",
    status: "completed",
  } as const;
  const costPayload = {
    source: "openrouter",
    currency: "USD",
    pricingModelId: "openai/gpt-test",
    inputCostUsd: 0.1,
    outputCostUsd: 0.05,
    reasoningCostUsd: 0,
    cacheReadInputCostUsd: 0,
    cacheCreationInputCostUsd: 0,
    totalCostUsd: 0.15,
  } as const;

  const usageService = createUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId,
    agentId: "agent-1",
    runSender: { type: "user", externalId: "user-1" },
    provider: "openai",
    model: "gpt-test",
    usage: usagePayload,
    cost: costPayload,
  });
  assert(usageId);

  const copilotz = { ops: db.ops } as any;
  const participantResult = await usage({
    query: { namespace, groupBy: "participant", interval: "day" },
  }, copilotz);
  const participantData = participantResult.data as any;
  assertEquals(participantData.points[0].groupKey, "agent-1");
  assertEquals(participantData.points[0].totalTokens, 125);

  const initiatedByResult = await usage({
    query: {
      namespace,
      groupBy: "participant",
      interval: "day",
      attribution: "initiatedBy",
    },
  }, copilotz);
  const initiatedByData = initiatedByResult.data as any;
  assertEquals(initiatedByData.points[0].groupKey, "user-1");
  assertEquals(initiatedByData.points[0].groupLabel, "User One");

  const providerResult = await usage({
    query: { namespace, groupBy: "provider", provider: "openai" },
  }, copilotz);
  const providerData = providerResult.data as any;
  assertEquals(providerData.points[0].groupKey, "openai");
  assertEquals(providerData.totals.totalCostUsd, 0.15);
  assertEquals(providerData.totals.totalCalls, 1);
  assertEquals(providerData.totals.totalTokens, 125);

  const modelResult = await usage({
    query: { namespace, groupBy: "model", model: "gpt-test" },
  }, copilotz);
  const modelData = modelResult.data as any;
  assertEquals(modelData.points[0].groupKey, "gpt-test");

  const threadResult = await usage({
    query: { namespace, groupBy: "thread", threadId },
  }, copilotz);
  const threadData = threadResult.data as any;
  assertEquals(threadData.points[0].groupKey, threadId);
  assertEquals(threadData.points[0].groupLabel, "Usage Thread");
});

Deno.test("admin usage attributes initiatedBy from thread identity fallback", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage-fallback";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Fallback Usage Thread",
    participants: ["user-fallback", "agent-fallback"],
    metadata: {
      system: {
        memory: {
          identity: { userExternalId: "user-fallback" },
        },
      },
    },
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "user-fallback",
    participantType: "human",
    name: "Fallback User",
  });
  await collections.participant.upsertIdentity({
    externalId: "agent-fallback",
    participantType: "agent",
    name: "Fallback Agent",
    agentId: "agent-fallback",
  });

  const usageService = createUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId: "fallback-event",
    agentId: "agent-fallback",
    provider: "openai",
    model: "gpt-fallback",
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      source: "provider",
      status: "completed",
    },
  });
  assert(usageId);

  const result = await usage({
    query: {
      namespace,
      groupBy: "participant",
      interval: "day",
      attribution: "initiatedBy",
    },
  }, { ops: db.ops } as any);
  const data = result.data as any;

  assertEquals(data.points.length, 1);
  assertEquals(data.points[0].groupKey, "user-fallback");
  assertEquals(data.points[0].groupLabel, "Fallback User");
});

Deno.test("admin usage counts usage ledger rows (LLM kind)", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage-ledger";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Ledger Usage Thread",
    participants: ["agent-ledger"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-ledger",
    participantType: "agent",
    name: "Ledger Agent",
    agentId: "agent-ledger",
  });

  const usageService = createUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId: "ledger-event",
    agentId: "agent-ledger",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      inputTokens: 40,
      outputTokens: 4,
      totalTokens: 44,
      source: "provider",
      status: "completed",
    },
    cost: {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "anthropic/claude-test",
      inputCostUsd: 0.02,
      outputCostUsd: 0.01,
      reasoningCostUsd: 0,
      cacheReadInputCostUsd: 0,
      cacheCreationInputCostUsd: 0,
      totalCostUsd: 0.03,
    },
  });
  assert(usageId);

  const result = await usage({
    query: { namespace, groupBy: "provider", provider: "anthropic" },
  }, { ops: db.ops } as any);
  const data = result.data as any;

  assertEquals(data.points.length, 1);
  assertEquals(data.totals.totalCalls, 1);
  assertEquals(data.totals.totalTokens, 44);
  assertEquals(data.totals.totalCostUsd, 0.03);
});

Deno.test("admin usage reads flat metrics from the usage ledger", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage-flat";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Flat Usage Thread",
    participants: ["agent-flat"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-flat",
    participantType: "agent",
    name: "Flat Agent",
    agentId: "agent-flat",
  });

  const usageService = createUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId: "flat-event",
    agentId: "agent-flat",
    provider: "openai",
    model: "gpt-flat",
    usage: {
      inputTokens: 20,
      outputTokens: 3,
      totalTokens: 23,
      source: "provider",
      status: "completed",
    },
    cost: {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "openai/gpt-flat",
      inputCostUsd: 0.02,
      outputCostUsd: 0.01,
      totalCostUsd: 0.03,
    },
  });
  assert(usageId);

  const result = await usage({
    query: { namespace, groupBy: "provider", provider: "openai" },
  }, { ops: db.ops } as any);
  const data = result.data as any;

  assertEquals(data.totals.totalCalls, 1);
  assertEquals(data.totals.totalTokens, 23);
  assertEquals(data.totals.totalCostUsd, 0.03);
});

Deno.test("admin usage aggregates mixed LLM and tool usage ledger rows", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage-mixed";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Mixed Usage Thread",
    participants: ["user-mixed", "agent-mixed"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-mixed",
    participantType: "agent",
    name: "Mixed Agent",
    agentId: "agent-mixed",
  });
  await collections.participant.upsertIdentity({
    externalId: "user-mixed",
    participantType: "human",
    name: "Mixed User",
  });

  const usageService = createUsageService({ ops: db.ops });
  await usageService.createUsageRecord({
    threadId,
    eventId: "mixed-llm",
    agentId: "agent-mixed",
    runSender: { externalId: "user-mixed" },
    provider: "openai",
    model: "gpt-mixed",
    usage: {
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
      source: "provider",
      status: "completed",
    },
    cost: {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "openai/gpt-mixed",
      inputCostUsd: 0.03,
      outputCostUsd: 0.02,
      totalCostUsd: 0.05,
    },
  });
  await usageService.recordUsage({
    kind: "tool",
    resource: "kanban.create_card",
    operation: "tool.exec",
    status: "completed",
    threadId,
    eventId: "mixed-tool-1",
    agentId: "agent-mixed",
    initiatedById: "user-mixed",
    metrics: { calls: 1, durationMs: 1200 },
    cost: { currency: "USD", total: 0.2, source: "custom" },
    dedupeKey: "tool-1",
  });
  await usageService.recordUsage({
    kind: "tool",
    resource: "sandbox.exec",
    operation: "tool.exec",
    status: "failed",
    threadId,
    eventId: "mixed-tool-2",
    agentId: "agent-mixed",
    initiatedById: "user-mixed",
    metrics: { calls: 1, durationMs: 300, credits: 2 },
    dedupeKey: "tool-2",
  });

  const defaultResult = await usage({
    query: { namespace, groupBy: "kind" },
  }, { ops: db.ops } as any);
  const defaultData = defaultResult.data as any;
  assertEquals(defaultData.points.length, 1);
  assertEquals(defaultData.points[0].groupKey, "llm");
  assertEquals(defaultData.totals.totalCalls, 1);

  const allKindsResult = await usage({
    query: { namespace, kind: "all", groupBy: "kind" },
  }, { ops: db.ops } as any);
  const allKindsData = allKindsResult.data as any;
  const totalsByKind = new Map(
    allKindsData.points.map((point: any) => [point.groupKey, point]),
  );

  assertEquals(allKindsData.totals.totalCalls, 3);
  assertEquals(allKindsData.totals.totalTokens, 40);
  assertEquals(allKindsData.totals.totalCostUsd, 0.25);
  assertEquals(allKindsData.totals.totalDurationMs, 1500);
  assertEquals(allKindsData.totals.failedCalls, 1);
  assertEquals(allKindsData.totals.unpricedCalls, 1);
  assertEquals(allKindsData.totals.totalCredits, 2);
  assertEquals((totalsByKind.get("llm") as any).totalCalls, 1);
  assertEquals((totalsByKind.get("tool") as any).totalCalls, 2);

  const toolResult = await usage({
    query: { namespace, kind: "tool", groupBy: "resource" },
  }, { ops: db.ops } as any);
  const toolData = toolResult.data as any;
  const totalsByResource = new Map(
    toolData.points.map((point: any) => [point.groupKey, point]),
  );
  assertEquals(toolData.totals.totalCalls, 2);
  assertEquals(
    (totalsByResource.get("kanban.create_card") as any).totalCostUsd,
    0.2,
  );
  assertEquals((totalsByResource.get("sandbox.exec") as any).failedCalls, 1);

  const failedToolResult = await usage({
    query: { namespace, kind: "tool", groupBy: "status", status: "failed" },
  }, { ops: db.ops } as any);
  const failedToolData = failedToolResult.data as any;
  assertEquals(failedToolData.points.length, 1);
  assertEquals(failedToolData.points[0].groupKey, "failed");
  assertEquals(failedToolData.totals.totalDurationMs, 300);
});

Deno.test("admin aggregate endpoints read the usage ledger", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-admin-aggregates";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Aggregate Usage Thread",
    participants: ["agent-aggregate"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-aggregate",
    participantType: "agent",
    name: "Aggregate Agent",
    agentId: "agent-aggregate",
  });

  const usageService = createUsageService({ ops: db.ops });
  await usageService.createUsageRecord({
    threadId,
    eventId: "aggregate-event",
    agentId: "agent-aggregate",
    provider: "openai",
    model: "gpt-aggregate",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      source: "provider",
      status: "completed",
    },
    cost: {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "openai/gpt-aggregate",
      inputCostUsd: 0.01,
      outputCostUsd: 0.02,
      totalCostUsd: 0.03,
    },
  });

  const copilotz = { ops: db.ops, config: { agents: [] } } as any;

  const overviewResult = await overview({ query: { namespace } }, copilotz);
  assertEquals((overviewResult.data as any).llmTotals.totalCalls, 1);
  assertEquals((overviewResult.data as any).llmTotals.totalTokens, 15);
  assertEquals((overviewResult.data as any).llmTotals.totalCostUsd, 0.03);

  const activityResult = await activity({
    query: { namespace, interval: "day" },
  }, copilotz);
  assertEquals((activityResult.data as any[])[0].llmCallCount, 1);
  assertEquals((activityResult.data as any[])[0].totalTokens, 15);

  const agentsResult = await agents({ query: { namespace } }, copilotz);
  assertEquals((agentsResult.data as any[])[0].agentId, "agent-aggregate");
  assertEquals((agentsResult.data as any[])[0].llmCallCount, 1);
  assertEquals((agentsResult.data as any[])[0].totalCostUsd, 0.03);
});
