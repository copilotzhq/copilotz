import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import type { AgentResource } from "@copilotz/copilotz/core";
import { corePlugin, coreProcessors } from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterFrame,
  LlmAdapterResult,
  LlmMode,
} from "@copilotz/copilotz/llm";
import { defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/tools";
import {
  type CopilotzPlugin,
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../../runtime/plugins/index.ts";
import type { CoreToolProcessorContext } from "./context.ts";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import { createSqlSession } from "../../runtime/events/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import {
  projectActionEvents,
  projectMessages,
} from "../../runtime/testing/projections.ts";
import type { ConversationMessage } from "../../runtime/domain/index.ts";

const TEST_SCHEMA = "copilotz_core_llm_call";
const NAMESPACE = "tenant-a";

type AdapterResponse = Readonly<{
  result: LlmAdapterResult;
  frames?: readonly LlmAdapterFrame[];
}>;

type AdapterHandler = (
  input: LlmAdapterCallInput,
) => AdapterResponse | Promise<AdapterResponse>;

function adapterFrom(handler: AdapterHandler): LlmAdapter {
  return Object.freeze({
    call(input) {
      const response = Promise.resolve().then(() => handler(input));
      const frames = new ReadableStream<LlmAdapterFrame>({
        async start(controller) {
          try {
            for (const frame of (await response).frames ?? []) {
              controller.enqueue(frame);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return Object.freeze({
        frames,
        result: response.then((value) => value.result),
      });
    },
  });
}

const toolExecutions: string[] = [];

const contractToolAction = defineAction({
  id: "test.contract-tool",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const,
  execute(input: Readonly<{ value: string }>) {
    toolExecutions.push(input.value);
    if (input.value === "empty-array") return [];
    return { marker: `tool-result:${input.value}` };
  },
});

const contractTool = defineTool("contract_tool", contractToolAction, {
  name: "Contract Tool",
  description: "Returns the supplied value with a stable marker.",
});

function agent(mode: LlmMode = "generate"): AgentResource {
  return Object.freeze({
    id: "north",
    name: "North",
    role: "assistant",
    instructions: "CORE_AGENT_INSTRUCTIONS",
    models: mode === "session"
      ? { session: "primaryModel" }
      : { generate: "primaryModel" },
    capabilities: { tools: ["contract_tool"] },
  });
}

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  inputs: readonly LlmAdapterCallInput[];
  close(): Promise<void>;
}>;

async function createFixture(
  handler: AdapterHandler,
  mode: LlmMode = "generate",
  semanticPlugin: CopilotzPlugin = corePlugin,
): Promise<Fixture> {
  toolExecutions.splice(0);
  const db = await createTestDatabase({ url: ":memory:" });
  const inputs: LlmAdapterCallInput[] = [];
  const llm = adapterFrom(async (input) => {
    inputs.push(input);
    return await handler(input);
  });
  const app = definePlugin({
    id: `test.core-llm.${mode}`,
    version: "1.0.0",
    actions: { contract_tool: contractToolAction },
    resources: {
      agents: { north: agent(mode) },
      tools: { contract_tool: contractTool },
      models: {
        primaryModel: {
          adapter: "test",
          model: `${mode}-provider-model`,
          mode,
        },
      },
    },
    adapters: { llm: { test: llm } },
  });
  const registry = await createPluginRegistry({
    plugins: [semanticPlugin, app],
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
    inputs,
    async close() {
      await engine.shutdown();
      await db.close();
    },
  });
}

function collection(engine: CopilotzEngine, name: string) {
  const value = engine.collections.get(name);
  if (!value) throw new Error(`Collection '${name}' is not bound.`);
  return value;
}

async function startRun(fixture: Fixture, text = "Hello"): Promise<string> {
  await collection(fixture.engine, "participant").create({
    id: "user-a",
    externalId: "user-a",
    participantType: "human",
    metadata: { locale: "pt-BR" },
  }, { namespace: NAMESPACE });
  await collection(fixture.engine, "participant").create({
    id: "agent-north",
    externalId: "north",
    participantType: "agent",
    agentId: "north",
    name: "North",
    metadata: {},
  }, { namespace: NAMESPACE });
  await collection(fixture.engine, "thread").create({
    id: "thread-a",
    participantIds: ["user-a", "agent-north"],
    metadata: {},
  }, {
    namespace: NAMESPACE,
    identity: { deduplicationId: "thread-a:create" },
  });
  const content = await fixture.engine.content.preparer.prepare(text, {
    namespace: NAMESPACE,
    idempotencyKey: "message:user:content",
  });
  const created = await collection(fixture.engine, "message").create({
    id: "message:user",
    threadId: "thread-a",
    senderId: "user-a",
    recipientIds: ["agent-north"],
    content,
    metadata: {},
  }, {
    namespace: NAMESPACE,
    threadId: "thread-a",
    routing: { senderId: "user-a", recipientIds: ["agent-north"] },
    identity: {
      correlationId: "core-run",
      deduplicationId: "message:user:create",
    },
  });
  return created.event.id;
}

async function waitForRun(
  fixture: Fixture,
  rootEventId: string,
  expectedMessages: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settlement = await fixture.engine.events.settlement(
      NAMESPACE,
      rootEventId,
    );
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    if (
      settlement.unsettled === 0 && settlement.deadLetters === 0 &&
      messages.length === expectedMessages
    ) return;
    if (settlement.deadLetters > 0) {
      const deliveries = await fixture.engine.deliveries.list({
        namespace: NAMESPACE,
        status: "dead_letter",
      });
      throw new Error(
        `Core LLM run dead-lettered: ${JSON.stringify(deliveries)}`,
      );
    }
    await fixture.engine.recover({ namespace: NAMESPACE });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Core LLM run did not produce ${expectedMessages} Messages.`);
}

async function messageText(
  fixture: Fixture,
  message: ConversationMessage,
): Promise<string> {
  const resolved = await fixture.engine.content.resolver.getMany(
    message.content,
    { namespace: NAMESPACE },
  );
  return resolved.map((value) =>
    value.text ?? (value.value === undefined ? "" : JSON.stringify(value.value))
  ).join("\n");
}

function inputText(input: LlmAdapterCallInput): string {
  return input.request.messages.flatMap((message) =>
    message.content.map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "json"
        ? JSON.stringify(part.value)
        : `[${part.type}]`
    )
  ).join("\n");
}

Deno.test("Core invokes llm.call with explicit application Models and Adapters", async () => {
  const fixture = await createFixture((_input) => ({
    result: {
      content: { type: "text", text: "Hello from North", role: "body" },
      reasoning: {
        type: "text",
        text: "private reasoning",
        role: "reasoning",
      },
      attempts: [{
        status: "completed",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      }],
      finishReason: "stop",
    },
    frames: [{
      lane: "content",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("Hello from North"),
    }],
  }));
  try {
    const root = await startRun(fixture, "Answer this message");
    await waitForRun(fixture, root, 2);
    assertEquals(fixture.inputs.length, 1);
    const input = fixture.inputs[0];
    assertEquals(input.model, "primaryModel");
    assertEquals(input.adapter, "test");
    assertEquals(input.providerModel, "generate-provider-model");
    assertEquals(input.mode, "generate");
    assertStringIncludes(
      input.request.instructions ?? "",
      "CORE_AGENT_INSTRUCTIONS",
    );
    assertStringIncludes(inputText(input), "Answer this message");
    assertEquals(input.request.tools?.map((tool) => tool.name), [
      "contract_tool",
    ]);

    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(await messageText(fixture, messages[1]), "Hello from North");
    assertEquals(messages[1].sender.id, "agent-north");

    const lifecycle = await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "llm.call",
    );
    const completed = lifecycle.find((event) => event.status === "completed");
    assertExists(completed);
    assertEquals(completed.metadata, {
      schema: "copilotz.core.llm-call.v1",
      threadId: "thread-a",
      triggerMessageId: "message:user",
      agentId: "north",
      agentParticipantId: "agent-north",
      initiatorParticipantId: "user-a",
      availableToolIds: ["contract_tool"],
    });
    assertEquals(
      "threadId" in (completed.input as Record<string, unknown>),
      false,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("Core invokes and projects an Action-backed Tool plan", async () => {
  let call = 0;
  const fixture = await createFixture((input) => {
    call += 1;
    if (call === 1) {
      return {
        result: {
          content: [],
          toolCalls: [{
            id: "call-1",
            action: "contract_tool",
            input: { value: "first" },
          }, {
            id: "call-2",
            action: "contract_tool",
            input: { value: "second" },
          }, {
            id: "call-3",
            action: "contract_tool",
            input: { value: "empty-array" },
          }],
          attempts: [{ status: "completed" }],
          finishReason: "tool_calls",
        },
      };
    }
    assert(input.request.messages.some((message) => message.role === "tool"));
    assertStringIncludes(inputText(input), "tool-result:first");
    assertStringIncludes(inputText(input), "tool-result:second");
    assertStringIncludes(inputText(input), "[]");
    return {
      result: {
        content: { type: "text", text: "Tool observed", role: "body" },
        attempts: [{ status: "completed" }],
        finishReason: "stop",
      },
    };
  });
  try {
    const root = await startRun(fixture, "Use the contract tool");
    await waitForRun(fixture, root, 6);
    assertEquals(call, 2);
    assertEquals(toolExecutions, ["first", "second", "empty-array"]);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(messages.map((message) => message.sender.participantType), [
      "human",
      "agent",
      "tool",
      "tool",
      "tool",
      "agent",
    ]);
    assertEquals(await messageText(fixture, messages[5]), "Tool observed");
    assertEquals(messages[1].metadata.llmToolCalls, [{
      id: "call-1",
      action: "contract_tool",
      input: { value: "first" },
    }, {
      id: "call-2",
      action: "contract_tool",
      input: { value: "second" },
    }, {
      id: "call-3",
      action: "contract_tool",
      input: { value: "empty-array" },
    }]);
    assertEquals(
      "calls" in (messages[1].metadata.copilotzToolPlan as Record<
        string,
        unknown
      >),
      false,
    );
    const toolCalls = await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "test.contract-tool",
    );
    assertEquals(
      toolCalls.filter((event) => event.status === "completed").length,
      3,
    );
    for (const event of toolCalls) {
      assertEquals(Object.keys(event.metadata).sort(), [
        "action",
        "agentId",
        "agentParticipantId",
        "availableToolIds",
        "initiatorParticipantId",
        "parentLlmActionRunId",
        "planId",
        "planIndex",
        "planMessageId",
        "planSize",
        "schema",
        "threadId",
        "toolCallId",
        "triggerMessageId",
      ]);
      assertEquals(
        event.metadata.schema,
        "copilotz.core.tool-action.v1",
      );
    }
    const firstToolMetadata = messages[2].metadata;
    const firstWorkflow = firstToolMetadata.copilotzWorkflow as Record<
      string,
      unknown
    >;
    assertEquals(firstWorkflow.continuation, "none");
    assertEquals("batchId" in firstWorkflow, false);
    assertEquals("toolExecutionId" in firstWorkflow, false);
    assertEquals(
      typeof (firstToolMetadata.copilotzToolAction as Record<string, unknown>)
        .actionRunId,
      "string",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("Tool terminal delivery retry recovers effects and one continuation", async () => {
  let injectedFailures = 0;
  const flakyProjectToolResult = defineProcessor<CoreToolProcessorContext>({
    id: coreProcessors.projectToolResult.id,
    on: coreProcessors.projectToolResult.on,
    async handle(event, context) {
      await coreProcessors.projectToolResult.handle(event, context);
      if (injectedFailures === 0) {
        injectedFailures += 1;
        throw new Error("injected failure after Tool result projection");
      }
    },
  });
  const retryingCore = definePlugin({
    id: "test.core-tool-retry",
    version: "1.0.0",
    plugins: corePlugin.plugins,
    collections: corePlugin.collections,
    actions: corePlugin.actions,
    processors: {
      ...corePlugin.processors,
      projectToolResult: flakyProjectToolResult,
    },
    resources: corePlugin.resources,
    adapters: corePlugin.adapters,
  });
  let llmCalls = 0;
  const fixture = await createFixture(
    (_input) => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          result: {
            content: [],
            toolCalls: [{
              id: "retry-call-1",
              action: "contract_tool",
              input: { value: "first" },
            }, {
              id: "retry-call-2",
              action: "contract_tool",
              input: { value: "second" },
            }],
            attempts: [{ status: "completed" }],
          },
        };
      }
      return {
        result: {
          content: { type: "text", text: "Retried once", role: "body" },
          attempts: [{ status: "completed" }],
        },
      };
    },
    "generate",
    retryingCore,
  );
  try {
    const root = await startRun(fixture, "Exercise retry recovery");
    await waitForRun(fixture, root, 5);
    assertEquals(injectedFailures, 1);
    assertEquals(toolExecutions, ["first", "second"]);
    assertEquals(llmCalls, 2);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    const toolMessages = messages.filter((message) =>
      message.sender.participantType === "tool"
    );
    assertEquals(toolMessages.length, 2);
    assertEquals(new Set(toolMessages.map((message) => message.id)).size, 2);
    const lifecycle = await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "test.contract-tool",
    );
    assertEquals(
      lifecycle.filter((event) => event.status === "invoked").length,
      2,
    );
    assertEquals(
      lifecycle.filter((event) => event.status === "completed").length,
      2,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("Core selects an Agent session Model alias without a wrapper Action", async () => {
  const fixture = await createFixture((input) => ({
    result: {
      content: { type: "text", text: `mode:${input.mode}`, role: "body" },
      attempts: [{ status: "completed" }],
    },
  }), "session");
  try {
    const root = await startRun(fixture, "Use the session model");
    await waitForRun(fixture, root, 2);
    assertEquals(fixture.inputs.length, 1);
    assertEquals(fixture.inputs[0].mode, "session");
    assertEquals(fixture.inputs[0].providerModel, "session-provider-model");
    const lifecycle = await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "llm.call",
    );
    assertEquals(lifecycle.at(-1)?.status, "completed");
  } finally {
    await fixture.close();
  }
});
