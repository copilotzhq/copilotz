import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import {
  agentAskMetadata,
  type AgentResource,
  corePlugin,
} from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import {
  deferWorkflowTool,
  isDeferredWorkflowToolResult,
} from "@copilotz/copilotz/tools";
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

const TEST_SCHEMA = "copilotz_core_ask";
const NAMESPACE = "tenant-a";

function agent(id: string, agents: readonly string[] = []): AgentResource {
  return Object.freeze({
    id,
    name: id.toUpperCase(),
    role: "assistant",
    instructions: `ACTIVE_AGENT=${id}`,
    models: { generate: "askModel" },
    capabilities: { agents },
  });
}

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
  const db = await createTestDatabase({ url: ":memory:" });
  const app = definePlugin({
    id: "test.core-ask.resources",
    version: "1.0.0",
    resources: {
      agents: Object.fromEntries(
        agents.map((resource) => [resource.id, resource]),
      ),
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

Deno.test("deferred WorkflowTool results remain explicit during the transitional Tool path", () => {
  const deferred = deferWorkflowTool({ metadata: { askId: "ask-1" } });
  assert(isDeferredWorkflowToolResult(deferred));
  assertEquals(deferred.metadata, { askId: "ask-1" });
  assertEquals(isDeferredWorkflowToolResult({ kind: "deferred" }), false);
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
      id === "a" ? ["ask"] : [],
    );
    if (id === "a" && count === 1) {
      return {
        content: [],
        toolCalls: [{
          id: "ask-b",
          action: "ask",
          input: { target: "b", message: "A asks B publicly" },
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
    return {
      content: { type: "text", text: "A public final", role: "body" },
      attempts: [{ status: "completed" }],
    };
  });
  try {
    const root = await startRun(fixture);
    await waitForRun(fixture, root, 6);
    assertEquals(calls, ["a", "b", "a"]);
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(await messageText(fixture, messages[5]), "A public final");
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
          input: { target: "b", message: "B, inspect this" },
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
    await waitForRun(fixture, root, 5);
    assertEquals(calls, ["a", "b", "a"]);
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
    assertEquals(await messageText(fixture, messages[4]), "A recovered");
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
