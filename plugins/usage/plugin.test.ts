import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createUsageWorkflowPlugin,
  type CreateUsageWorkflowPluginOptions,
} from "./index.ts";
import { createCopilotz } from "../../index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
} from "../../runtime/testing/projections.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import { createSqlSession } from "../../runtime/events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../../runtime/plugins/index.ts";
import {
  type ActionCallers,
  defineAction,
} from "../../runtime/actions/index.ts";
import { coreCollections, createThreadAction } from "../core/index.ts";

const NAMESPACE = "tenant-a";
const THREAD_ID = "thread-a";

const usageLlmAction = defineAction<unknown, unknown>({
  id: "copilotz.core.llm.generate",
  execute(input: unknown) {
    const value = input as Record<string, unknown>;
    if (value.fail) throw new Error(String(value.fail));
    return value.result;
  },
});

const usageToolAction = defineAction<unknown, unknown>({
  id: "copilotz.core.tool.call",
  execute(input: unknown) {
    return (input as Record<string, unknown>).result;
  },
});

type UsageDriverContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{
    usageLlm: typeof usageLlmAction;
    usageTool: typeof usageToolAction;
  }>,
  ProcessorContext["collections"]
>;

const usageCorePlugin = definePlugin({
  id: "test.usage-core",
  version: "1.0.0",
  collections: coreCollections,
  actions: { createThread: createThreadAction },
});

const usageActionDriverPlugin = definePlugin({
  id: "test.usage-action-driver",
  version: "1.0.0",
  actions: {
    usageLlm: usageLlmAction,
    usageTool: usageToolAction,
  },
  processors: {
    actionDriver: defineProcessor<UsageDriverContext>({
      id: "test.usage-action-driver",
      on: [
        { eventType: "test.usage.llm" },
        { eventType: "test.usage.tool" },
      ],
      async handle(event, context) {
        if (event.type === "test.usage.llm") {
          await context.actions.usageLlm(event.data, {
            operationKey: String((event.data as Record<string, unknown>).key),
          }).catch(() => undefined);
          return;
        }
        await context.actions.usageTool(event.data, {
          operationKey: String((event.data as Record<string, unknown>).key),
        });
      },
    }),
  },
});

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
}>;

async function createFixture(
  options: CreateUsageWorkflowPluginOptions = {},
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({
    plugins: [
      usageCorePlugin,
      createUsageWorkflowPlugin(options),
      usageActionDriverPlugin,
    ],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: "copilotz_usage_workflow",
    retryBaseMs: 0,
    random: () => 0,
  });
  await createTestDomainContext(engine, NAMESPACE).actions.createThread({
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

Deno.test("usage workflow is a factory-created plugin and can disable metering", () => {
  const enabled = createUsageWorkflowPlugin();
  assertEquals(Object.keys(enabled.collections), ["usage"]);
  assertEquals(Object.keys(enabled.processors), [
    "recordLlmUsage",
    "recordToolUsage",
  ]);

  const disabled = createUsageWorkflowPlugin({ enabled: false });
  assertEquals(Object.keys(disabled.collections), ["usage"]);
  assertEquals(Object.keys(disabled.processors), []);
});

Deno.test("package-root composes an explicitly supplied usage plugin", async () => {
  const application = await createCopilotz({
    namespace: "usage-root",
    plugins: [createUsageWorkflowPlugin({ enabled: false })],
  });
  try {
    assert(application.plugins.collections.usage);
    assertEquals(
      application.config.pluginIds.includes("@copilotz/core-usage"),
      true,
    );
  } finally {
    await application.shutdown();
  }
});

Deno.test("usage workflow records Action terminals once without payload copies", async () => {
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
    const invoke = async (
      type: "test.usage.llm" | "test.usage.tool",
      payload: Record<string, unknown>,
    ) => {
      const appended = await fixture.engine.events.append({
        type,
        namespace: NAMESPACE,
        threadId: THREAD_ID,
        payload,
        correlationId: `usage:${String(payload.key)}`,
        deduplicationId: `usage:${String(payload.key)}:requested`,
      });
      await Promise.all(appended.dispatch.handles.map((handle) => handle.done));
    };
    const common = {
      threadId: THREAD_ID,
      messageId: "message-1",
      participantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
    };
    await invoke("test.usage.llm", {
      ...common,
      key: "provider-0",
      result: {
        provider: "openai",
        model: "primary-model",
        answer: "provider output must not be copied into usage",
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
        metricsFinalizedAt: "2026-08-06T12:00:01.000Z",
      },
    });
    await invoke("test.usage.llm", {
      ...common,
      key: "provider-1",
      fail: "provider unavailable",
    });
    await invoke("test.usage.tool", {
      ...common,
      key: "tool-1",
      tool: { id: "lookup", name: "Lookup" },
      arguments: { secretPrompt: "do not duplicate" },
      result: {
        status: "completed",
        output: { privateResult: "do not duplicate" },
        durationMs: 25,
      },
    });

    const deadline = Date.now() + 10_000;
    const usage = fixture.engine.collections.withScope({ namespace: NAMESPACE })
      .usage;
    while ((await usage.list()).length < 3) {
      if (Date.now() >= deadline) {
        throw new Error("Usage Actions did not settle.");
      }
      await fixture.engine.recover({ namespace: NAMESPACE });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const rows = [
      ...await usage.list(),
    ].sort((left, right) => left.id.localeCompare(right.id));
    assertEquals(rows.length, 3);
    assertEquals(hookKinds.sort(), ["llm", "llm", "tool"]);

    const first = rows.find((row) => row.resource === "primary-model")!;
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

    const toolRow = rows.find((row) => row.kind === "tool")!;
    assertEquals(toolRow.resource, "lookup");
    assertEquals(toolRow.metrics, {
      calls: 1,
      durationMs: 25,
      hookObserved: 1,
    });
    assertEquals(toolRow.totalCostUsd, 0.5);
    assertEquals(toolRow.initiatedById, "user-external");
    assertEquals(rows.some((row) => row.status === "failed"), true);

    const serialized = JSON.stringify(rows);
    assert(!serialized.includes("provider output must not be copied"));
    assert(!serialized.includes("do not duplicate"));

    await fixture.engine.recover({ namespace: NAMESPACE });
    assertEquals(
      (await usage.list()).length,
      3,
    );
  } finally {
    await closeFixture(fixture);
  }
});
