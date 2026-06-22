import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import usage from "./usage.ts";
import { createDatabase } from "@/database/index.ts";
import { createCollectionsManager } from "@/database/collections/index.ts";
import participantCollection from "@/resources/collections/participant.ts";
import { createLlmUsageService } from "@/runtime/collections/native.ts";
import activity from "./activity.ts";
import agents from "./agents.ts";
import overview from "./overview.ts";

Deno.test("admin usage groups canonical llm_attempt rows without double-counting llm_usage projections", async () => {
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

  const attempt = await db.ops.mutate.llmAttempts.create({
    threadId,
    eventId,
    agentId: "agent-1",
    agentName: "Agent One",
    runSender: { type: "user", externalId: "user-1" },
    provider: "openai",
    model: "gpt-test",
    namespace,
  });
  await db.ops.mutate.llmAttempts.complete(String(attempt.id), {
    usage: usagePayload,
    cost: costPayload,
    finishedAt: new Date().toISOString(),
  }, { threadId, namespace });

  const usageService = createLlmUsageService({ ops: db.ops });
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

Deno.test("admin usage falls back to legacy llm_usage rows without attempts", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage-legacy";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Legacy Usage Thread",
    participants: ["agent-legacy"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-legacy",
    participantType: "agent",
    name: "Legacy Agent",
    agentId: "agent-legacy",
  });

  const usageService = createLlmUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId: "legacy-event",
    agentId: "agent-legacy",
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

  assertEquals(data.points[0].groupKey, "anthropic");
  assertEquals(data.totals.totalCalls, 1);
  assertEquals(data.totals.totalTokens, 44);
  assertEquals(data.totals.totalCostUsd, 0.03);
});

Deno.test("admin usage fills missing llm_attempt metrics from matching llm_usage projection", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const namespace = "tenant-usage-coalesce";
  const threadId = crypto.randomUUID();
  await db.ops.findOrCreateThread(threadId, {
    namespace,
    name: "Coalesced Usage Thread",
    participants: ["agent-coalesce"],
  });

  const manager = createCollectionsManager(db, [participantCollection]);
  const collections = manager.withNamespace(namespace);
  await collections.participant.upsertIdentity({
    externalId: "agent-coalesce",
    participantType: "agent",
    name: "Coalesce Agent",
    agentId: "agent-coalesce",
  });

  const eventId = "coalesce-event";
  await db.ops.mutate.llmAttempts.create({
    threadId,
    eventId,
    agentId: "agent-coalesce",
    agentName: "Coalesce Agent",
    provider: "openai",
    model: "gpt-coalesce",
    namespace,
  });

  const usageService = createLlmUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId,
    agentId: "agent-coalesce",
    provider: "openai",
    model: "gpt-coalesce",
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
      pricingModelId: "openai/gpt-coalesce",
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

Deno.test("admin aggregate endpoints read llm_attempt usage", async () => {
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

  const attempt = await db.ops.mutate.llmAttempts.create({
    threadId,
    eventId: "aggregate-event",
    agentId: "agent-aggregate",
    agentName: "Aggregate Agent",
    provider: "openai",
    model: "gpt-aggregate",
    namespace,
  });
  await db.ops.mutate.llmAttempts.complete(String(attempt.id), {
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
    finishedAt: new Date().toISOString(),
  }, { threadId, namespace });

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
