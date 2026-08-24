import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  agentAskMetadata,
  type AgentResource,
  askAction,
  askTool,
  corePlugin,
} from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterFrame,
  LlmAdapterResult,
  LlmJsonObject,
} from "@copilotz/copilotz/llm";
import { defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "@copilotz/copilotz/tools";
import {
  createPluginRegistry,
  definePlugin,
} from "../../runtime/plugins/index.ts";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import { createCopilotzApplication } from "../../runtime/application/application.ts";
import { createSqlSession } from "../../runtime/events/index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { projectActionEvents, projectMessages } from "./testing/projections.ts";
import {
  isStreamOutputDescriptor,
  type RuntimeOutputDescriptor,
  type StreamOutputDescriptor,
} from "../../runtime/streams/index.ts";
import type { ConversationMessage } from "@copilotz/copilotz/core";
import type { CoreToolProcessorContext } from "./context.ts";
import { resumeDeferredToolPlan } from "./internal/tool-plan.ts";
import {
  type AgentAskMetadata,
  withAgentAskMetadata,
} from "./internal/workflow-metadata.ts";

const TEST_SCHEMA = "copilotz_core_ask";
const NAMESPACE = "tenant-a";

function agent(id: string, agents: readonly string[] = []): AgentResource {
  return Object.freeze({
    id,
    name: id.toUpperCase(),
    role: "assistant",
    instructions: `ACTIVE_AGENT=${id}`,
    models: { generate: ["askModel"] as const },
    capabilities: {
      agents,
      ...(id === "a" ? { tools: ["mark", "publish"] } : {}),
    },
  });
}

const markExecutions: string[] = [];
const markAction = defineAction({
  id: "test.ask.mark",
  execute(input: Readonly<{ value: string }>) {
    markExecutions.push(input.value);
    return {
      marked: input.value === "PRIVATE_TOOL_ARGUMENT"
        ? "PRIVATE_TOOL_OUTPUT"
        : input.value,
    };
  },
});
const markTool = defineTool("mark", markAction, {
  name: "Mark",
  description: "Marks the ordered ask continuation.",
});

const publishAction = defineAction({
  id: "test.ask.publish",
  execute(input: Readonly<{ value: string }>) {
    return { published: input.value };
  },
});
const publishTool = defineTool("publish", publishAction, {
  name: "Publish",
  description: "Publishes one Tool result to the whole thread.",
  history: { visibility: "public" },
});

type HandlerResult =
  & LlmAdapterResult
  & Readonly<{
    frames?: readonly LlmAdapterFrame[];
  }>;

type Handler = (
  input: LlmAdapterCallInput,
) => HandlerResult | Promise<HandlerResult>;

function adapterFrom(handler: Handler): LlmAdapter {
  return Object.freeze({
    call(input) {
      const response = Promise.resolve().then(() => handler(input));
      const result = response.then(({ frames: _frames, ...value }) =>
        value as LlmAdapterResult
      );
      return Object.freeze({
        frames: new ReadableStream({
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
        }),
        result,
      });
    },
  });
}

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  agents: readonly AgentResource[];
  outputs: readonly RuntimeOutputDescriptor[];
  close(): Promise<void>;
}>;

