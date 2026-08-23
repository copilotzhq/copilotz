import { assert, assertEquals } from "@std/assert";
import {
  createUsageWorkflowPlugin,
  type CreateUsageWorkflowPluginOptions,
} from "./index.ts";
import { createCopilotz } from "../../index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
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
import type { LlmCallInput, LlmCallOutput } from "../llm/contracts.ts";

const NAMESPACE = "tenant-a";
const THREAD_ID = "thread-a";

function llmOutput(
  model: string,
  input: Readonly<{
    usage: NonNullable<LlmCallOutput["usage"]>;
    attempts?: NonNullable<LlmCallOutput["attempts"]>;
    secret?: string;
  }>,
): LlmCallOutput {
  const secret = input.secret ?? "provider-output-must-not-be-copied";
  return Object.freeze({
    model,
    adapter: "openai-primary",
    providerModel: "gpt-5-mini-test",
    content: Object.freeze([Object.freeze({
      assetId: secret,
      kind: "text" as const,
      mediaType: "text/plain",
      role: "body" as const,
    })]),
    toolCalls: Object.freeze([Object.freeze({
      id: "tool-call-1",
      action: "lookup",
      input: Object.freeze({ secretPrompt: "tool-call-must-not-be-copied" }),
    })]),
    usage: input.usage,
    ...(input.attempts ? { attempts: input.attempts } : {}),
    finishReason: "stop",
  });
}

