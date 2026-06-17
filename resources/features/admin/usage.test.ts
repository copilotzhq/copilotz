import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import usage from "./usage.ts";
import { createDatabase } from "@/database/index.ts";
import { createCollectionsManager } from "@/database/collections/index.ts";
import participantCollection from "@/resources/collections/participant.ts";
import { createLlmUsageService } from "@/runtime/collections/native.ts";

Deno.test("admin usage groups by participant, thread, provider, and model", async () => {
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

  const usageService = createLlmUsageService({ ops: db.ops });
  const usageId = await usageService.createUsageRecord({
    threadId,
    eventId: "event-1",
    agentId: "agent-1",
    runSender: { type: "user", externalId: "user-1" },
    provider: "openai",
    model: "gpt-test",
    usage: {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      source: "provider",
      status: "completed",
    },
    cost: {
      source: "openrouter",
      currency: "USD",
      pricingModelId: "openai/gpt-test",
      inputCostUsd: 0.1,
      outputCostUsd: 0.05,
      reasoningCostUsd: 0,
      cacheReadInputCostUsd: 0,
      cacheCreationInputCostUsd: 0,
      totalCostUsd: 0.15,
    },
  });
  assert(usageId);

  const copilotz = { ops: db.ops } as any;
  const participantResult = await usage({
    query: { namespace, groupBy: "participant", interval: "day" },
  }, copilotz);
  const participantData = participantResult.data as any;
  assertEquals(participantData.points[0].groupKey, "agent-1");
  assertEquals(participantData.points[0].totalTokens, 125);

  const providerResult = await usage({
    query: { namespace, groupBy: "provider", provider: "openai" },
  }, copilotz);
  const providerData = providerResult.data as any;
  assertEquals(providerData.points[0].groupKey, "openai");
  assertEquals(providerData.totals.totalCostUsd, 0.15);

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
