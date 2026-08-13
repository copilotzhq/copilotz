import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";

import type { Agent, API, MCPServer } from "../resources/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import type { ContentInput } from "../content/index.ts";
import { toolExecutionContent } from "../domain/index.ts";
import type { ProviderAPI } from "../llm/types.ts";
import { createSkillsPlugin, defineInlineSkill } from "../skills/index.ts";
import type {
  ChatRequest,
  ChatResponse,
  LLMAttemptLifecycleEvent,
  TokenUsage,
  ToolInvocation,
} from "../llm/types.ts";
import { createSqlSession, type EphemeralEvent } from "../events/index.ts";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  type PluginRegistry,
} from "../plugins/index.ts";
import {
  createTextWorkflowPlugin,
  type CreateTextWorkflowPluginOptions,
  createWorkflowToolCatalog,
  defineLlmProviderResource,
  type LlmChat,
  type WorkflowTool,
  type WorkflowToolExecutionContext,
  type WorkflowToolResult,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_text_workflow";

const usage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  source: "provider",
  status: "completed",
};

function argumentsRecord(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const north: Agent = {
  id: "north",
  name: "north",
  role: "assistant",
  instructions: "You are north.",
  capabilities: {
    tools: ["contract_tool"],
    skills: ["contract-skill"],
  },
  llmOptions: {
    provider: "openai",
    model: "primary-model",
    fallbacks: [{ provider: "openai", model: "fallback-model" }],
  },
};

const south: Agent = {
  ...north,
  id: "south",
  name: "south",
  role: "reviewer",
  instructions: "You are south.",
};

const contractSkill = defineInlineSkill({
  directoryName: "contract-skill",
  markdown: `---
name: contract-skill
description: A prompt-visible contract skill.
---
Use the contract skill carefully.`,
});

function toolCall(id: string, value: string): ToolInvocation {
  return {
    id,
    tool: { id: "contract_tool", name: "Contract Tool" },
    args: JSON.stringify({ value }),
    status: "pending",
  };
}

function namedToolCall(
  id: string,
  name: string,
  args: unknown,
): ToolInvocation {
  return {
    id,
    tool: { id: name, name },
    args: typeof args === "string" ? args : JSON.stringify(args),
    status: "pending",
  };
}

async function lifecycleStarted(
  request: ChatRequest,
  attemptIndex: number,
  model: string,
): Promise<void> {
  await request.onAttemptLifecycle?.({
    phase: "started",
    attemptId: `runtime-${model}-${attemptIndex}`,
    attemptIndex,
    provider: "openai",
    model,
    config: { provider: "openai", model },
    messages: request.messages,
    startedAt: "2026-08-10T00:00:00.000Z",
  });
}

async function lifecycleSettled(
  request: ChatRequest,
  input: Readonly<{
    attemptIndex: number;
    model: string;
    status: "completed" | "failed" | "superseded";
    recoveryAction: "accept" | "fallback" | "retry_same" | "fail";
  }>,
): Promise<void> {
  const event: LLMAttemptLifecycleEvent = {
    phase: "settled",
    attemptId: `runtime-${input.model}-${input.attemptIndex}`,
    attemptIndex: input.attemptIndex,
    provider: "openai",
    model: input.model,
    status: input.status,
    ...(input.status === "failed"
      ? { statusReason: "server_error" as const }
      : {}),
    recoveryAction: input.recoveryAction,
    record: {
      attemptId: `runtime-${input.model}-${input.attemptIndex}`,
      attemptIndex: input.attemptIndex,
      provider: "openai",
      model: input.model,
      usage,
      status: input.status,
      recoveryAction: input.recoveryAction,
      ...(input.status === "failed"
        ? {
          error: {
            reason: "server_error" as const,
            status: 503,
            message: "temporary provider failure",
          },
        }
        : {}),
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:00:01.000Z",
    },
    finishedAt: "2026-08-10T00:00:01.000Z",
  };
  await request.onAttemptLifecycle?.(event);
}

function response(
  request: ChatRequest,
  input: Readonly<{
    answer: string;
    model: string;
    finishReason?: "stop" | "tool_calls";
    toolCalls?: readonly ToolInvocation[];
  }>,
): ChatResponse {
  return {
    prompt: request.messages,
    answer: input.answer,
    tokens: usage.totalTokens ?? 0,
    usage,
    provider: "openai",
    model: input.model,
    finishReason: input.finishReason ?? "stop",
    ...(input.toolCalls ? { toolCalls: [...input.toolCalls] } : {}),
  };
}

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  registry: PluginRegistry;
  agent: Agent;
  toolCalls: () => number;
  toolContexts: readonly WorkflowToolExecutionContext[];
}>;