const usageLlmAction = defineAction<LlmCallInput, LlmCallOutput>({
  id: "llm.call",
  execute(input) {
    if (input.model === "failing-model") {
      throw new Error("provider unavailable");
    }
    if (input.model === "cancelled-model") {
      throw new DOMException("cancelled by caller", "AbortError");
    }
    if (input.model === "aggregate-model") {
      return llmOutput(input.model, {
        usage: Object.freeze({
          inputTokens: 23,
          outputTokens: 7,
          reasoningTokens: 2,
          cachedInputTokens: 5,
          totalTokens: 32,
          cost: Object.freeze({ amount: 0.031, currency: "USD" }),
        }),
        attempts: Object.freeze([
          Object.freeze({
            id: "aggregate-attempt-0",
            index: 0,
            adapter: "openai-primary",
            providerModel: "fallback-a",
            status: "failed" as const,
            usage: Object.freeze({
              inputTokens: 100,
              totalTokens: 100,
              cost: Object.freeze({ amount: 9, currency: "EUR" }),
            }),
            error: Object.freeze({
              code: "attempt_secret_code",
              message: "attempt-secret-must-not-be-copied",
            }),
          }),
          Object.freeze({
            id: "aggregate-attempt-1",
            index: 1,
            adapter: "openai-primary",
            providerModel: "gpt-5-mini-test",
            status: "completed" as const,
            usage: Object.freeze({
              inputTokens: 200,
              outputTokens: 80,
              totalTokens: 280,
              cost: Object.freeze({ amount: 12, currency: "GBP" }),
            }),
            finishReason: "stop",
          }),
        ]),
        secret: "aggregate-content-must-not-be-copied",
      });
    }
    if (input.model === "uncosted-model") {
      return llmOutput(input.model, {
        usage: Object.freeze({
          inputTokens: 4,
          outputTokens: 3,
          cachedInputTokens: 1,
          totalTokens: 7,
        }),
        attempts: Object.freeze([
          Object.freeze({
            id: "uncosted-attempt-0",
            index: 0,
            adapter: "openai-primary",
            providerModel: "fallback-usd",
            status: "failed" as const,
            usage: Object.freeze({
              inputTokens: 40,
              totalTokens: 40,
              cost: Object.freeze({ amount: 1, currency: "USD" }),
            }),
            error: Object.freeze({ message: "first currency failed" }),
          }),
          Object.freeze({
            id: "uncosted-attempt-1",
            index: 1,
            adapter: "openai-primary",
            providerModel: "fallback-eur",
            status: "completed" as const,
            usage: Object.freeze({
              inputTokens: 50,
              outputTokens: 20,
              totalTokens: 70,
              cost: Object.freeze({ amount: 2, currency: "EUR" }),
            }),
          }),
        ]),
        secret: "uncosted-content-must-not-be-copied",
      });
    }
    return llmOutput(input.model, {
      usage: Object.freeze({
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cachedInputTokens: 3,
        totalTokens: 17,
        cost: Object.freeze({ amount: 0.02, currency: "USD" }),
      }),
    });
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
          const data = event.data as Record<string, unknown>;
          const metadata = data.metadata && typeof data.metadata === "object" &&
              !Array.isArray(data.metadata)
            ? data.metadata as Readonly<Record<string, unknown>>
            : Object.freeze({});
          await context.actions.usageLlm(data.input as LlmCallInput, {
            operationKey: String(data.key),
            metadata,
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
  assertEquals(
    enabled.processors.recordLlmUsage?.on.map((clause) => clause.eventType),
    ["llm.call.completed", "llm.call.failed", "llm.call.cancelled"],
  );

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
    const toolCommon = {
      threadId: THREAD_ID,
      messageId: "message-1",
      participantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
    };
    await invoke("test.usage.llm", {
      key: "provider-0",
      input: {
        model: "primary-model",
        request: {
          instructions: "prompt-must-not-be-copied",
          messages: [],
        },
      },
      metadata: {
        schema: "copilotz.core.llm-call.v1",
        threadId: THREAD_ID,
        triggerMessageId: "message-1",
        agentId: "north",
        agentParticipantId: "agent-node",
        initiatorParticipantId: "user-node",
        availableToolIds: [],
      },
    });
    await invoke("test.usage.llm", {
      key: "provider-1",
      input: {
        model: "failing-model",
        request: { messages: [] },
      },
      metadata: { source: "standalone-test" },
    });
    await invoke("test.usage.tool", {
      ...toolCommon,
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
    assertEquals(first.model, "primary-model");
    assertEquals(first.adapter, "openai-primary");
    assertEquals(first.providerModel, "gpt-5-mini-test");
    assertEquals(first.provider, null);
    assertEquals(first.operation, "llm.call");
    assertEquals(first.threadId, THREAD_ID);
    assertEquals(first.messageId, "message-1");
    assertEquals(first.agentId, "north");
    assertEquals(first.initiatedById, "user-external");
    assertEquals(first.metrics, {
      calls: 1,
      cachedInputTokens: 3,
      hookObserved: 1,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 17,
    });
    assertEquals(first.totalCostUsd, 0.04);
    assertEquals(first.pricingCurrency, "USD");
    assertEquals(first.pricingModelId, "gpt-5-mini-test");
    assertEquals(first.pricingSource, "contract-pricing");
    assertEquals(first.rawUsage, null);

    const unattributed = rows.find((row) => row.resource === "failing-model")!;
    assertEquals(unattributed.status, "failed");
    assertEquals(unattributed.threadId, null);
    assertEquals(unattributed.messageId, null);
    assertEquals(unattributed.agentId, null);
    assertEquals(unattributed.initiatedById, null);

    const toolRow = rows.find((row) => row.kind === "tool")!;
    assertEquals(toolRow.resource, "lookup");
    assertEquals(toolRow.metrics, {
      calls: 1,
      durationMs: 25,
      hookObserved: 1,
    });
    assertEquals(toolRow.totalCostUsd, 0.5);
    assertEquals(toolRow.initiatedById, "user-external");
    const serialized = JSON.stringify(rows);
    assert(!serialized.includes("prompt-must-not-be-copied"));
    assert(!serialized.includes("provider-output-must-not-be-copied"));
    assert(!serialized.includes("tool-call-must-not-be-copied"));
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

Deno.test("usage persists only llm.call aggregate accounting", async () => {
  const fixture = await createFixture();
  try {
    const invoke = async (model: string) => {
      const key = `aggregate:${model}`;
      const appended = await fixture.engine.events.append({
        type: "test.usage.llm",
        namespace: NAMESPACE,
        threadId: THREAD_ID,
        payload: {
          key,
          input: {
            model,
            request: {
              instructions: `${model}-prompt-must-not-be-copied`,
              messages: [],
            },
          },
          metadata: {},
        },
        correlationId: key,
        deduplicationId: `${key}:requested`,
      });
      await Promise.all(appended.dispatch.handles.map((handle) => handle.done));
    };

    await invoke("aggregate-model");
    await invoke("uncosted-model");
    await invoke("failing-model");
    await invoke("cancelled-model");

    const usage = fixture.engine.collections.withScope({ namespace: NAMESPACE })
      .usage;
    const deadline = Date.now() + 10_000;
    while ((await usage.list()).length < 4) {
      if (Date.now() >= deadline) {
        throw new Error("Aggregate Usage Actions did not settle.");
      }
      await fixture.engine.recover({ namespace: NAMESPACE });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const rows = await usage.list();
    assertEquals(rows.length, 4);

    const aggregate = rows.find((row) => row.resource === "aggregate-model")!;
    assertEquals(aggregate.metrics, {
      calls: 1,
      inputTokens: 23,
      outputTokens: 7,
      reasoningTokens: 2,
      cachedInputTokens: 5,
      totalTokens: 32,
    });
    assertEquals(aggregate.totalCostUsd, 0.031);
    assertEquals(aggregate.pricingCurrency, "USD");
    assertEquals(aggregate.pricingSource, "openai-primary");
    assertEquals(aggregate.pricingModelId, "gpt-5-mini-test");

    const uncosted = rows.find((row) => row.resource === "uncosted-model")!;
    assertEquals(uncosted.metrics, {
      calls: 1,
      inputTokens: 4,
      outputTokens: 3,
      cachedInputTokens: 1,
      totalTokens: 7,
    });
    assertEquals(uncosted.totalCostUsd, null);
    assertEquals(uncosted.pricingCurrency, null);
    assertEquals(uncosted.pricingSource, null);
    assertEquals(uncosted.pricingModelId, null);

    for (
      const [model, status] of [
        ["failing-model", "failed"],
        ["cancelled-model", "cancelled"],
      ] as const
    ) {
      const terminal = rows.find((row) => row.resource === model)!;
      assertEquals(terminal.model, model);
      assertEquals(terminal.status, status);
      assertEquals(terminal.adapter, null);
      assertEquals(terminal.providerModel, null);
      assertEquals(terminal.metrics, { calls: 1 });
      assertEquals(terminal.totalCostUsd, null);
      assertEquals(terminal.threadId, null);
    }

    const serialized = JSON.stringify(rows);
    assert(!serialized.includes("aggregate-attempt-0"));
    assert(!serialized.includes("uncosted-attempt-0"));
    assert(!serialized.includes("attempt-secret-must-not-be-copied"));
    assert(!serialized.includes("prompt-must-not-be-copied"));
    assert(!serialized.includes("content-must-not-be-copied"));
    assert(!serialized.includes("tool-call-must-not-be-copied"));
    assert(!serialized.includes("EUR"));
    assert(!serialized.includes("GBP"));

    await fixture.engine.recover({ namespace: NAMESPACE });
    assertEquals((await usage.list()).length, 4);
  } finally {
    await closeFixture(fixture);
  }
});
