import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";

import type { Agent } from "../resources/index.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { toolExecutionContent } from "../domain/index.ts";
import { type CopilotzEngine, createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAPI,
  TokenUsage,
  ToolInvocation,
} from "../llm/types.ts";
import {
  createPluginRegistry,
  definePlugin,
  type PluginRegistry,
} from "../plugins/index.ts";
import {
  agentAskMetadata,
  createAgentAskPlugin,
  createTextWorkflowPlugin,
  deferWorkflowTool,
  defineLlmProviderResource,
  isDeferredWorkflowToolResult,
  type LlmChat,
} from "./index.ts";

const TEST_SCHEMA = "copilotz_agent_ask";

const usage: TokenUsage = {
  inputTokens: 4,
  outputTokens: 2,
  totalTokens: 6,
  source: "provider",
  status: "completed",
};

function agent(
  id: string,
  allowedAgents: readonly string[] = [],
): Agent {
  return {
    id,
    name: id,
    role: "assistant",
    instructions: `ACTIVE_AGENT=${id}`,
    allowedAgents: [...allowedAgents],
    allowedTools: ["ask"],
    llmOptions: { provider: "openai", model: "ask-model" },
  };
}

function askCall(
  id: string,
  target: string,
  message: string,
): ToolInvocation {
  return {
    id,
    tool: { id: "ask", name: "Ask Agent" },
    args: JSON.stringify({ target, message }),
    status: "pending",
  };
}

function response(
  request: ChatRequest,
  input: Readonly<{
    answer: string;
    toolCalls?: readonly ToolInvocation[];
  }>,
): ChatResponse {
  return {
    prompt: request.messages,
    answer: input.answer,
    tokens: usage.totalTokens ?? 0,
    usage,
    provider: "openai",
    model: "ask-model",
    finishReason: input.toolCalls ? "tool_calls" : "stop",
    ...(input.toolCalls ? { toolCalls: [...input.toolCalls] } : {}),
  };
}

function requestAgent(
  request: ChatRequest,
  agents: readonly Agent[],
): string {
  const serialized = JSON.stringify(request.messages);
  const matches = agents.filter((candidate) =>
    serialized.includes(`ACTIVE_AGENT=${candidate.id}`)
  );
  assertEquals(matches.length, 1, serialized);
  return matches[0].id;
}

type Fixture = Readonly<{
  db: TestDatabase;
  engine: CopilotzEngine;
  registry: PluginRegistry;
  agents: readonly Agent[];
}>;

async function createFixture(
  agents: readonly Agent[],
  chat: LlmChat,
  maxDepth = 8,
): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const provider = defineLlmProviderResource({
    id: "openai",
    type: "llm",
    factory: () => ({}) as ProviderAPI,
  });
  const app = definePlugin({
    manifest: {
      id: "test.agent-ask.resources",
      version: "1.0.0",
      provides: {
        agents: agents.map((candidate) => candidate.id),
        providers: [provider.id],
      },
    },
    resources: { agents: [...agents], providers: [provider] },
  });
  const registry = await createPluginRegistry({
    plugins: [
      createTextWorkflowPlugin({ chat }),
      createAgentAskPlugin({ maxDepth }),
      app,
    ],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    schema: TEST_SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
    execution: { capacity: 1 },
  });
  return Object.freeze({ db, engine, registry, agents });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.engine.shutdown();
  await fixture.db.close();
}