async function createFixture(
  agents: readonly AgentResource[],
  handler: Handler,
): Promise<Fixture> {
  markExecutions.splice(0);
  const outputs: RuntimeOutputDescriptor[] = [];
  const db = await createTestDatabase({ url: ":memory:" });
  const app = definePlugin({
    id: "test.core-ask.resources",
    version: "1.0.0",
    actions: { mark: markAction, publish: publishAction },
    resources: {
      agents: Object.fromEntries(
        agents.map((resource) => [resource.id, resource]),
      ),
      tools: { mark: markTool, publish: publishTool },
      models: {
        askModel: { adapter: "test", model: "ask-provider-model" },
      },
    },
    adapters: { llm: { test: adapterFrom(handler) } },
  });
  const registry = await createPluginRegistry({ plugins: [corePlugin, app] });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: TEST_SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
    execution: { capacity: 1 },
    publish(output) {
      outputs.push(output);
    },
  });
  return Object.freeze({
    db,
    engine,
    agents,
    outputs,
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

async function startRun(fixture: Fixture): Promise<string> {
  await collection(fixture.engine, "participant").create({
    id: "user-a",
    externalId: "user-a",
    participantType: "human",
    metadata: {},
  }, { namespace: NAMESPACE });
  for (const resource of fixture.agents) {
    await collection(fixture.engine, "participant").create({
      id: `agent-${resource.id}`,
      externalId: resource.id,
      participantType: "agent",
      agentId: resource.id,
      name: resource.name,
      metadata: {},
    }, { namespace: NAMESPACE });
  }
  await collection(fixture.engine, "thread").create({
    id: "thread-a",
    participantIds: [
      "user-a",
      ...fixture.agents.map((resource) => `agent-${resource.id}`),
    ],
    metadata: {},
  }, {
    namespace: NAMESPACE,
    identity: { deduplicationId: "thread-a:create" },
  });
  const content = await fixture.engine.content.preparer.prepare(
    "Start the ask workflow",
    {
      namespace: NAMESPACE,
      idempotencyKey: "ask-root:content",
    },
  );
  const created = await collection(fixture.engine, "message").create({
    id: "message:user",
    threadId: "thread-a",
    senderId: "user-a",
    recipientIds: ["agent-a"],
    content,
    metadata: {},
  }, {
    namespace: NAMESPACE,
    threadId: "thread-a",
    routing: { senderId: "user-a", recipientIds: ["agent-a"] },
    identity: {
      correlationId: "ask-run",
      deduplicationId: "ask-root:message",
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
        `Ask workflow dead-lettered: ${JSON.stringify(deliveries)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Ask workflow did not produce ${expectedMessages} Messages.`);
}

function activeAgent(input: LlmAdapterCallInput): string {
  const instructions = input.request.instructions ?? "";
  const match = /ACTIVE_AGENT=([a-z0-9_-]+)/.exec(instructions);
  if (!match) throw new Error(`No active Agent in prompt: ${instructions}`);
  return match[1];
}

function requestText(input: LlmAdapterCallInput): string {
  return input.request.messages.flatMap((message) =>
    message.content.map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "json"
        ? JSON.stringify(part.value)
        : ""
    )
  ).join("\n");
}

async function messageText(
  fixture: Fixture,
  message: ConversationMessage,
): Promise<string> {
  const values = await fixture.engine.content.resolver.getMany(
    message.content,
    { namespace: NAMESPACE },
  );
  return values.map((value) =>
    value.text ?? (value.value === undefined ? "" : JSON.stringify(value.value))
  ).join("\n");
}

async function streamText(fixture: Fixture, streamId: string): Promise<string> {
  const stream = await fixture.engine.streams.follow(NAMESPACE, {
    id: streamId,
  });
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

Deno.test("ask is one native Action with a data-only Tool presentation", () => {
  assertEquals(askAction.id, "copilotz.core.ask");
  assertEquals(askTool.action, "ask");
  assertEquals("execute" in askTool, false);
});

Deno.test("missing or forged parent ask cursors reject every retry", async () => {
  const origin = (
    agentId: string,
    agentParticipantId: string,
    callId: string,
  ) => ({
    schema: "copilotz.core.tool-action.v1" as const,
    planId: `plan-${agentId}`,
    planMessageId: `message-plan-${agentId}`,
    planIndex: 0,
    stageIndex: 0,
    stageCount: 1,
    planSize: 1,
    toolCallId: callId,
    action: "ask",
    threadId: "thread-a",
    triggerMessageId: `message-trigger-${agentId}`,
    agentId,
    agentParticipantId,
    initiatorParticipantId: "user-a",
    availableToolIds: ["ask"],
    responseVisibility: { kind: "public" as const },
    parentLlmActionRunId: `llm-${agentId}`,
  });
  const parent: AgentAskMetadata = {
    schema: "copilotz.ask.v1",
    askId: "ask-parent",
    phase: "question",
    toolActionRunId: "action-parent",
    toolCallId: "call-parent",
    questionMessageId: "message-parent-question",
    askingParticipantId: "agent-a",
    askingAgentId: "a",
    askingAgentName: "A",
    askedParticipantId: "agent-forged",
    askedAgentId: "forged",
    askedAgentName: "FORGED",
    origin: origin("a", "agent-a", "call-parent"),
    depth: 1,
  };
  const child: AgentAskMetadata = {
    schema: "copilotz.ask.v1",
    askId: "ask-child",
    phase: "answer",
    toolActionRunId: "action-child",
    toolCallId: "call-child",
    questionMessageId: "message-child-question",
    askingParticipantId: "agent-b",
    askingAgentId: "b",
    askingAgentName: "B",
    askedParticipantId: "agent-c",
    askedAgentId: "c",
    askedAgentName: "C",
    parentAskId: parent.askId,
    parentQuestionMessageId: parent.questionMessageId,
    origin: origin("b", "agent-b", "call-child"),
    depth: 2,
  };
  const forgedParentQuestion = {
    id: parent.questionMessageId,
    threadId: "thread-a",
    senderId: parent.askingParticipantId,
    recipientIds: [parent.askedParticipantId],
    metadata: withAgentAskMetadata(undefined, parent),
  };

  for (
    const scenario of [
      { message: null, error: "was not found" },
      { message: forgedParentQuestion, error: "forged parent cursor" },
    ]
  ) {
    let reads = 0;
    let effects = 0;
    const context = {
      collections: {
        message: {
          get() {
            reads += 1;
            return Promise.resolve(scenario.message);
          },
        },
      },
      actions: new Proxy({}, {
        get() {
          effects += 1;
          return undefined;
        },
      }),
    } as unknown as CoreToolProcessorContext;
    for (let retry = 0; retry < 2; retry += 1) {
      await assertRejects(
        () =>
          resumeDeferredToolPlan(context, child, {
            status: "completed",
            output: { status: "answered" },
          }),
        Error,
        scenario.error,
      );
    }
    assertEquals(reads, 2);
    assertEquals(effects, 0);
  }
});

Deno.test("an ask resumes through durable llm.call metadata", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, (input) => {
    const id = activeAgent(input);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    assertEquals(
      input.request.tools?.map((tool) => tool.name) ?? [],
      id === "a" ? ["mark", "publish", "ask"] : [],
    );
    if (id === "a") {
      const definition = input.request.tools?.find((tool) =>
        tool.name === "ask"
      );
      const properties = definition?.inputSchema?.properties as
        | Record<string, unknown>
        | undefined;
      assertEquals(properties?.mode, {
        type: "string",
        enum: ["public", "private"],
        default: "public",
        description:
          "Controls Ask visibility. 'public' (default) adds the question, discussion, and answer to shared conversation history. 'private' limits that Ask history to the asking and asked agents.",
      });
      assertStringIncludes(definition?.description ?? "", "Defaults to public");
    }
    if (id === "a" && count === 1) {
      return {
        content: [],
        toolCalls: [{
          id: "ask-b",
          action: "ask",
          input: { target: "b", message: "A asks B publicly" } as LlmJsonObject,
        }, {
          id: "mark-after-ask",
          action: "mark",
          input: { value: "after-answer" } as LlmJsonObject,
        }],
        attempts: [{ status: "completed" }],
        finishReason: "tool_calls",
      };
    }
    if (id === "b") {
      assertStringIncludes(requestText(input), "A asks B publicly");
      return {
        content: { type: "text", text: "B public answer", role: "body" },
        attempts: [{ status: "completed" }],
      };
    }
    assertStringIncludes(requestText(input), "B public answer");
    assertStringIncludes(requestText(input), "after-answer");
    return {
      content: { type: "text", text: "A public final", role: "body" },
      attempts: [{ status: "completed" }],
    };
  });
  try {
    const root = await startRun(fixture);
    await waitForRun(fixture, root, 7);
    assertEquals(calls, ["a", "b", "a"]);
    assertEquals(markExecutions, ["after-answer"]);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(await messageText(fixture, messages[6]), "A public final");
    const question = messages.find((message) =>
      agentAskMetadata(message.metadata)?.phase === "question"
    );
    const answer = messages.find((message) =>
      agentAskMetadata(message.metadata)?.phase === "answer"
    );
    assertExists(question);
    assertExists(answer);
    const questionAsk = agentAskMetadata(question.metadata);
    const answerAsk = agentAskMetadata(answer.metadata);
    assertExists(questionAsk);
    assertExists(answerAsk);
    assertEquals(questionAsk.askId, answerAsk.askId);
    assertEquals(questionAsk.askingAgentName, "A");
    assertEquals(questionAsk.askedAgentName, "B");
    assertEquals(answerAsk.askingAgentName, "A");
    assertEquals(answerAsk.askedAgentName, "B");
    const lifecycle = await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "llm.call",
    );
    assertEquals(
      lifecycle.filter((event) => event.status === "completed").length,
      3,
    );
    assert(
      lifecycle.some((event) =>
        event.metadata.schema === "copilotz.core.llm-call.v1" &&
        typeof event.metadata.ask === "object"
      ),
    );
    const askedInvocation = lifecycle.find((event) =>
      event.status === "invoked" && event.metadata.agentId === "b"
    );
    assertExists(askedInvocation);
    const askedCompletion = lifecycle.find((event) =>
      event.status === "completed" && event.metadata.agentId === "b"
    );
    assertExists(askedCompletion);
    assertEquals(answerAsk.answerAttemptId, askedCompletion.actionRunId);
    const streamMetadata = (
      askedInvocation.input as {
        stream?: { metadata?: Record<string, unknown> };
      }
    ).stream?.metadata?.copilotzCore as Record<string, unknown> | undefined;
    assertEquals(streamMetadata, {
      schema: "copilotz.core.llm-stream.v1",
      agent: { id: "b", name: "B" },
      ask: {
        askId: questionAsk.askId,
        phase: "question",
        questionMessageId: questionAsk.questionMessageId,
        askingAgent: { id: "a", name: "A" },
        askedAgent: { id: "b", name: "B" },
      },
    });
  } finally {
    await fixture.close();
  }
});

Deno.test("asked-Agent streams retain target identity and separate reasoning", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const counts = new Map<string, number>();
  const encoder = new TextEncoder();
  const fixture = await createFixture(agents, (input) => {
    const id = activeAgent(input);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === "a" && count === 1) {
      return {
        content: [],
        toolCalls: [{
          id: "ask-b-streams",
          action: "ask",
          input: { target: "b", message: "Give a concise answer." },
        }],
        attempts: [{ status: "completed" }],
      };
    }
    if (id === "b") {
      return {
        content: { type: "text", text: "B final answer", role: "body" },
        frames: [{
          lane: "reasoning",
          mediaType: "text/plain; charset=utf-8",
          bytes: encoder.encode("B private reasoning"),
        }, {
          lane: "content",
          mediaType: "text/plain; charset=utf-8",
          bytes: encoder.encode("B streamed answer"),
        }],
        attempts: [{ status: "completed" }],
      };
    }
    return {
      content: { type: "text", text: "A final", role: "body" },
      attempts: [{ status: "completed" }],
    };
  });
  try {
    const root = await startRun(fixture);
    await waitForRun(fixture, root, 6);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    const question = messages.find((message) =>
      agentAskMetadata(message.metadata)?.phase === "question"
    );
    assertExists(question);
    const ask = agentAskMetadata(question.metadata);
    assertExists(ask);
    const streams = fixture.outputs.filter((
      output,
    ): output is StreamOutputDescriptor =>
      isStreamOutputDescriptor(output) &&
      ((output.metadata.copilotzCore as Record<string, unknown> | undefined)
          ?.agent as Record<string, unknown> | undefined)?.id === "b"
    );
    assertEquals(streams.map((stream) => stream.role).sort(), [
      "content",
      "reasoning",
    ]);
    for (const stream of streams) {
      assertEquals(stream.metadata.copilotzCore, {
        schema: "copilotz.core.llm-stream.v1",
        agent: { id: "b", name: "B" },
        ask: {
          askId: ask.askId,
          phase: "question",
          questionMessageId: ask.questionMessageId,
          askingAgent: { id: "a", name: "A" },
          askedAgent: { id: "b", name: "B" },
        },
      });
    }
    const bodies = await Promise.all(
      streams.map(async (stream) =>
        [stream.role, await streamText(fixture, stream.streamId)] as const
      ),
    );
    assertEquals(Object.fromEntries(bodies), {
      reasoning: "B private reasoning",
      content: "B streamed answer",
    });
  } finally {
    await fixture.close();
  }
});