async function createFixture(
  chat: LlmChat,
  toolExecute?: WorkflowTool["execute"],
  workflowOptions: Omit<CreateTextWorkflowPluginOptions, "chat"> = {},
  agent: Agent = north,
  additionalAgents: readonly Agent[] = [],
  generatedResources: Readonly<{
    tools?: readonly WorkflowTool[];
    apis?: readonly API[];
    mcpServers?: readonly MCPServer[];
  }> = {},
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  let calls = 0;
  const contexts: WorkflowToolExecutionContext[] = [];
  const tool: WorkflowTool = {
    id: "contract-tool",
    key: "contract_tool",
    name: "Contract Tool",
    description: "Returns a deterministic marker.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    execute: async (args, context) => {
      const input = argumentsRecord(args);
      calls += 1;
      contexts.push(context as WorkflowToolExecutionContext);
      if (toolExecute) return await toolExecute(args, context);
      return {
        marker: `tool-result:${String(input.value)}`,
        agentId: context?.senderId,
        toolCallId: context?.toolCallId,
        idempotencyKey: context?.idempotencyKey,
      };
    },
  };
  const provider = defineLlmProviderResource({
    id: "openai",
    type: "llm",
    factory: () => ({}) as ProviderAPI,
  });
  const app = definePlugin({
    manifest: {
      id: "test.text-workflow.resources",
      version: "1.0.0",
      provides: {
        agents: [agent, ...additionalAgents].map((candidate) => candidate.id),
        tools: [tool, ...(generatedResources.tools ?? [])].map((candidate) =>
          candidate.key
        ),
        providers: [provider.id],
        ...(generatedResources.apis?.length
          ? { apis: generatedResources.apis.map((api) => api.id) }
          : {}),
        ...(generatedResources.mcpServers?.length
          ? {
            mcpServers: generatedResources.mcpServers.map((server) =>
              server.id
            ),
          }
          : {}),
      },
    },
    resources: {
      agents: [agent, ...additionalAgents],
      tools: [tool, ...(generatedResources.tools ?? [])],
      providers: [provider],
      ...(generatedResources.apis?.length
        ? { apis: [...generatedResources.apis] }
        : {}),
      ...(generatedResources.mcpServers?.length
        ? { mcpServers: [...generatedResources.mcpServers] }
        : {}),
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      createTextWorkflowPlugin({ ...workflowOptions, chat }),
      createSkillsPlugin({
        id: "test.text-workflow.skills",
        version: "1.0.0",
        skills: [contractSkill],
      }),
      app,
    ],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: TEST_SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
  });
  return Object.freeze({
    db,
    engine,
    registry,
    agent,
    toolCalls: () => calls,
    toolContexts: contexts,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

async function startContentRun(
  fixture: Fixture,
  content: ContentInput | readonly ContentInput[],
) {
  const agentParticipantId = `agent-${fixture.agent.id}`;
  await fixture.engine.conversation.createThread({
    namespace: "tenant-a",
    id: "thread-a",
    participants: [
      {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
        metadata: { locale: "pt-BR", _private: "hidden" },
      },
      {
        id: agentParticipantId,
        externalId: fixture.agent.id,
        participantType: "agent",
        agentId: fixture.agent.id,
        metadata: { workingMemory: "remember the contract" },
      },
    ],
    metadata: { public: { contractCase: "text-workflow" } },
    identity: { deduplicationId: "thread-a:create" },
  });
  const prepared = await fixture.engine.content.preparer.prepare(content, {
    namespace: "tenant-a",
    idempotencyKey: "user-message:body",
  });
  return await fixture.engine.conversation.createMessage({
    namespace: "tenant-a",
    id: "message:user",
    threadId: "thread-a",
    sender: {
      id: "user-a",
      externalId: "user-a",
      participantType: "human",
    },
    recipientIds: [agentParticipantId],
    content: prepared,
    identity: {
      correlationId: "run-a",
      deduplicationId: "message:user:create",
    },
  });
}

async function startRun(fixture: Fixture, text: string) {
  return await startContentRun(fixture, text);
}

async function waitForRun(
  fixture: Fixture,
  rootEventId: string,
  expectedMessages: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settlement = await fixture.engine.events.settlement(
      "tenant-a",
      rootEventId,
    );
    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    if (
      settlement.unsettled === 0 && settlement.deadLetters === 0 &&
      messages.length === expectedMessages
    ) return;
    if (settlement.deadLetters > 0) {
      const deliveries = await fixture.engine.deliveries.list({
        namespace: "tenant-a",
        status: "dead_letter",
      });
      throw new Error(`Run dead-lettered: ${JSON.stringify(deliveries)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const deliveries = await fixture.engine.deliveries.list({
    namespace: "tenant-a",
    limit: 100,
  });
  const messages = await fixture.engine.conversation.listMessages(
    "tenant-a",
    "thread-a",
  );
  const attempts = await fixture.engine.llmAttempts.list(
    "tenant-a",
    "thread-a",
  );
  throw new Error(
    `Timed out waiting for the causal workflow to settle: ${
      JSON.stringify({
        expectedMessages,
        actualMessages: messages.length,
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
          safeError: attempt.safeError,
        })),
        deliveries,
      })
    }`,
  );
}

async function waitForSettlement(
  fixture: Fixture,
  rootEventId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settlement = await fixture.engine.events.settlement(
      "tenant-a",
      rootEventId,
    );
    if (settlement.unsettled === 0 && settlement.deadLetters === 0) return;
    if (settlement.deadLetters > 0) {
      throw new Error(`Event '${rootEventId}' dead-lettered.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for '${rootEventId}' to settle.`);
}

async function messageText(
  fixture: Fixture,
  message: Awaited<ReturnType<CopilotzEngine["conversation"]["getMessage"]>>,
): Promise<string> {
  assertExists(message);
  const resolved = await fixture.engine.content.resolver.getMany(
    message.content,
    { namespace: "tenant-a" },
  );
  return resolved.map((part) =>
    part.text ?? (part.value === undefined ? "" : JSON.stringify(part.value))
  ).join("\n");
}

Deno.test("text workflow emits ordered non-durable text, reasoning, and tool-call frames", async () => {
  const fixture = await createFixture(
    async (request, _config, _env, stream) => {
      await lifecycleStarted(request, 0, "primary-model");
      stream?.("Visible token");
      stream?.("Private thought", { isReasoning: true });
      request.onToolCallDelta?.({
        providerAttemptId: "provider-attempt-a",
        draftId: "draft-a",
        callIndex: 0,
        sequence: 0,
        toolName: "contract_tool",
        phase: "delta",
        delta: '{"value":',
      });
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "Visible token",
        model: "primary-model",
      });
    },
  );
  const reader = fixture.engine.events.subscribe({
    namespace: "tenant-a",
    types: ["text.delta", "reasoning.delta", "tool_call.delta"],
  }).getReader();
  try {
    const root = await startRun(fixture, "Stream this response.");
    await waitForRun(fixture, root.event.id, 2);
    const frames: EphemeralEvent[] = [];
    for (let index = 0; index < 3; index += 1) {
      const next = await reader.read();
      assertEquals(next.done, false);
      assertExists(next.value);
      assert(!next.value.durable);
      frames.push(next.value);
    }
    assertEquals(frames.map((frame) => frame.type), [
      "text.delta",
      "reasoning.delta",
      "tool_call.delta",
    ]);
    assertEquals(frames.map((frame) => frame.durable), [false, false, false]);
    assertEquals(frames.map((frame) => frame.sequence), [0, 1, 2]);
    assertEquals(
      (frames[0].payload as { text: string }).text,
      "Visible token",
    );
    assertEquals(
      (frames[1].payload as { text: string }).text,
      "Private thought",
    );
    assertEquals(
      (frames[2].payload as { delta: string }).delta,
      '{"value":',
    );
    const durable = await fixture.engine.events.list({
      namespace: "tenant-a",
      threadId: "thread-a",
      limit: 1_000,
    });
    assertEquals(
      durable.some((event) =>
        ["text.delta", "reasoning.delta", "tool_call.delta"].includes(
          event.type,
        )
      ),
      false,
    );
  } finally {
    await reader.cancel();
    await closeFixture(fixture);
  }
});

Deno.test("event-native text workflow preserves user -> tool -> same-agent continuation with provider fallback", async () => {
  const transcripts: string[] = [];
  let logicalCalls = 0;
  const chat: LlmChat = async (request) => {
    logicalCalls += 1;
    assertEquals(request.strictAttemptLifecycle, true);
    assert(
      typeof request.idempotencyKey === "string" &&
        request.idempotencyKey.length > 0,
    );
    assertStringIncludes(JSON.stringify(request.messages), "You are north.");
    transcripts.push(JSON.stringify(request.messages));
    if (logicalCalls === 1) {
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "",
        model: "primary-model",
        finishReason: "tool_calls",
        toolCalls: [toolCall("call-1", "persist-once")],
      });
    }
    assertStringIncludes(transcripts.at(-1) ?? "", "tool-result:persist-once");
    await lifecycleStarted(request, 0, "primary-model");
    await lifecycleSettled(request, {
      attemptIndex: 0,
      model: "primary-model",
      status: "failed",
      recoveryAction: "fallback",
    });
    await lifecycleStarted(request, 1, "fallback-model");
    await lifecycleSettled(request, {
      attemptIndex: 1,
      model: "fallback-model",
      status: "completed",
      recoveryAction: "accept",
    });
    return response(request, {
      answer: "north retry-safe public final",
      model: "fallback-model",
    });
  };
  const fixture = await createFixture(chat);
  try {
    const root = await startRun(fixture, "Execute a retry-safe tool turn.");
    await waitForRun(fixture, root.event.id, 4);

    assertEquals(logicalCalls, 2);
    assertEquals(fixture.toolCalls(), 1);
    assertEquals(fixture.toolContexts.length, 1);
    assertEquals(fixture.toolContexts[0].senderId, "north");
    assertEquals(fixture.toolContexts[0].toolCallId, "call-1");
    assert(
      typeof fixture.toolContexts[0].idempotencyKey === "string" &&
        fixture.toolContexts[0].idempotencyKey.length > 0,
    );

    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(messages.map((message) => message.sender.participantType), [
      "human",
      "agent",
      "tool",
      "agent",
    ]);
    assertEquals(
      await messageText(fixture, messages[0]),
      "Execute a retry-safe tool turn.",
    );
    assertEquals(await messageText(fixture, messages[1]), "");
    assertEquals(
      (messages[1].metadata.copilotzWorkflow as Record<string, unknown>).kind,
      "agent_output",
    );
    assertEquals(
      (messages[1].metadata.copilotzWorkflow as Record<string, unknown>)
        .agentParticipantId,
      "agent-north",
    );
    assertStringIncludes(
      await messageText(fixture, messages[2]),
      "tool-result:persist-once",
    );
    assertEquals(
      await messageText(fixture, messages[3]),
      "north retry-safe public final",
    );

    const attempts = await fixture.engine.llmAttempts.list(
      "tenant-a",
      "thread-a",
    );
    const providerAttempts = attempts.filter((attempt) =>
      attempt.id.includes(":provider:")
    );
    assertEquals(
      attempts.filter((attempt) => !attempt.id.includes(":provider:")).length,
      2,
    );
    assertEquals(providerAttempts.length, 3);
    assertEquals(
      providerAttempts.map((attempt) => attempt.status),
      ["completed", "failed", "completed"],
    );
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.length, 1);
    assertEquals(executions[0].status, "completed");

    await fixture.engine.recover({ namespace: "tenant-a" });
    assertEquals(
      (await fixture.engine.conversation.listMessages(
        "tenant-a",
        "thread-a",
      )).map((message) => message.id),
      messages.map((message) => message.id),
    );
    assertEquals(fixture.toolCalls(), 1);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("text workflow bounds synthesized identities across a long tool chain", async () => {
  let logicalCalls = 0;
  const longToolCallId = `preview-${"nested-call-".repeat(24)}`;
  const fixture = await createFixture(async (request) => {
    logicalCalls += 1;
    await lifecycleStarted(request, 0, "primary-model");
    await lifecycleSettled(request, {
      attemptIndex: 0,
      model: "primary-model",
      status: "completed",
      recoveryAction: "accept",
    });
    return response(
      request,
      logicalCalls === 1
        ? {
          answer: "",
          model: "primary-model",
          finishReason: "tool_calls",
          toolCalls: [toolCall(longToolCallId, "bounded")],
        }
        : { answer: "complete", model: "primary-model" },
    );
  });
  try {
    const root = await startRun(fixture, "Run a deeply identified tool.");
    await waitForRun(fixture, root.event.id, 4);

    const attempts = await fixture.engine.llmAttempts.list(
      "tenant-a",
      "thread-a",
    );
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    for (
      const id of [
        ...attempts.map((attempt) => attempt.id),
        ...executions.map((execution) => execution.id),
        ...messages.map((message) => message.id),
      ]
    ) {
      assert(id.length <= 256, id);
    }
    assert(
      executions.some((execution) => execution.id.startsWith("tool:sha256:")),
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("tool attachments persist and remain addressable in the next model turn", async () => {
  let logicalCalls = 0;
  const assetAgent: Agent = {
    ...north,
    assetOptions: { resolveInLLM: false },
  };
  const fixture = await createFixture(
    async (request, config) => {
      logicalCalls += 1;
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      if (logicalCalls === 1) {
        return response(request, {
          answer: "",
          model: "primary-model",
          finishReason: "tool_calls",
          toolCalls: [toolCall("export-call", "export")],
        });
      }

      assert(request.materializeMessages);
      const materialized = await request.materializeMessages(
        request.messages,
        config,
      );
      const serialized = JSON.stringify(materialized);
      assertStringIncludes(serialized, "report.csv");
      assertStringIncludes(serialized, "assetId");
      assertStringIncludes(serialized, "asset://tenant-a/");
      assertEquals(serialized.includes("bmFtZSx2YWx1ZQ"), false);
      return response(request, {
        answer: "The exported report is attached.",
        model: "primary-model",
      });
    },
    () => {
      const result: WorkflowToolResult = {
        kind: "copilotz.workflow-tool.result.v1",
        output: {
          path: "outputs/report.csv",
          mimeType: "text/csv",
          size: 19,
        },
        attachments: [{
          type: "file",
          bytes: new TextEncoder().encode("name,value\nalpha,1\n"),
          mediaType: "text/csv",
          name: "report.csv",
          role: "attachment",
          disposition: "attachment",
        }],
      };
      return result;
    },
    {},
    assetAgent,
  );
  try {
    const root = await startRun(fixture, "Export the report.");
    await waitForRun(fixture, root.event.id, 4);
    assertEquals(logicalCalls, 2);

    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.length, 1);
    const executionContent = toolExecutionContent(executions[0]);
    assertEquals(executionContent.attachments.length, 1);
    assertEquals(executionContent.attachments[0].name, "report.csv");
    assertEquals(executionContent.attachments[0].mediaType, "text/csv");

    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(
      messages[2].content.some((ref) =>
        ref.assetId === executionContent.attachments[0].assetId &&
        ref.role === "attachment"
      ),
      true,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("revising a human turn runs the agent from the projected branch", async () => {
  let logicalCalls = 0;
  const fixture = await createFixture(async (request) => {
    logicalCalls += 1;
    const transcript = JSON.stringify(request.messages);
    await lifecycleStarted(request, 0, "primary-model");
    await lifecycleSettled(request, {
      attemptIndex: 0,
      model: "primary-model",
      status: "completed",
      recoveryAction: "accept",
    });
    if (logicalCalls === 1) {
      assertStringIncludes(transcript, "Original question");
      return response(request, {
        answer: "Answer to the superseded branch",
        model: "primary-model",
      });
    }
    assertStringIncludes(transcript, "Revised question");
    assert(!transcript.includes("Original question"));
    assert(!transcript.includes("Answer to the superseded branch"));
    return response(request, {
      answer: "Answer to the active branch",
      model: "primary-model",
    });
  });
  try {
    const original = await startRun(fixture, "Original question");
    await waitForRun(fixture, original.event.id, 2);
    const beforeRevision = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(beforeRevision.length, 2);

    const content = await fixture.engine.content.preparer.prepare(
      "Revised question",
      {
        namespace: "tenant-a",
        idempotencyKey: "message:user:revision:1:content",
      },
    );
    const revision = await fixture.engine.conversation.reviseMessage({
      namespace: "tenant-a",
      id: "message:user:revision:1",
      threadId: "thread-a",
      messageId: "message:user",
      content,
      identity: {
        correlationId: "run-a:revision:1",
        deduplicationId: "message:user:revision:1",
      },
    });
    await waitForRun(fixture, revision.event.id, 2);

    assertEquals(logicalCalls, 2);
    const active = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(active[0].id, "message:user:revision:1");
    assertEquals(await messageText(fixture, active[0]), "Revised question");
    assertEquals(
      await messageText(fixture, active[1]),
      "Answer to the active branch",
    );
    const all = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
      { view: "all" },
    );
    assertEquals(all.map((message) => message.id), [
      "message:user",
      beforeRevision[1].id,
      "message:user:revision:1",
      active[1].id,
    ]);
    assertEquals(
      await messageText(fixture, all[1]),
      "Answer to the superseded branch",
    );
    assertEquals(
      (await fixture.engine.llmAttempts.list("tenant-a", "thread-a"))
        .filter((attempt) => !attempt.id.includes(":provider:")).length,
      2,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("parallel tool completions produce one continuation after every labelled result", async () => {
  let logicalCalls = 0;
  let activeTools = 0;
  let maximumActiveTools = 0;
  let continuationTranscript = "";
  const chat: LlmChat = async (request) => {
    logicalCalls += 1;
    await lifecycleStarted(request, 0, "primary-model");
    await lifecycleSettled(request, {
      attemptIndex: 0,
      model: "primary-model",
      status: "completed",
      recoveryAction: "accept",
    });
    if (logicalCalls === 1) {
      return response(request, {
        answer: "north is checking twice",
        model: "primary-model",
        finishReason: "tool_calls",
        toolCalls: [
          toolCall("call-a", "alpha"),
          toolCall("call-b", "beta"),
        ],
      });
    }
    continuationTranscript = JSON.stringify(request.messages);
    return response(request, {
      answer: "north combined both results",
      model: "primary-model",
    });
  };
  const fixture = await createFixture(chat, async (args, context) => {
    const input = argumentsRecord(args);
    activeTools += 1;
    maximumActiveTools = Math.max(maximumActiveTools, activeTools);
    await new Promise((resolve) => setTimeout(resolve, 30));
    activeTools -= 1;
    return {
      marker: `parallel:${String(input.value)}`,
      owner: context?.senderId,
    };
  });
  try {
    const root = await startRun(fixture, "Run both tools.");
    await waitForRun(fixture, root.event.id, 5);
    assertEquals(logicalCalls, 2);
    assertEquals(fixture.toolCalls(), 2);
    assertEquals(maximumActiveTools, 2);
    assertStringIncludes(continuationTranscript, "parallel:alpha");
    assertStringIncludes(continuationTranscript, "parallel:beta");
    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(messages.map((message) => message.sender.participantType), [
      "human",
      "agent",
      "tool",
      "tool",
      "agent",
    ]);
    assertEquals(
      new Set(messages.map((message) => message.id)).size,
      messages.length,
    );
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("invalid and unknown tool calls settle as labelled failures and resume the producing agent", async (t) => {
  for (
    const scenario of [
      {
        name: "invalid schema arguments",
        call: namedToolCall("invalid-call", "contract_tool", {}),
        expected: "VALIDATION ERROR",
      },
      {
        name: "unknown tool",
        call: namedToolCall("unknown-call", "missing_tool", { value: "x" }),
        expected: "TOOL NOT FOUND",
      },
    ]
  ) {
    await t.step(scenario.name, async () => {
      let logicalCalls = 0;
      const chat: LlmChat = async (request) => {
        logicalCalls += 1;
        await lifecycleStarted(request, 0, "primary-model");
        await lifecycleSettled(request, {
          attemptIndex: 0,
          model: "primary-model",
          status: "completed",
          recoveryAction: "accept",
        });
        if (logicalCalls === 1) {
          return response(request, {
            answer: "north is trying a tool",
            model: "primary-model",
            finishReason: "tool_calls",
            toolCalls: [scenario.call],
          });
        }
        assertStringIncludes(
          JSON.stringify(request.messages),
          scenario.expected,
        );
        return response(request, {
          answer: "north recovered from the tool failure",
          model: "primary-model",
        });
      };
      const fixture = await createFixture(chat);
      try {
        const root = await startRun(fixture, `Exercise ${scenario.name}.`);
        await waitForRun(fixture, root.event.id, 4);
        assertEquals(logicalCalls, 2);
        assertEquals(fixture.toolCalls(), 0);
        const executions = await fixture.engine.toolExecutions.list(
          "tenant-a",
          "thread-a",
        );
        assertEquals(executions.length, 1);
        assertEquals(executions[0].status, "failed");
        assertEquals(
          await messageText(
            fixture,
            (await fixture.engine.conversation.listMessages(
              "tenant-a",
              "thread-a",
            )).at(-1) ?? null,
          ),
          "north recovered from the tool failure",
        );
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

Deno.test("tool timeout cancels the durable execution and resumes the agent", async () => {
  let logicalCalls = 0;
  let observedCancellation = false;
  const chat: LlmChat = async (request) => {
    logicalCalls += 1;
    await lifecycleStarted(request, 0, "primary-model");
    await lifecycleSettled(request, {
      attemptIndex: 0,
      model: "primary-model",
      status: "completed",
      recoveryAction: "accept",
    });
    if (logicalCalls === 1) {
      return response(request, {
        answer: "north is starting a slow tool",
        model: "primary-model",
        finishReason: "tool_calls",
        toolCalls: [toolCall("slow-call", "slow")],
      });
    }
    assertStringIncludes(JSON.stringify(request.messages), "timed out");
    return response(request, {
      answer: "north recovered after cancellation",
      model: "primary-model",
    });
  };
  const fixture = await createFixture(
    chat,
    (_args, context) => {
      context?.onCancel?.(() => {
        observedCancellation = true;
      });
      return new Promise(() => {});
    },
    { toolExecutionTimeoutMs: 15 },
  );
  try {
    const root = await startRun(fixture, "Exercise tool cancellation.");
    await waitForRun(fixture, root.event.id, 4);
    assertEquals(logicalCalls, 2);
    assertEquals(observedCancellation, true);
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.length, 1);
    assertEquals(executions[0].status, "cancelled");
    assertStringIncludes(executions[0].safeError?.message ?? "", "timed out");
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("prompt construction preserves resolvers, transforms, skills, memory, and public metadata", async () => {
  let instructionCalls = 0;
  let transformCalls = 0;
  let configCalls = 0;
  const fixture = await createFixture(
    async (request) => {
      const serialized = JSON.stringify(request.messages);
      assertStringIncludes(serialized, "Resolved per-input instructions");
      assertStringIncludes(serialized, "contract-skill");
      assertStringIncludes(serialized, "remember the contract");
      assertStringIncludes(serialized, "contractCase");
      assertStringIncludes(serialized, "premium");
      assertStringIncludes(serialized, "LOCAL AGENTS INSTRUCTIONS");
      assertStringIncludes(serialized, "history transform marker");
      assertEquals(request.tools?.map((tool) => tool.function.name), [
        "contract_tool",
        "list_skills",
        "load_skill",
      ]);
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "prompt policy preserved",
        model: "primary-model",
      });
    },
    undefined,
    {
      userMetadata: { accountTier: "premium" },
      agentsFileInstructions: {
        fileName: "AGENTS.md",
        content: "Local contract instructions.",
      },
      resolveAgentInstructions(input) {
        instructionCalls += 1;
        assertEquals(input.baseInstructions, "You are north.");
        assertEquals(input.userMetadata?.accountTier, "premium");
        return "Resolved per-input instructions";
      },
      historyTransform(input) {
        transformCalls += 1;
        assertEquals(input.rawMessages.length, 1);
        return [
          ...input.messages,
          { role: "user", content: "history transform marker" },
        ];
      },
      resolveAgentTextConfig(input) {
        configCalls += 1;
        assertStringIncludes(
          JSON.stringify(input.messages),
          "history transform marker",
        );
        assertEquals(input.thread.id, "thread-a");
        assertEquals(input.tools.length, 3);
        return input.baseConfig;
      },
    },
  );
  try {
    const root = await startRun(fixture, "Exercise prompt composition.");
    await waitForRun(fixture, root.event.id, 2);
    assertEquals(instructionCalls, 1);
    assertEquals(transformCalls, 1);
    assertEquals(configCalls, 1);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("agent tool policy is resolved once and persisted on the text attempt", async () => {
  let resolverCalls = 0;
  const fixture = await createFixture(
    async (request) => {
      assertEquals(request.tools?.map((tool) => tool.function.name), [
        "contract_tool",
      ]);
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "tenant tool policy preserved",
        model: "primary-model",
      });
    },
    undefined,
    {
      resolveAgentTools(input) {
        resolverCalls += 1;
        assertEquals(input.agent.id, "north");
        assertEquals(input.context.namespace, "tenant-a");
        return input.tools.filter((tool) => tool.key === "contract_tool");
      },
    },
  );
  try {
    const root = await startRun(fixture, "Apply the tenant tool policy.");
    await waitForRun(fixture, root.event.id, 2);
    const attempts = await fixture.engine.llmAttempts.list(
      "tenant-a",
      "thread-a",
    );
    const logical = attempts.find((attempt) =>
      !attempt.id.includes(":provider:")
    );
    assertEquals(logical?.availableToolIds, ["contract_tool"]);
    assertEquals(resolverCalls, 1);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("prompt omits skills when the agent cannot load their instructions", async () => {
  const withoutSkillLoader: Agent = {
    ...north,
    capabilities: { tools: ["contract_tool"] },
  };
  const fixture = await createFixture(
    async (request) => {
      const serialized = JSON.stringify(request.messages);
      assert(!serialized.includes("AVAILABLE SKILLS"));
      assert(!serialized.includes("contract-skill"));
      assertEquals(request.tools?.map((tool) => tool.function.name), [
        "contract_tool",
      ]);
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "skill loader correctly omitted",
        model: "primary-model",
      });
    },
    undefined,
    {},
    withoutSkillLoader,
  );
  try {
    const root = await startRun(fixture, "Exercise skill tool policy.");
    await waitForRun(fixture, root.event.id, 2);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("participant-relative history labels peer agents and enforces tool and reasoning visibility", async () => {
  let logicalCalls = 0;
  const fixture = await createFixture(
    async (request) => {
      logicalCalls += 1;
      const serialized = JSON.stringify(request.messages);
      assertStringIncludes(serialized, "south public answer");
      assertStringIncludes(serialized, "[contract_tool completed]");
      assertStringIncludes(serialized, "public-output");
      assert(!serialized.includes("south private reasoning"));
      assert(!serialized.includes("status-secret"));
      assert(!serialized.includes("requester-secret"));
      const peer = request.messages.find((message) =>
        message.senderId === "agent-south"
      );
      assertEquals(peer?.role, "user");
      assertEquals(peer?.metadata?.speakerLabel, "south");
      assertEquals(peer?.reasoning, undefined);
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "north respected peer visibility",
        model: "primary-model",
      });
    },
    undefined,
    {},
    north,
    [south],
  );
  const providerMetadata = {
    copilotzWorkflow: {
      kind: "provider_attempt",
      parentLlmAttemptId: "seed-parent",
      agentParticipantId: "agent-south",
    },
  };
  try {
    await fixture.engine.conversation.createThread({
      namespace: "tenant-a",
      id: "thread-a",
      participants: [
        {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        {
          id: "agent-north",
          externalId: "north",
          participantType: "agent",
          agentId: "north",
        },
        {
          id: "agent-south",
          externalId: "south",
          participantType: "agent",
          agentId: "south",
          name: "south",
        },
      ],
      identity: { deduplicationId: "peer-thread:create" },
    });
    const peerAnswer = await fixture.engine.content.preparer.prepare(
      "south public answer",
      { namespace: "tenant-a", idempotencyKey: "peer:answer" },
    );
    const peerReasoning = await fixture.engine.content.preparer.prepare({
      type: "text",
      text: "south private reasoning",
      role: "reasoning",
    }, { namespace: "tenant-a", idempotencyKey: "peer:reasoning" });
    await fixture.engine.llmAttempts.create({
      namespace: "tenant-a",
      id: "seed-peer-attempt",
      threadId: "thread-a",
      participantId: "agent-south",
      agentId: "south",
      status: "running",
      inputMessageIds: [],
      metadata: providerMetadata,
      identity: {
        deduplicationId: "seed-peer-attempt:create",
        metadata: providerMetadata,
      },
    });
    const peerCompleted = await fixture.engine.llmAttempts.complete({
      namespace: "tenant-a",
      id: "seed-peer-attempt",
      answer: peerAnswer,
      reasoning: peerReasoning,
      identity: {
        deduplicationId: "seed-peer-attempt:complete",
        metadata: providerMetadata,
      },
    });
    await waitForSettlement(fixture, peerCompleted.event.id);
    await fixture.engine.conversation.createMessage({
      namespace: "tenant-a",
      id: "message:peer",
      threadId: "thread-a",
      sender: {
        id: "agent-south",
        externalId: "south",
        participantType: "agent",
        agentId: "south",
        name: "south",
      },
      recipientIds: [],
      content: peerAnswer.content,
      metadata: {
        copilotzWorkflow: {
          kind: "agent_output",
          llmAttemptId: "seed-peer-attempt",
          agentParticipantId: "agent-south",
        },
      },
      identity: { deduplicationId: "message:peer:create" },
    });

    const seedTool = async (
      id: string,
      visibility: "public_status" | "requester_only" | "public",
      output: string,
    ) => {
      const metadata = {
        copilotzWorkflow: {
          kind: "tool_execution",
          llmAttemptId: "seed-peer-attempt",
          parentLlmAttemptId: "seed-peer-attempt",
          toolCallId: id,
          batchId: `incomplete:${id}`,
          batchSize: 2,
          batchIndex: 0,
          agentParticipantId: "agent-south",
        },
      };
      const args = await fixture.engine.content.preparer.prepare({
        type: "json",
        value: { id },
        role: "tool.arguments",
      }, { namespace: "tenant-a", idempotencyKey: `${id}:args` });
      const created = await fixture.engine.toolExecutions.create({
        namespace: "tenant-a",
        id: `execution:${id}`,
        threadId: "thread-a",
        participantId: "agent-south",
        agentId: "south",
        toolCallId: id,
        tool: { id: "contract_tool", name: "Contract Tool" },
        arguments: args,
        status: "pending",
        historyVisibility: visibility,
        metadata,
        identity: {
          deduplicationId: `execution:${id}:create`,
          metadata,
        },
      });
      await waitForSettlement(fixture, created.event.id);
      const projected = await fixture.engine.content.preparer.prepare({
        type: "json",
        value: { output },
        role: "tool.projected_output",
      }, { namespace: "tenant-a", idempotencyKey: `${id}:output` });
      const completed = await fixture.engine.toolExecutions.complete({
        namespace: "tenant-a",
        id: `execution:${id}`,
        output: projected,
        projectedOutput: projected,
        historyVisibility: visibility,
        identity: {
          deduplicationId: `execution:${id}:complete`,
          metadata,
        },
      });
      await waitForSettlement(fixture, completed.event.id);
    };
    await seedTool("status-call", "public_status", "status-secret");
    await seedTool("private-call", "requester_only", "requester-secret");
    await seedTool("public-call", "public", "public-output");

    const userBody = await fixture.engine.content.preparer.prepare(
      "North, summarize only what you may see.",
      { namespace: "tenant-a", idempotencyKey: "peer:user-body" },
    );
    const root = await fixture.engine.conversation.createMessage({
      namespace: "tenant-a",
      id: "message:user",
      threadId: "thread-a",
      sender: {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      recipientIds: ["agent-north"],
      content: userBody,
      identity: {
        correlationId: "peer-run",
        deduplicationId: "peer:user-message",
      },
    });
    await waitForRun(fixture, root.event.id, 6);
    assertEquals(logicalCalls, 1);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("canonical multimodal history remains ordered and can be reduced to text per agent", async () => {
  const textOnlyAgent: Agent = {
    ...north,
    id: "text-only",
    name: "text-only",
    assetOptions: { resolveInLLM: false },
  };
  const fixture = await createFixture(
    async (request, config) => {
      const user = request.messages.find((message) => message.role === "user");
      assert(user && Array.isArray(user.content));
      assertEquals(user.content.map((part) => part.type), [
        "text",
        "text",
        "image_url",
        "text",
        "input_audio",
        "text",
        "file",
      ]);
      const attachmentDescriptors = user.content.filter((part) =>
        part.type === "text" && part.text.startsWith("[Copilotz attachment:")
      );
      assertEquals(attachmentDescriptors.length, 3);
      const descriptorText = attachmentDescriptors.flatMap((part) =>
        part.type === "text" ? [part.text] : []
      ).join("\n");
      assertStringIncludes(
        descriptorText,
        '"assetRef":"asset://tenant-a/',
      );
      assertStringIncludes(
        descriptorText,
        '"name":"data.csv"',
      );
      assert(request.materializeMessages);
      const materialized = await request.materializeMessages(
        request.messages,
        config,
      );
      const materializedUser = materialized.find((message) =>
        message.role === "user"
      );
      assert(typeof materializedUser?.content === "string");
      assertStringIncludes(
        materializedUser.content,
        "Describe the attachments.",
      );
      assertStringIncludes(materializedUser.content, "assetId");
      assertStringIncludes(materializedUser.content, "asset://tenant-a/");
      assertStringIncludes(materializedUser.content, "data.csv");
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      return response(request, {
        answer: "multimodal policy preserved",
        model: "primary-model",
      });
    },
    undefined,
    {},
    textOnlyAgent,
  );
  try {
    const root = await startContentRun(fixture, [
      { type: "text", text: "Describe the attachments." },
      {
        type: "image",
        bytes: new Uint8Array([137, 80, 78, 71]),
        mediaType: "image/png",
        role: "attachment",
      },
      {
        type: "audio",
        bytes: new Uint8Array([82, 73, 70, 70]),
        mediaType: "audio/wav",
        role: "attachment",
      },
      {
        type: "file",
        bytes: new TextEncoder().encode("name,value\nalpha,1\n"),
        mediaType: "text/csv",
        role: "attachment",
        name: "data.csv",
      },
    ]);
    await waitForRun(fixture, root.event.id, 2);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("OpenAPI and MCP descriptors resolve worker-locally for both prompt and execution", async () => {
  const api: API = {
    id: "contract-api",
    name: "Contract API",
    openApiSchema: { openapi: "3.0.0", paths: {} },
  };
  const mcpServer: MCPServer = {
    id: "contract-mcp",
    name: "Contract MCP",
    transport: { type: "contract" },
  };
  let apiGenerations = 0;
  let mcpGenerations = 0;
  let generatedExecutions = 0;
  let generatedContext: WorkflowToolExecutionContext | undefined;
  const toolCatalog = createWorkflowToolCatalog({
    generateApiTools(resources) {
      apiGenerations += 1;
      assertEquals(resources, [api]);
      return [{
        id: "generated:api_lookup",
        key: "api_lookup",
        name: "API lookup",
        description: "Lookup through the contract API.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        historyPolicy: { visibility: "public" },
        execute(args, context) {
          const input = argumentsRecord(args);
          generatedExecutions += 1;
          generatedContext = context as WorkflowToolExecutionContext;
          return { generated: `api:${String(input.query)}` };
        },
      }];
    },
    generateMcpTools(resources) {
      mcpGenerations += 1;
      assertEquals(resources, [mcpServer]);
      return [{
        id: "generated:contract_mcp_ping",
        key: "contract_mcp_ping",
        name: "Contract MCP ping",
        description: "Ping the contract MCP server.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ pong: true }),
      }];
    },
  });
  const generatedAgent: Agent = {
    ...north,
    id: "generated-agent",
    name: "generated-agent",
    capabilities: { tools: ["api_lookup", "contract_mcp_ping"] },
  };
  let logicalCalls = 0;
  const fixture = await createFixture(
    async (request) => {
      logicalCalls += 1;
      assertEquals(request.tools?.map((tool) => tool.function.name), [
        "api_lookup",
        "contract_mcp_ping",
      ]);
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      if (logicalCalls === 1) {
        return response(request, {
          answer: "checking generated API",
          model: "primary-model",
          finishReason: "tool_calls",
          toolCalls: [
            namedToolCall("generated-call", "api_lookup", {
              query: "contract",
            }),
          ],
        });
      }
      assertStringIncludes(JSON.stringify(request.messages), "api:contract");
      return response(request, {
        answer: "generated tool completed",
        model: "primary-model",
      });
    },
    undefined,
    { toolCatalog },
    generatedAgent,
    [],
    { apis: [api], mcpServers: [mcpServer] },
  );
  try {
    const root = await startRun(fixture, "Use the generated API tool.");
    await waitForRun(fixture, root.event.id, 4);
    assertEquals(logicalCalls, 2);
    assertEquals(generatedExecutions, 1);
    assertEquals(apiGenerations, 1);
    assertEquals(mcpGenerations, 1);
    assertEquals(generatedContext?.namespace, "tenant-a");
    assertEquals(generatedContext?.senderId, generatedAgent.id);
    assert(typeof generatedContext?.idempotencyKey === "string");
    assert(typeof generatedContext?.resolveAsset === "function");
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.map((execution) => execution.tool.id), [
      "api_lookup",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("tool pipelines keep jq internal, persist actual stages, and resume once against the root call", async () => {
  const observedArguments: Record<string, unknown>[] = [];
  const extract: WorkflowTool = {
    id: "extract",
    key: "extract",
    name: "Extract",
    description: "Extract records.",
    inputSchema: {
      type: "object",
      properties: { region: { type: "string" } },
      required: ["region"],
    },
    execute(args) {
      const input = argumentsRecord(args);
      observedArguments.push(structuredClone(input));
      return {
        region: input.region,
        items: [{ id: 1, status: "paid" }, { id: 2, status: "open" }],
      };
    },
  };
  const analyze: WorkflowTool = {
    id: "analyze",
    key: "analyze",
    name: "Analyze",
    description: "Analyze records.",
    inputSchema: {
      type: "object",
      properties: {
        records: { type: "array" },
        mode: { type: "string" },
      },
      required: ["records", "mode"],
    },
    execute(args) {
      const input = argumentsRecord(args);
      observedArguments.push(structuredClone(input));
      return {
        result: `${String(input.mode)}:${
          Array.isArray(input.records) ? input.records.length : 0
        }`,
      };
    },
  };
  const pipelineAgent: Agent = {
    ...north,
    id: "pipeline-agent",
    name: "pipeline-agent",
    capabilities: { tools: ["extract", "analyze"] },
  };
  let logicalCalls = 0;
  let jqCalls = 0;
  const fixture = await createFixture(
    async (request) => {
      logicalCalls += 1;
      await lifecycleStarted(request, 0, "primary-model");
      await lifecycleSettled(request, {
        attemptIndex: 0,
        model: "primary-model",
        status: "completed",
        recoveryAction: "accept",
      });
      if (logicalCalls === 1) {
        return response(request, {
          answer: "running one pipeline",
          model: "primary-model",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "pipeline-root-call",
            tool: { id: "extract", name: "Extract" },
            args: JSON.stringify({ region: "south" }),
            status: "pending",
            pipeline: {
              id: "pipeline-contract",
              stages: [
                {
                  type: "tool",
                  id: "pipeline-root-call",
                  tool: { id: "extract", name: "Extract" },
                  args: JSON.stringify({ region: "south" }),
                },
                {
                  type: "jq",
                  filter: '{records:[.items[] | select(.status == "paid")]}',
                },
                {
                  type: "tool",
                  id: "pipeline-analyze-call",
                  tool: { id: "analyze", name: "Analyze" },
                  args: JSON.stringify({ mode: "priority" }),
                },
              ],
            },
          }],
        });
      }
      const toolMessage = request.messages.find((message) =>
        message.role === "tool"
      );
      assertEquals(toolMessage?.tool_call_id, "pipeline-root-call");
      assertEquals(toolMessage?.toolCalls?.[0].id, "pipeline-root-call");
      assertEquals(toolMessage?.toolCalls?.[0].tool.id, "extract");
      assertStringIncludes(JSON.stringify(toolMessage), "priority:1");
      return response(request, {
        answer: "pipeline completed once",
        model: "primary-model",
      });
    },
    undefined,
    {
      evaluateJq(input, filter) {
        jqCalls += 1;
        assertStringIncludes(filter, "select");
        const source = input as {
          items: Array<Record<string, unknown>>;
        };
        return {
          records: source.items.filter((item) => item.status === "paid"),
        };
      },
    },
    pipelineAgent,
    [],
    { tools: [extract, analyze] },
  );
  try {
    const root = await startRun(fixture, "Run the extraction pipeline.");
    await waitForRun(fixture, root.event.id, 4);
    assertEquals(logicalCalls, 2);
    assertEquals(jqCalls, 1);
    assertEquals(observedArguments, [
      { region: "south" },
      { records: [{ id: 1, status: "paid" }], mode: "priority" },
    ]);
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.length, 2);
    assertEquals(executions.map((execution) => execution.status), [
      "completed",
      "completed",
    ]);
    assertEquals(
      executions.map((execution) =>
        (execution.metadata.copilotzWorkflow as {
          pipeline?: { stageIndex: number };
        }).pipeline?.stageIndex
      ),
      [0, 2],
    );
    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(messages.map((message) => message.sender.participantType), [
      "human",
      "agent",
      "tool",
      "agent",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("A55 workflow modules remain factory-first and runtime-neutral", async () => {
  for (
    const module of [
      "index.ts",
      "identity.ts",
      "pipeline.ts",
      "prompt.ts",
      "resources.ts",
      "text-plugin.ts",
      "tool-catalog.ts",
      "tool-executor.ts",
      "transcript.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(
      !/unsafeGraph|producedEvents|queueId|runGeneration/.test(source),
      module,
    );
  }
});