async function startRun(fixture: Fixture, text: string) {
  await fixture.engine.conversation.createThread({
    namespace: "tenant-a",
    id: "thread-a",
    participants: [
      {
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      },
      ...fixture.agents.map((candidate) => ({
        id: `agent-${candidate.id}`,
        externalId: candidate.id,
        participantType: "agent" as const,
        agentId: candidate.id,
        name: candidate.name,
      })),
    ],
    identity: { deduplicationId: "ask-thread:create" },
  });
  const content = await fixture.engine.content.preparer.prepare(text, {
    namespace: "tenant-a",
    idempotencyKey: "ask-root:content",
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
    recipientIds: ["agent-a"],
    content,
    identity: {
      correlationId: "ask-run",
      deduplicationId: "ask-root:message",
    },
  });
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
      throw new Error(`Ask run dead-lettered: ${JSON.stringify(deliveries)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const settlement = await fixture.engine.events.settlement(
    "tenant-a",
    rootEventId,
  );
  const messages = await fixture.engine.conversation.listMessages(
    "tenant-a",
    "thread-a",
  );
  const deliveries = await fixture.engine.deliveries.list({
    namespace: "tenant-a",
    limit: 1_000,
  });
  const events = await fixture.engine.events.list({
    namespace: "tenant-a",
    correlationId: "ask-run",
    limit: 1_000,
  });
  throw new Error(
    `Timed out waiting for the public ask to settle: ${
      JSON.stringify({
        settlement,
        messages: messages.map((message) => ({
          id: message.id,
          sender: message.sender.id,
          recipients: message.recipientIds,
        })),
        deliveries: deliveries.map((delivery) => ({
          id: delivery.id,
          eventId: delivery.eventId,
          consumerId: delivery.consumerId,
          status: delivery.status,
          lastError: delivery.lastError,
        })),
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          metadata: event.metadata,
        })),
      })
    }`,
  );
}

async function messageText(
  fixture: Fixture,
  message: NonNullable<
    Awaited<ReturnType<CopilotzEngine["conversation"]["getMessage"]>>
  >,
): Promise<string> {
  const values = await fixture.engine.content.resolver.getMany(
    message.content,
    { namespace: "tenant-a" },
  );
  return values.map((value) =>
    value.text ?? (value.value === undefined ? "" : JSON.stringify(value.value))
  ).join("\n");
}

Deno.test("deferred tool results use an explicit runtime-neutral marker", () => {
  const deferred = deferWorkflowTool({ metadata: { askId: "ask-1" } });
  assert(isDeferredWorkflowToolResult(deferred));
  assertEquals(deferred.metadata, { askId: "ask-1" });
  assertEquals(isDeferredWorkflowToolResult({ kind: "deferred" }), false);
});

Deno.test("public ask resumes its caller without occupying worker capacity", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, async (request) => {
    const id = requestAgent(request, agents);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    assertEquals(request.tools?.map((tool) => tool.function.name), ["ask"]);
    if (id === "a" && count === 1) {
      return response(request, {
        answer: "",
        toolCalls: [askCall("ask-b", "b", "A asks B publicly")],
      });
    }
    if (id === "b") {
      assertStringIncludes(
        JSON.stringify(request.messages),
        "A asks B publicly",
      );
      return response(request, { answer: "B public answer" });
    }
    const transcript = JSON.stringify(request.messages);
    assertStringIncludes(transcript, "B public answer");
    assertStringIncludes(transcript, "answerMessageId");
    return response(request, { answer: "A public final" });
  });

  try {
    const root = await startRun(fixture, "Start one ask.");
    await waitForRun(fixture, root.event.id, 5);
    assertEquals(calls, ["a", "b", "a"]);

    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    assertEquals(
      await Promise.all(
        messages.map((message) => messageText(fixture, message)),
      ),
      [
        "Start one ask.",
        "A asks B publicly",
        "B public answer",
        JSON.stringify({
          status: "answered",
          askId: "ask:tool:llm:message:user:agent-a:ask-b",
          questionMessageId: "message:tool:llm:message:user:agent-a:ask-b:ask",
          answerMessageId:
            "message:llm:message:tool:llm:message:user:agent-a:ask-b:ask:agent-b:output",
          askedAgentId: "b",
          askedParticipantId: "agent-b",
        }),
        "A public final",
      ],
    );
    assertEquals(messages.map((message) => message.sender.participantType), [
      "human",
      "agent",
      "agent",
      "tool",
      "agent",
    ]);
    const question = agentAskMetadata(messages[1].metadata);
    const answer = agentAskMetadata(messages[2].metadata);
    assertEquals(question?.phase, "question");
    assertEquals(answer?.phase, "answer");
    assertEquals(answer?.askId, question?.askId);
    assertEquals(question?.depth, 1);

    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.length, 1);
    assertEquals(executions[0].status, "completed");
    const output = await fixture.engine.content.resolver.get(
      toolExecutionContent(executions[0]).output!,
      { namespace: "tenant-a" },
    );
    assertEquals(
      (output.value as Record<string, unknown>).answerMessageId,
      messages[2].id,
    );
    const events = await fixture.engine.events.list({
      namespace: "tenant-a",
      correlationId: "ask-run",
      limit: 1_000,
    });
    assertEquals(
      events.filter((event) => event.type === "thread.created").length,
      0,
    );
    assert(events.every((event) => event.threadId === "thread-a"));
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("nested public asks return through each caller in one thread", async () => {
  const agents = [
    agent("a", ["b"]),
    agent("b", ["c"]),
    agent("c"),
  ];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, async (request) => {
    const id = requestAgent(request, agents);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === "a" && count === 1) {
      return response(request, {
        answer: "",
        toolCalls: [askCall("a-to-b", "b", "A asks B")],
      });
    }
    if (id === "b" && count === 1) {
      assertStringIncludes(JSON.stringify(request.messages), "A asks B");
      return response(request, {
        answer: "",
        toolCalls: [askCall("b-to-c", "c", "B asks C")],
      });
    }
    if (id === "c") {
      assertStringIncludes(JSON.stringify(request.messages), "B asks C");
      return response(request, { answer: "C public answer" });
    }
    if (id === "b") {
      assertStringIncludes(JSON.stringify(request.messages), "C public answer");
      return response(request, { answer: "B public synthesis" });
    }
    assertStringIncludes(
      JSON.stringify(request.messages),
      "B public synthesis",
    );
    return response(request, { answer: "A public final" });
  });

  try {
    const root = await startRun(fixture, "Start nested asks.");
    await waitForRun(fixture, root.event.id, 8);
    assertEquals(calls, ["a", "b", "c", "b", "a"]);
    const messages = await fixture.engine.conversation.listMessages(
      "tenant-a",
      "thread-a",
    );
    const publicAgentMessages = messages.filter((message) =>
      message.sender.participantType === "agent"
    );
    assertEquals(
      await Promise.all(
        publicAgentMessages.map((message) => messageText(fixture, message)),
      ),
      [
        "A asks B",
        "B asks C",
        "C public answer",
        "B public synthesis",
        "A public final",
      ],
    );
    const firstAsk = agentAskMetadata(publicAgentMessages[0].metadata);
    const nestedAsk = agentAskMetadata(publicAgentMessages[1].metadata);
    assertExists(firstAsk);
    assertExists(nestedAsk);
    assertEquals(nestedAsk.depth, 2);
    assertEquals(nestedAsk.parentAskId, firstAsk.askId);
    assertEquals(
      agentAskMetadata(publicAgentMessages[2].metadata)?.askId,
      nestedAsk.askId,
    );
    assertEquals(
      agentAskMetadata(publicAgentMessages[3].metadata)?.askId,
      firstAsk.askId,
    );
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.map((execution) => execution.status), [
      "completed",
      "completed",
    ]);
  } finally {
    await closeFixture(fixture);
  }
});

Deno.test("asked-agent failure settles the ask and resumes the caller", async () => {
  const agents = [agent("a", ["b"]), agent("b")];
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const fixture = await createFixture(agents, async (request) => {
    const id = requestAgent(request, agents);
    calls.push(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (id === "a" && count === 1) {
      return response(request, {
        answer: "",
        toolCalls: [askCall("failing-ask", "b", "B, inspect this")],
      });
    }
    if (id === "b") throw new Error("B provider unavailable");
    assertStringIncludes(
      JSON.stringify(request.messages),
      "Asked agent 'b' failed",
    );
    return response(request, { answer: "A recovered publicly" });
  });

  try {
    const root = await startRun(fixture, "Exercise ask failure.");
    await waitForRun(fixture, root.event.id, 4);
    assertEquals(calls, ["a", "b", "a"]);
    const executions = await fixture.engine.toolExecutions.list(
      "tenant-a",
      "thread-a",
    );
    assertEquals(executions.length, 1);
    assertEquals(executions[0].status, "failed");
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
    assertStringIncludes(
      await messageText(fixture, messages[2]),
      "Asked agent 'b' failed",
    );
    assertEquals(
      await messageText(fixture, messages[3]),
      "A recovered publicly",
    );
  } finally {
    await closeFixture(fixture);
  }
});