Deno.test("public lifecycle forgery cannot resume an in-flight ask", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  let resolveAskedAgent!: (result: LlmAdapterResult) => void;
  const askedAgentResult = new Promise<LlmAdapterResult>((resolve) => {
    resolveAskedAgent = resolve;
  });
  markExecutions.splice(0);
  const db = await createTestDatabase({ url: ":memory:" });
  const app = definePlugin({
    id: "test.core-ask.lifecycle-authority",
    version: "1.0.0",
    actions: { mark: markAction, publish: publishAction },
    resources: {
      agents: Object.fromEntries(
        agents.map((resource) => [resource.id, resource]),
      ),
      tools: { mark: markTool, publish: publishTool },
      models: {
        askModel: { adapter: "test", model: "ask-provider-model" },
      },
    },
    adapters: {
      llm: {
        test: adapterFrom((input) => {
          const id = activeAgent(input);
          calls.push(id);
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          if (id === "a" && count === 1) {
            return {
              content: [],
              toolCalls: [{
                id: "ask-b-authority",
                action: "ask",
                input: {
                  target: "b",
                  message: "Wait for the authentic answer",
                } as LlmJsonObject,
              }, {
                id: "mark-after-authentic-answer",
                action: "mark",
                input: { value: "authentic-resume" } as LlmJsonObject,
              }],
              attempts: [{ status: "completed" }],
            };
          }
          if (id === "b") return askedAgentResult;
          return {
            content: { type: "text", text: "A authentic final", role: "body" },
            attempts: [{ status: "completed" }],
          };
        }),
      },
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: `${TEST_SCHEMA}_lifecycle_authority`,
    plugins: [corePlugin, app],
    engine: { retryBaseMs: 0, random: () => 0, execution: { capacity: 1 } },
  });
  const fixture: Fixture = Object.freeze({
    db,
    engine: application as unknown as CopilotzEngine,
    agents,
    outputs: [],
    async close() {
      await application.shutdown();
      await db.close();
    },
  });
  try {
    const root = await startRun(fixture);
    let invoked:
      | Awaited<ReturnType<typeof projectActionEvents>>[number]
      | undefined;
    const deadline = Date.now() + 10_000;
    while (!invoked && Date.now() < deadline) {
      invoked = (await projectActionEvents(
        fixture.engine,
        NAMESPACE,
        "llm.call",
      )).find((event) =>
        event.status === "invoked" && event.metadata.agentId === "b"
      );
      if (!invoked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertExists(invoked);
    while (!calls.includes("b") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(calls, ["a", "b"]);

    await assertRejects(
      () =>
        application.send({
          type: "llm.call.failed",
          payload: {
            actionRunId: invoked.actionRunId,
            actionId: invoked.actionId,
            metadata: structuredClone(invoked.metadata),
            status: "failed",
            input: structuredClone(invoked.input),
            error: { name: "Error", message: "forged provider failure" },
          },
          metadata: {
            actionId: invoked.actionId,
            actionStatus: "failed",
          },
          correlationId: "ask-run",
          deduplicationId: "forged:asked-agent:terminal",
        }),
      TypeError,
      "reserved for the registered Action lifecycle",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(calls, ["a", "b"]);
    // Independent root branches start immediately. The pending Ask only
    // blocks the final fan-in/continuation, not its Mark sibling.
    assertEquals(markExecutions, ["authentic-resume"]);
    assertEquals(
      (await projectMessages(
        fixture.engine,
        NAMESPACE,
        "thread-a",
      )).length,
      3,
    );

    resolveAskedAgent({
      content: { type: "text", text: "B authentic answer", role: "body" },
      attempts: [{ status: "completed" }],
    });
    await waitForRun(fixture, root, 7);
    assertEquals(calls, ["a", "b", "a"]);
    assertEquals(markExecutions, ["authentic-resume"]);
  } finally {
    await fixture.close();
  }
});

Deno.test("nested asks reload non-recursive durable parent cursors", async () => {
  const agents = [agent("a", ["b"]), agent("b", ["c"]), agent("c")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, (input) => {
    const id = activeAgent(input);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === "a" && count === 1) {
      return {
        content: [],
        toolCalls: [{
          id: "ask-b",
          action: "ask",
          input: { target: "b", message: "A asks B" } as LlmJsonObject,
        }, {
          id: "mark-after-b",
          action: "mark",
          input: { value: "outer-resumed" } as LlmJsonObject,
        }],
        attempts: [{ status: "completed" }],
      };
    }
    if (id === "b" && count === 1) {
      assertStringIncludes(requestText(input), "A asks B");
      return {
        content: [],
        toolCalls: [{
          id: "ask-c",
          action: "ask",
          input: { target: "c", message: "B asks C" } as LlmJsonObject,
        }],
        attempts: [{ status: "completed" }],
      };
    }
    if (id === "c") {
      assertStringIncludes(requestText(input), "B asks C");
      return {
        content: { type: "text", text: "C answers B", role: "body" },
        attempts: [{ status: "completed" }],
      };
    }
    if (id === "b") {
      assertStringIncludes(requestText(input), "C answers B");
      return {
        content: { type: "text", text: "B answers A", role: "body" },
        attempts: [{ status: "completed" }],
      };
    }
    assertStringIncludes(requestText(input), "B answers A");
    return {
      content: { type: "text", text: "A nested final", role: "body" },
      attempts: [{ status: "completed" }],
    };
  });
  try {
    const root = await startRun(fixture);
    await waitForRun(fixture, root, 11);
    assertEquals(calls, ["a", "b", "c", "b", "a"]);
    assertEquals(markExecutions, ["outer-resumed"]);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    const questions = messages
      .flatMap((message) => {
        const ask = agentAskMetadata(message.metadata);
        return ask?.phase === "question" && ask.questionMessageId === message.id
          ? [ask]
          : [];
      });
    assertEquals(questions.map((ask) => ask.depth), [1, 2]);
    assertEquals(questions[1].parentAskId, questions[0].askId);
    assertEquals(
      questions[1].parentQuestionMessageId,
      questions[0].questionMessageId,
    );
    for (const message of messages) {
      const rawAsk = (message.metadata.copilotzAsk ?? {}) as Record<
        string,
        unknown
      >;
      assertEquals("parentAsk" in rawAsk, false);
    }
    assertEquals(await messageText(fixture, messages[10]), "A nested final");
  } finally {
    await fixture.close();
  }
});

Deno.test("Tool history visibility is participant-relative across agents", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, (input) => {
    const id = activeAgent(input);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === "a" && count === 1) {
      return {
        content: [],
        toolCalls: [{
          id: "private-call",
          action: "mark",
          input: { value: "PRIVATE_TOOL_ARGUMENT" } as LlmJsonObject,
        }, {
          id: "public-call",
          action: "publish",
          input: { value: "PUBLIC_TOOL_RESULT" } as LlmJsonObject,
        }],
        attempts: [{ status: "completed" }],
      };
    }
    // Parallel siblings deliberately cannot observe one another before their
    // shared barrier. Start the dependent Ask on the continuation turn, after
    // both visibility-scoped Tool results are durable transcript Messages.
    if (id === "a" && count === 2) {
      return {
        content: [],
        toolCalls: [{
          id: "ask-b",
          action: "ask",
          input: {
            target: "b",
            message: "Review only what your history permits.",
          } as LlmJsonObject,
        }],
        attempts: [{ status: "completed" }],
      };
    }
    if (id === "b") {
      const transcript = requestText(input);
      assert(!transcript.includes("PRIVATE_TOOL_ARGUMENT"));
      assert(!transcript.includes("PRIVATE_TOOL_OUTPUT"));
      assertStringIncludes(transcript, "PUBLIC_TOOL_RESULT");
      return {
        content: { type: "text", text: "Visibility verified", role: "body" },
        attempts: [{ status: "completed" }],
      };
    }
    return {
      content: { type: "text", text: "A final", role: "body" },
      attempts: [{ status: "completed" }],
    };
  });
  try {
    const root = await startRun(fixture);
    await waitForRun(fixture, root, 9);
    assertEquals(calls, ["a", "a", "b", "a"]);
    assertEquals(markExecutions, ["PRIVATE_TOOL_ARGUMENT"]);
  } finally {
    await fixture.close();
  }
});

