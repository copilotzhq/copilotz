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
    models: { generate: "askModel" },
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

type Handler = (
  input: LlmAdapterCallInput,
) => LlmAdapterResult | Promise<LlmAdapterResult>;

function adapterFrom(handler: Handler): LlmAdapter {
  return Object.freeze({
    call(input) {
      const result = Promise.resolve().then(() => handler(input));
      return Object.freeze({
        frames: new ReadableStream({
          async start(controller) {
            try {
              await result;
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
  close(): Promise<void>;
}>;

async function createFixture(
  agents: readonly AgentResource[],
  handler: Handler,
): Promise<Fixture> {
  markExecutions.splice(0);
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
  });
  return Object.freeze({
    db,
    engine,
    agents,
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
    askedParticipantId: "agent-forged",
    askedAgentId: "forged",
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
    askedParticipantId: "agent-c",
    askedAgentId: "c",
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
    assertEquals(
      agentAskMetadata(question.metadata)?.askId,
      agentAskMetadata(answer.metadata)?.askId,
    );
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
        }, {
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
    await waitForRun(fixture, root, 8);
    assertEquals(calls, ["a", "b", "a"]);
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
