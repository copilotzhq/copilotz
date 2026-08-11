import { assert, assertEquals, assertExists } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import {
  createUsageWorkflowPlugin,
  type CreateUsageWorkflowPluginOptions,
} from "./index.ts";

const NAMESPACE = "tenant-a";
const THREAD_ID = "thread-a";

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
}>;

async function createFixture(
  options: CreateUsageWorkflowPluginOptions = {},
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({
    plugins: [createUsageWorkflowPlugin(options)],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    schema: "copilotz_usage_workflow",
    retryBaseMs: 0,
    random: () => 0,
  });
  await engine.conversation.createThread({
    namespace: NAMESPACE,
    id: THREAD_ID,
    participants: [
      {
        id: "user-node",
        externalId: "user-external",
        participantType: "human",
      },
      {
        id: "agent-node",
        externalId: "north",
        participantType: "agent",
        agentId: "north",
      },
    ],
  });
  return Object.freeze({ db, engine });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

async function waitForSettlement(
  engine: CopilotzEngine,
  eventId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settlement = await engine.events.settlement(NAMESPACE, eventId);
    if (settlement.unsettled === 0 && settlement.deadLetters === 0) return;
    if (settlement.deadLetters > 0) {
      throw new Error(`Usage event '${eventId}' dead-lettered.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for usage event '${eventId}'.`);
}

function providerMetadata(parentLlmAttemptId: string) {
  return {
    copilotzWorkflow: {
      kind: "provider_attempt",
      parentLlmAttemptId,
      agentParticipantId: "agent-node",
    },
  };
}

Deno.test("usage workflow is a factory-created plugin and can disable metering", () => {
  const enabled = createUsageWorkflowPlugin();
  assertEquals(enabled.manifest.provides.collections, ["usage"]);
  assertEquals(enabled.manifest.provides.processors, [
    "copilotz.core.record-llm-usage",
    "copilotz.core.record-tool-usage",
  ]);
  assertEquals(enabled.resources.collections?.length, 1);
  assertEquals(enabled.resources.processors?.length, 2);

  const disabled = createUsageWorkflowPlugin({ enabled: false });
  assertEquals(disabled.manifest.provides.collections, ["usage"]);
  assertEquals(disabled.manifest.provides.processors, undefined);
  assertEquals(disabled.resources.processors, undefined);
});

Deno.test("usage workflow records physical provider attempts and tools once without payload copies", async () => {
  const hookKinds: string[] = [];
  const fixture = await createFixture({
    async resolveCost(event, context) {
      const fallback = await context.defaultResolve();
      return {
        currency: "USD",
        total: event.kind === "tool" ? 0.5 : (fallback?.total ?? 0) * 2,
        source: "contract-pricing",
        ...(fallback?.pricingModelId
          ? { pricingModelId: fallback.pricingModelId }
          : {}),
        ...(fallback?.breakdown ? { breakdown: fallback.breakdown } : {}),
      };
    },
    onRecord(record) {
      hookKinds.push(record.kind);
      return {
        ...record,
        metrics: { ...record.metrics, hookObserved: 1 },
      };
    },
  });
  try {
    const logical = await fixture.engine.llmAttempts.create({
      namespace: NAMESPACE,
      id: "logical-1",
      threadId: THREAD_ID,
      participantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
      status: "running",
    });
    const logicalAnswer = await fixture.engine.content.preparer.prepare(
      "logical output must not be copied into usage",
      { namespace: NAMESPACE, idempotencyKey: "logical-1:answer" },
    );
    const logicalTerminal = await fixture.engine.llmAttempts.complete({
      namespace: NAMESPACE,
      id: logical.value!.id,
      answer: logicalAnswer,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
    await waitForSettlement(fixture.engine, logicalTerminal.event.id);

    await fixture.engine.llmAttempts.create({
      namespace: NAMESPACE,
      id: "logical-1:provider:0",
      threadId: THREAD_ID,
      participantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
      provider: "openai",
      model: "primary-model",
      parentAttemptId: logical.value!.id,
      status: "running",
      metadata: providerMetadata(logical.value!.id),
    });
    const providerAnswer = await fixture.engine.content.preparer.prepare(
      "provider output must not be copied into usage",
      { namespace: NAMESPACE, idempotencyKey: "provider-0:answer" },
    );
    const completed = await fixture.engine.llmAttempts.complete({
      namespace: NAMESPACE,
      id: "logical-1:provider:0",
      answer: providerAnswer,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        source: "provider",
        rawUsage: { requestId: "req-safe" },
      },
      cost: {
        source: "openrouter",
        currency: "USD",
        pricingModelId: "openai/primary-model",
        inputCostUsd: 0.01,
        outputCostUsd: 0.01,
        totalCostUsd: 0.02,
      },
      finishedAt: "2026-08-06T12:00:01.000Z",
      metricsFinalizedAt: "2026-08-06T12:00:01.000Z",
    });

    await fixture.engine.llmAttempts.create({
      namespace: NAMESPACE,
      id: "logical-1:provider:1",
      threadId: THREAD_ID,
      participantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
      provider: "openai",
      model: "fallback-model",
      parentAttemptId: logical.value!.id,
      attemptIndex: 1,
      status: "running",
      metadata: providerMetadata(logical.value!.id),
    });
    const failed = await fixture.engine.llmAttempts.fail({
      namespace: NAMESPACE,
      id: "logical-1:provider:1",
      safeError: { message: "provider unavailable", code: "server_error" },
      usage: { inputTokens: 4, totalTokens: 4, source: "provider" },
      finishedAt: "2026-08-06T12:00:02.000Z",
    });

    await fixture.engine.llmAttempts.create({
      namespace: NAMESPACE,
      id: "logical-1:provider:2",
      threadId: THREAD_ID,
      participantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
      provider: "openai",
      model: "hedged-model",
      parentAttemptId: logical.value!.id,
      attemptIndex: 2,
      status: "running",
      metadata: providerMetadata(logical.value!.id),
    });
    const superseded = await fixture.engine.llmAttempts.update({
      namespace: NAMESPACE,
      id: "logical-1:provider:2",
      status: "superseded",
      usage: { inputTokens: 2, totalTokens: 2, source: "provider" },
      metricsFinalizedAt: "2026-08-06T12:00:03.000Z",
    });

    const argumentsContent = await fixture.engine.content.preparer.prepare(
      { type: "json", value: { secretPrompt: "do not duplicate" } },
      { namespace: NAMESPACE, idempotencyKey: "tool-1:arguments" },
    );
    await fixture.engine.toolExecutions.create({
      namespace: NAMESPACE,
      id: "tool-1",
      threadId: THREAD_ID,
      participantId: "agent-node",
      agentId: "north",
      toolCallId: "call-1",
      tool: { id: "lookup", name: "Lookup" },
      arguments: argumentsContent,
      status: "running",
      metadata: {
        copilotzWorkflow: {
          kind: "tool_execution",
          llmAttemptId: logical.value!.id,
        },
      },
    });
    const toolOutput = await fixture.engine.content.preparer.prepare(
      { type: "json", value: { privateResult: "do not duplicate" } },
      { namespace: NAMESPACE, idempotencyKey: "tool-1:output" },
    );
    const toolTerminal = await fixture.engine.toolExecutions.complete({
      namespace: NAMESPACE,
      id: "tool-1",
      output: toolOutput,
      durationMs: 25,
      finishedAt: "2026-08-06T12:00:04.000Z",
    });

    await Promise.all([
      completed,
      failed,
      superseded,
      toolTerminal,
    ].map((result) => waitForSettlement(fixture.engine, result.event.id)));

    const rows = [
      ...await fixture.engine.collections.get("usage").list(
        NAMESPACE,
      ),
    ].sort((left, right) => left.id.localeCompare(right.id));
    assertEquals(rows.length, 4);
    assertEquals(rows.map((row) => row.id), [
      "usage:llm:logical-1:provider:0",
      "usage:llm:logical-1:provider:1",
      "usage:llm:logical-1:provider:2",
      "usage:tool:tool-1",
    ]);
    assertEquals(hookKinds.sort(), ["llm", "llm", "llm", "tool"]);

    const first = rows[0];
    assertEquals(first.kind, "llm");
    assertEquals(first.resource, "primary-model");
    assertEquals(first.initiatedById, "user-external");
    assertEquals(first.metrics, {
      calls: 1,
      hookObserved: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    assertEquals(first.totalCostUsd, 0.04);
    assertEquals(first.pricingSource, "contract-pricing");
    assertEquals(first.rawUsage, { requestId: "req-safe" });

    const tool = rows[3];
    assertEquals(tool.kind, "tool");
    assertEquals(tool.resource, "lookup");
    assertEquals(tool.metrics, { calls: 1, durationMs: 25, hookObserved: 1 });
    assertEquals(tool.totalCostUsd, 0.5);
    assertEquals(tool.initiatedById, "user-external");

    const serialized = JSON.stringify(rows);
    assert(!serialized.includes("provider output must not be copied"));
    assert(!serialized.includes("do not duplicate"));

    await fixture.engine.recover({ namespace: NAMESPACE });
    assertEquals(
      (await fixture.engine.collections.get("usage").list(NAMESPACE)).length,
      4,
    );
  } finally {
    await closeFixture(fixture);
  }
});