Deno.test("an asked-Agent llm.call failure becomes a Tool Message and resumes", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, (input) => {
    const id = activeAgent(input);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === "a" && count === 1) {
      return {
        content: [],
        toolCalls: [{
          id: "ask-b",
          action: "ask",
          input: { target: "b", message: "B, inspect this" } as LlmJsonObject,
        }, {
          id: "mark-after-failure",
          action: "mark",
          input: { value: "after-failure" } as LlmJsonObject,
        }],
        attempts: [{ status: "completed" }],
      };
    }
    if (id === "b") throw new Error("provider exploded");
    assertStringIncludes(requestText(input), "provider exploded");
    return {
      content: { type: "text", text: "A recovered", role: "body" },
      attempts: [{ status: "completed" }],
    };
  });
  try {
    const root = await startRun(fixture);
    await waitForRun(fixture, root, 6);
    assertEquals(calls, ["a", "b", "a"]);
    assertEquals(markExecutions, ["after-failure"]);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    const failure = messages.find((message) =>
      message.sender.participantType === "tool"
    );
    assertExists(failure);
    assertStringIncludes(
      await messageText(fixture, failure),
      "provider exploded",
    );
    assertEquals(await messageText(fixture, messages[5]), "A recovered");
    const lifecycle = await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "llm.call",
    );
    const failed = lifecycle.find((event) => event.status === "failed");
    assertExists(failed);
    assertEquals(failed.metadata.schema, "copilotz.core.llm-call.v1");
    assertEquals(
      (failed.metadata.ask as Record<string, unknown>).askedAgentId,
      "b",
    );
  } finally {
    await fixture.close();
  }
});
