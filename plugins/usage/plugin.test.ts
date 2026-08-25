import { assert, assertEquals } from "@std/assert";
import {
  createUsageWorkflowPlugin,
  type CreateUsageWorkflowPluginOptions,
} from "./index.ts";
import { createCopilotzApplication } from "../../runtime/application/application.ts";
import { createTestDomainContext } from "../core/internal/testing/context.ts";
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
import type { LlmCallInput, LlmCallOutput } from "@copilotz/copilotz/llm";

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
  const attempts = input.attempts ?? Object.freeze([Object.freeze({
    id: `${model}-attempt-0`,
    index: 0,
    providerRequest: true,
    model,
    adapter: "openai-primary",
    providerModel: "gpt-5-mini-test",
    status: "completed" as const,
    usage: input.usage,
    finishReason: "stop",
  })]);
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
    attempts,
    finishReason: "stop",
  });
}

const usageLlmAction = defineAction<LlmCallInput, LlmCallOutput>({
  id: "llm.call",
  async execute(input, context) {
    const model = input.models[0];
    if (model === "failing-model") {
      await context.progress({
        schema: "copilotz.llm.attempt-accounting.v1",
        attempts: [{
          id: "failing-attempt-0",
          index: 0,
          providerRequest: true,
          model,
          adapter: "openai-primary",
          providerModel: "gpt-5-mini-test",
          status: "failed",
          error: { code: "provider_unavailable", message: "not copied" },
        }],
      });
      throw new Error("provider unavailable");
    }
    if (model === "cancelled-model") {
      await context.progress({
        schema: "copilotz.llm.attempt-accounting.v1",
        attempts: [{
          id: "cancelled-attempt-0",
          index: 0,
          providerRequest: true,
          model,
          adapter: "openai-primary",
          providerModel: "gpt-5-mini-test",
          status: "cancelled",
          error: { code: "cancelled", message: "not copied" },
        }],
      });
      throw new DOMException("cancelled by caller", "AbortError");
    }
    if (model === "reported-failure") {
      await context.progress({
        schema: "copilotz.llm.attempt-accounting.v1",
        attempts: [{
          id: "reported-failure-attempt-0",
          index: 0,
          providerRequest: true,
          model,
          adapter: "openai-primary",
          providerModel: "gpt-5-mini-test",
          status: "failed",
          usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
          error: { code: "malformed_tool_call", message: "not copied" },
        }],
      });
      throw new Error("framework rejected provider output");
    }
    if (model === "aggregate-model") {
      return llmOutput(model, {
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
            providerRequest: true,
            model: "aggregate-model",
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
            providerRequest: true,
            model: "aggregate-model",
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
    if (model === "uncosted-model") {
      return llmOutput(model, {
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
            providerRequest: true,
            model: "uncosted-model",
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
            providerRequest: true,
            model: "uncosted-model",
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
    return llmOutput(model, {
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
  id: "test.lookup",
  execute(input: unknown) {
    const value = input as Record<string, unknown>;
    if (value.mode === "failed") throw new Error("lookup failed");
    if (value.mode === "cancelled") {
      throw new DOMException("lookup cancelled", "AbortError");
    }
    return value.result;
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
        const data = event.data as Record<string, unknown>;
        await context.actions.usageTool(data.input, {
          operationKey: String(data.key),
          metadata: data.metadata as Readonly<Record<string, unknown>>,
        }).catch(() => undefined);
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
    [
      "llm.call.completed",
      "llm.call.failed",
      "llm.call.cancelled",
      "llm.call.progress",
    ],
  );

  const disabled = createUsageWorkflowPlugin({ enabled: false });
  assertEquals(Object.keys(disabled.collections), ["usage"]);
  assertEquals(Object.keys(disabled.processors), []);
});

Deno.test("package-root composes an explicitly supplied usage plugin", async () => {
  const application = await createCopilotzApplication({
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
    const toolMetadata = {
      schema: "copilotz.core.tool-action.v1",
      planId: "plan-1",
      planMessageId: "plan-message-1",
      planIndex: 0,
      planSize: 1,
      toolCallId: "lookup-call-1",
      action: "lookup",
      threadId: THREAD_ID,
      triggerMessageId: "message-1",
      agentParticipantId: "agent-node",
      initiatorParticipantId: "user-node",
      agentId: "north",
      availableToolIds: ["lookup"],
      parentLlmActionRunId: "llm-run-1",
    };
    await invoke("test.usage.llm", {
      key: "provider-0",
      input: {
        models: ["primary-model"],
        mode: "generate",
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
        models: ["failing-model"],
        mode: "generate",
        request: { messages: [] },
      },
      metadata: { source: "standalone-test" },
    });
    await invoke("test.usage.tool", {
      key: "tool-1",
      metadata: toolMetadata,
      input: {
        arguments: { secretPrompt: "do not duplicate" },
        result: {
          status: "completed",
          output: { privateResult: "do not duplicate" },
          durationMs: 25,
        },
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
      hookObserved: 1,
    });
    assertEquals(toolRow.operation, "lookup");
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

Deno.test("usage recognizes failed and cancelled Tool Actions structurally", async () => {
  const fixture = await createFixture();
  try {
    for (const mode of ["failed", "cancelled"] as const) {
      const key = `tool:${mode}`;
      const appended = await fixture.engine.events.append({
        type: "test.usage.tool",
        namespace: NAMESPACE,
        threadId: THREAD_ID,
        payload: {
          key,
          input: { mode, secret: `${mode}-must-not-be-copied` },
          metadata: {
            schema: "copilotz.core.tool-action.v1",
            planId: "plan-terminal",
            planMessageId: "plan-message-terminal",
            planIndex: 0,
            planSize: 1,
            toolCallId: `lookup-${mode}`,
            action: "lookup",
            threadId: THREAD_ID,
            triggerMessageId: "message-terminal",
            agentId: "north",
            agentParticipantId: "agent-node",
            initiatorParticipantId: "user-node",
            availableToolIds: ["lookup"],
            parentLlmActionRunId: "llm-terminal",
          },
        },
        correlationId: key,
        deduplicationId: `${key}:requested`,
      });
      await Promise.all(appended.dispatch.handles.map((handle) => handle.done));
    }

    const usage = fixture.engine.collections.withScope({ namespace: NAMESPACE })
      .usage;
    const deadline = Date.now() + 10_000;
    while ((await usage.list()).length < 2) {
      if (Date.now() >= deadline) {
        throw new Error("Tool terminal Usage records did not settle.");
      }
      await fixture.engine.recover({ namespace: NAMESPACE });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rows = await usage.list();
    assertEquals(
      rows.map((row) => row.status).sort(),
      ["cancelled", "failed"],
    );
    for (const row of rows) {
      assertEquals(row.resource, "lookup");
      assertEquals(row.operation, "lookup");
      assertEquals(row.metrics, { calls: 1 });
      assertEquals(row.threadId, THREAD_ID);
      assertEquals(row.messageId, "message-terminal");
      assertEquals(row.initiatedById, "user-external");
    }
    assert(!JSON.stringify(rows).includes("must-not-be-copied"));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("usage projects one ledger row per reported llm provider attempt", async () => {
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
            models: [model],
            mode: "generate",
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
    await invoke("reported-failure");

    const usage = fixture.engine.collections.withScope({ namespace: NAMESPACE })
      .usage;
    const deadline = Date.now() + 10_000;
    while ((await usage.list()).length < 7) {
      if (Date.now() >= deadline) {
        throw new Error("Aggregate Usage Actions did not settle.");
      }
      await fixture.engine.recover({ namespace: NAMESPACE });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const rows = await usage.list();
    assertEquals(rows.length, 7);

    const attempts = rows.filter((row) =>
      typeof row.dedupeKey === "string" && row.dedupeKey.includes(":attempt:")
    );
    assertEquals(attempts.length, 7);
    assertEquals(
      attempts.filter((row) => row.totalTokens !== null).map((row) => ({
        model: row.model,
        status: row.status,
        totalTokens: row.totalTokens,
        cost: row.totalCostUsd,
        currency: row.pricingCurrency,
      })).sort((left, right) =>
        Number(left.totalTokens) - Number(right.totalTokens)
      ),
      [
        {
          model: "reported-failure",
          status: "failed",
          totalTokens: 9,
          cost: null,
          currency: null,
        },
        {
          model: "uncosted-model",
          status: "failed",
          totalTokens: 40,
          cost: 1,
          currency: "USD",
        },
        {
          model: "uncosted-model",
          status: "completed",
          totalTokens: 70,
          cost: 2,
          currency: "EUR",
        },
        {
          model: "aggregate-model",
          status: "failed",
          totalTokens: 100,
          cost: 9,
          currency: "EUR",
        },
        {
          model: "aggregate-model",
          status: "completed",
          totalTokens: 280,
          cost: 12,
          currency: "GBP",
        },
      ],
    );

    const reportedFailure = rows.find((row) =>
      row.model === "reported-failure" &&
      typeof row.dedupeKey === "string" && row.dedupeKey.endsWith(":attempt:0")
    );
    assert(reportedFailure);
    assertEquals(reportedFailure.status, "failed");
    assertEquals(reportedFailure.statusReason, "malformed_tool_call");
    assertEquals(reportedFailure.metrics, {
      calls: 1,
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
    });
    assertEquals(
      rows.filter((row) => row.resource === "reported-failure").length,
      1,
    );

    for (
      const [model, status] of [
        ["failing-model", "failed"],
        ["cancelled-model", "cancelled"],
      ] as const
    ) {
      const terminal = rows.find((row) => row.resource === model)!;
      assertEquals(terminal.model, model);
      assertEquals(terminal.status, status);
      assertEquals(terminal.adapter, "openai-primary");
      assertEquals(terminal.providerModel, "gpt-5-mini-test");
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
    assert(serialized.includes("EUR"));
    assert(serialized.includes("GBP"));

    await fixture.engine.recover({ namespace: NAMESPACE });
    assertEquals((await usage.list()).length, 7);
  } finally {
    await closeFixture(fixture);
  }
});
