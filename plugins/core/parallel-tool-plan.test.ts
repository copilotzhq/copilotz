import { assert, assertEquals } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import {
  type AgentResource,
  corePlugin,
  coreToolActionMessageMetadata,
  coreToolPlanResultMetadata,
} from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterResult,
  LlmJsonObject,
  LlmToolCall,
} from "@copilotz/copilotz/llm";
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
import { defineTool } from "@copilotz/copilotz/tools";
import { projectActionEvents, projectMessages } from "./testing/projections.ts";

const NAMESPACE = "parallel-tool-plan";
const SCHEMA = "copilotz_parallel_tool_plan";

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

function agent(
  id: string,
  tools: readonly string[],
  agents: readonly string[] = [],
): AgentResource {
  return Object.freeze({
    id,
    name: id.toUpperCase(),
    role: "assistant",
    instructions: `ACTIVE_AGENT=${id}`,
    models: { generate: ["testModel"] as const },
    capabilities: { tools, ...(agents.length ? { agents } : {}) },
  });
}

function activeAgent(input: LlmAdapterCallInput): string {
  const match = /ACTIVE_AGENT=([a-z0-9_-]+)/.exec(
    input.request.instructions ?? "",
  );
  if (!match) throw new Error("Test Adapter did not receive the active Agent.");
  return match[1];
}

async function waitForIdle(
  engine: CopilotzEngine,
  rootEventId: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const settlement = await engine.events.settlement(NAMESPACE, rootEventId);
    if (settlement.deadLetters) {
      const failures = await engine.deliveries.list({
        namespace: NAMESPACE,
        status: "dead_letter",
      });
      throw new Error(
        `Tool-plan workflow dead-lettered: ${JSON.stringify(failures)}`,
      );
    }
    if (settlement.unsettled === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the parallel Tool plan.");
}

async function startRun(
  engine: CopilotzEngine,
  agents: readonly AgentResource[],
): Promise<string> {
  const collection = (name: string) => {
    const item = engine.collections.get(name);
    if (!item) throw new Error(`Missing Collection ${name}`);
    return item;
  };
  await collection("participant").create({
    id: "user",
    externalId: "user",
    participantType: "human",
    metadata: {},
  }, { namespace: NAMESPACE });
  for (const resource of agents) {
    await collection("participant").create({
      id: `agent-${resource.id}`,
      externalId: resource.id,
      participantType: "agent",
      agentId: resource.id,
      name: resource.name,
      metadata: {},
    }, { namespace: NAMESPACE });
  }
  await collection("thread").create({
    id: "thread",
    participantIds: ["user", ...agents.map((item) => `agent-${item.id}`)],
    metadata: {},
  }, { namespace: NAMESPACE, identity: { deduplicationId: "thread" } });
  const content = await engine.content.preparer.prepare(
    "run parallel pipelines",
    { namespace: NAMESPACE, idempotencyKey: "user-content" },
  );
  const created = await collection("message").create({
    id: "user-message",
    threadId: "thread",
    senderId: "user",
    recipientIds: ["agent-a"],
    content,
    metadata: {},
  }, {
    namespace: NAMESPACE,
    threadId: "thread",
    routing: { senderId: "user", recipientIds: ["agent-a"] },
    identity: {
      correlationId: "parallel-tool-plan",
      deduplicationId: "user-message",
    },
  });
  return created.event.id;
}

function pipeline(
  id: string,
  first: string,
  second: string,
  branch: string,
  withJq: boolean,
): LlmToolCall {
  const root = {
    type: "tool" as const,
    id,
    action: first,
    input: { run: "parallel-proof", branch },
  };
  const verify = {
    type: "tool" as const,
    id: `${id}:verify`,
    action: second,
    input: { expected: branch },
  };
  return {
    id,
    action: first,
    input: { run: "parallel-proof", branch },
    pipeline: {
      id: `${id}:pipeline`,
      stages: withJq
        ? [root, { type: "jq", filter: "{run, branch, parallel}" }, verify]
        : [root, verify],
    },
  };
}

Deno.test("parallel Tool branches fan out, preserve pipes, and fan in in provider order", async () => {
  const execution: string[] = [];
  const started = new Set<string>();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => openGate = resolve);
  let cFinished!: () => void;
  const cFinishedPromise = new Promise<void>((resolve) => cFinished = resolve);
  const joinGate = async (name: string) => {
    execution.push(`start:${name}`);
    started.add(name);
    if (started.size === 2) openGate();
    await Promise.race([
      gate,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("parallel roots did not overlap")),
          1_500,
        )
      ),
    ]);
  };
  const rootA = defineAction({
    id: "test.parallel.rootA",
    async execute(input: Readonly<{ run: string; branch: string }>) {
      await joinGate("A");
      await cFinishedPromise;
      execution.push("done:A");
      return { ...input, parallel: true };
    },
  });
  const rootC = defineAction({
    id: "test.parallel.rootC",
    async execute(input: Readonly<{ run: string; branch: string }>) {
      await joinGate("C");
      execution.push("done:C");
      return { ...input, parallel: true };
    },
  });
  const verifyB = defineAction({
    id: "test.parallel.verifyB",
    execute(
      input: Readonly<
        { run: string; branch: string; parallel: boolean; expected: string }
      >,
    ) {
      assertEquals(input, {
        run: "parallel-proof",
        branch: "A",
        parallel: true,
        expected: "A",
      });
      execution.push("start:B");
      execution.push("done:B");
      return { final: "A-B" };
    },
  });
  const verifyD = defineAction({
    id: "test.parallel.verifyD",
    execute(
      input: Readonly<
        { run: string; branch: string; parallel: boolean; expected: string }
      >,
    ) {
      assertEquals(input, {
        run: "parallel-proof",
        branch: "C",
        parallel: true,
        expected: "C",
      });
      execution.push("start:D");
      execution.push("done:D");
      cFinished();
      return { final: "C-D" };
    },
  });
  const tools = {
    rootA: defineTool("rootA", rootA, {
      name: "Root A",
      description: "Parallel root A",
    }),
    rootC: defineTool("rootC", rootC, {
      name: "Root C",
      description: "Parallel root C",
    }),
    verifyB: defineTool("verifyB", verifyB, {
      name: "Verify B",
      description: "Second stage B",
    }),
    verifyD: defineTool("verifyD", verifyD, {
      name: "Verify D",
      description: "Second stage D",
    }),
  };
  const calls: string[] = [];
  const testAgent = agent("a", Object.keys(tools));
  const app = definePlugin({
    id: "test.parallel-tool-plan",
    version: "1.0.0",
    actions: { rootA, rootC, verifyB, verifyD },
    resources: {
      agents: { a: testAgent },
      tools,
      models: { testModel: { adapter: "test", model: "parallel-model" } },
    },
    adapters: {
      llm: {
        test: adapterFrom((input) => {
          calls.push(activeAgent(input));
          if (calls.length === 1) {
            return {
              content: [],
              // A→B directly proves ordinary pipes; C→jq→D proves the pure
              // transform has the same durable sequential boundary.
              toolCalls: [
                pipeline("call-A", "rootA", "verifyB", "A", false),
                pipeline("call-C", "rootC", "verifyD", "C", true),
              ],
              attempts: [{ status: "completed" }],
              finishReason: "tool_calls",
            };
          }
          return {
            content: {
              type: "text",
              role: "body",
              text: "both branches are complete",
            },
            attempts: [{ status: "completed" }],
          };
        }),
      },
    },
  });
  const db: TestDatabase = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({ plugins: [corePlugin, app] });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
    execution: { capacity: 4 },
  });
  try {
    const rootEventId = await startRun(engine, [testAgent]);
    await waitForIdle(engine, rootEventId);
    assertEquals(
      calls,
      ["a", "a"],
      "only the final barrier may continue the Agent",
    );
    assertEquals(
      execution.filter((entry) => entry.startsWith("start:")).sort(),
      ["start:A", "start:B", "start:C", "start:D"],
    );
    assert(
      execution.indexOf("start:B") > execution.indexOf("done:A"),
      "B must wait for A",
    );
    assert(
      execution.indexOf("start:D") > execution.indexOf("done:C"),
      "D must wait for C",
    );
    assert(
      execution.indexOf("done:D") < execution.indexOf("done:A"),
      "branches complete in reverse order",
    );
    const messages = await projectMessages(engine, NAMESPACE, "thread");
    const toolMessages = messages.filter((message) =>
      message.sender.participantType === "tool"
    );
    assertEquals(
      toolMessages.length,
      2,
      "only root calls get provider Tool results",
    );
    assertEquals(
      toolMessages.map((message) =>
        (message.metadata as Record<string, unknown>).toolPlanIndex
      ),
      [0, 1],
      "Tool transcript follows provider call order, not completion order",
    );
    const llmCalls = await projectActionEvents(engine, NAMESPACE, "llm.call");
    assertEquals(
      llmCalls.filter((event) => event.status === "completed").length,
      2,
    );
    for (const actionId of [rootA.id, rootC.id, verifyB.id, verifyD.id]) {
      const events = await projectActionEvents(engine, NAMESPACE, actionId);
      assertEquals(
        events.filter((event) => event.status === "completed").length,
        1,
        `${actionId} executes exactly once`,
      );
    }
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("parallel Ask branches are futures: nested Agent/Tool work fans in before one parent continuation", async () => {
  const agentStarts = new Set<string>();
  let releaseStarts!: () => void;
  const startsReady = new Promise<void>((resolve) => releaseStarts = resolve);
  let cReturned!: () => void;
  const cReturnedPromise = new Promise<void>((resolve) => cReturned = resolve);
  const waitForBothAskedAgents = async (id: "b" | "c") => {
    agentStarts.add(id);
    if (agentStarts.size === 2) releaseStarts();
    await Promise.race([
      startsReady,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("parallel asks did not overlap")),
          1_500,
        )
      ),
    ]);
  };
  const marks: string[] = [];
  const capturedAskAnswers: unknown[] = [];
  const mark = defineAction({
    id: "test.parallel.nested-mark",
    execute(input: Readonly<{ value: string }>) {
      marks.push(input.value);
      return { marked: input.value };
    },
  });
  const markTool = defineTool("mark", mark, {
    name: "Mark",
    description: "Nested Agent evidence tool",
  });
  const capture = defineAction({
    id: "test.parallel.capture-ask-answer",
    execute(input: Readonly<{ answer: unknown }>) {
      capturedAskAnswers.push(input.answer);
      return { captured: true };
    },
  });
  const captureTool = defineTool("capture", capture, {
    name: "Capture Ask Answer",
    description: "Captures jq-mapped canonical Ask content.",
  });
  const a = agent("a", ["capture"], ["b", "c"]);
  const b = agent("b", [], ["d"]);
  const c = agent("c", []);
  const d = agent("d", ["mark"]);
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const app = definePlugin({
    id: "test.parallel-ask-futures",
    version: "1.0.0",
    actions: { mark, capture },
    resources: {
      agents: { a, b, c, d },
      tools: { mark: markTool, capture: captureTool },
      models: { testModel: { adapter: "test", model: "ask-futures-model" } },
    },
    adapters: {
      llm: {
        test: adapterFrom(async (input) => {
          const id = activeAgent(input);
          calls.push(id);
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          if (id === "a" && count === 1) {
            return {
              content: [],
              toolCalls: [
                {
                  id: "ask-b",
                  action: "ask",
                  input: {
                    target: "b",
                    message: "B: obtain nested evidence from D, then answer.",
                  } as LlmJsonObject,
                  pipeline: {
                    id: "ask-b:pipeline",
                    stages: [
                      {
                        type: "tool",
                        id: "ask-b",
                        action: "ask",
                        input: {
                          target: "b",
                          message:
                            "B: obtain nested evidence from D, then answer.",
                        },
                      },
                      { type: "jq", filter: "{answer: .}" },
                      {
                        type: "tool",
                        id: "capture-b",
                        action: "capture",
                        input: {},
                      },
                    ],
                  },
                },
                {
                  id: "ask-c",
                  action: "ask",
                  input: {
                    target: "c",
                    message: "C: answer independently and promptly.",
                  } as LlmJsonObject,
                },
              ],
              attempts: [{ status: "completed" }],
              finishReason: "tool_calls",
            };
          }
          if (id === "b" && count === 1) {
            await waitForBothAskedAgents("b");
            await cReturnedPromise;
            return {
              content: [],
              toolCalls: [{
                id: "ask-d",
                action: "ask",
                input: {
                  target: "d",
                  message: "D: use Mark, then send the evidence.",
                  mode: "private",
                } as LlmJsonObject,
              }],
              attempts: [{ status: "completed" }],
              finishReason: "tool_calls",
            };
          }
          if (id === "c") {
            assertEquals(count, 1);
            await waitForBothAskedAgents("c");
            cReturned();
            return {
              content: { type: "text", role: "body", text: "C answer" },
              attempts: [{ status: "completed" }],
            };
          }
          if (id === "d" && count === 1) {
            return {
              content: [],
              toolCalls: [{
                id: "d-mark",
                action: "mark",
                input: { value: "nested evidence" },
              }],
              attempts: [{ status: "completed" }],
              finishReason: "tool_calls",
            };
          }
          if (id === "d" && count === 2) {
            return {
              content: { type: "text", role: "body", text: "D evidence" },
              attempts: [{ status: "completed" }],
            };
          }
          if (id === "b" && count === 2) {
            return {
              content: { type: "text", role: "body", text: "B answer after D" },
              attempts: [{ status: "completed" }],
            };
          }
          if (id === "a" && count === 2) {
            const toolReceipts = input.request.messages.filter((message) =>
              message.role === "tool"
            );
            assertEquals(
              toolReceipts.map((message) => message.toolCallId),
              ["ask-b", "ask-c"],
              "parallel Ask receipts retain provider plan order before answers",
            );
            const planIndex = input.request.messages.findIndex((message) =>
              message.role === "assistant" &&
              (message.toolCalls?.length ?? 0) > 0
            );
            const lastReceiptIndex = input.request.messages.reduce(
              (last, message, index) => message.role === "tool" ? index : last,
              -1,
            );
            assert(
              input.request.messages.slice(planIndex + 1, lastReceiptIndex)
                .every((message) => message.role === "tool"),
              "no peer message can split an outstanding tool-call receipt block",
            );
            const returned = input.request.messages.flatMap((message) =>
              message.content
            )
              .filter((part) => part.type === "text").map((part) => part.text)
              .join("\n");
            assert(returned.includes("B answer after D"));
            assert(returned.includes("C answer"));
            assertEquals(
              input.request.messages.filter((message) =>
                message.role === "user" &&
                message.content.some((part) =>
                  part.type === "text" &&
                  (part.text === "B answer after D" || part.text === "C answer")
                )
              ).length,
              2,
              "canonical answers enter the parent transcript exactly once",
            );
            const namedAnswers = input.request.messages.flatMap((message) =>
              message.role === "user" &&
                message.content.some((part) =>
                  part.type === "text" && part.text === "B answer after D"
                )
                ? ["b"]
                : message.role === "user" &&
                    message.content.some((part) =>
                      part.type === "text" && part.text === "C answer"
                    )
                ? ["c"]
                : []
            );
            assertEquals(
              namedAnswers,
              ["b", "c"],
              "referenced root answers follow their receipts' plan order",
            );
            assert(
              !returned.includes(
                "B: obtain nested evidence from D, then answer.",
              ),
              "parent does not receive the raw Ask question as an assistant/user duplicate",
            );
            assert(
              !returned.includes("D evidence"),
              "private nested Ask evidence does not leak to the root requester",
            );
            return {
              content: {
                type: "text",
                role: "body",
                text: "A final after B and C",
              },
              attempts: [{ status: "completed" }],
            };
          }
          throw new Error(`Unexpected ${id} invocation #${count}`);
        }),
      },
    },
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({ plugins: [corePlugin, app] });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
    execution: { capacity: 4 },
  });
  try {
    const rootEventId = await startRun(engine, [a, b, c, d]);
    await waitForIdle(engine, rootEventId);
    assertEquals(
      calls.filter((id) => id === "a"),
      ["a", "a"],
      "A continues once, after both Ask futures settle",
    );
    assertEquals(marks, ["nested evidence"]);
    assertEquals(capturedAskAnswers.length, 1);
    assert(
      Array.isArray(capturedAskAnswers[0]),
      "Ask -> jq preserves canonical ContentSequence as downstream pipeline value",
    );
    assertEquals(agentStarts, new Set(["b", "c"]));
    assert(
      calls.indexOf("c") < calls.lastIndexOf("b"),
      "C's direct answer returns before B's nested future resolves",
    );
    const asks = await projectActionEvents(
      engine,
      NAMESPACE,
      "copilotz.core.ask",
    );
    assertEquals(
      asks.filter((event) => event.status === "completed").length,
      3,
      "A→B, A→C, and B→D each invoke one Ask Action",
    );
    const askAnswers = (await projectMessages(engine, NAMESPACE, "thread"))
      .filter((message) =>
        (message.metadata.copilotzAsk as { phase?: unknown } | undefined)
          ?.phase === "answer"
      );
    assert(
      askAnswers.every((message) => message.recipientIds.length === 1),
      "canonical Ask answers retain a durable requester recipient",
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("an unavailable root branch fans in with a successful sibling and one continuation", async () => {
  let releaseGood!: () => void;
  const goodStarted = Promise.withResolvers<void>();
  const release = new Promise<void>((resolve) => releaseGood = resolve);
  const executions: string[] = [];
  const good = defineAction({
    id: "test.parallel.available-good",
    async execute() {
      executions.push("good");
      goodStarted.resolve();
      await release;
      return { good: true };
    },
  });
  const gone = defineAction({
    id: "test.parallel.unavailable-gone",
    execute() {
      executions.push("gone");
      return { gone: true };
    },
  });
  const tools = {
    good: defineTool("good", good, {
      name: "Good",
      description: "Completes normally",
    }),
    gone: defineTool("gone", gone, {
      name: "Gone",
      description: "Will be revoked after planning",
    }),
  };
  // This deliberately remains mutable: the registry keeps resource identity,
  // modelling a current grant change after the immutable plan snapshot.
  const mutableAgent = {
    id: "a",
    name: "A",
    role: "assistant",
    instructions: "ACTIVE_AGENT=a",
    models: { generate: ["testModel"] as [string, ...string[]] },
    capabilities: { tools: ["good", "gone"] },
  };
  const testAgent = mutableAgent as AgentResource;
  const calls: string[] = [];
  const app = definePlugin({
    id: "test.parallel-unavailable-root",
    version: "1.0.0",
    actions: { good, gone },
    resources: {
      agents: { a: testAgent },
      tools,
      models: { testModel: { adapter: "test", model: "unavailable-root" } },
    },
    adapters: {
      llm: {
        test: adapterFrom((input) => {
          calls.push(activeAgent(input));
          return calls.length === 1
            ? {
              content: [],
              toolCalls: [
                { id: "good-root", action: "good", input: {} },
                { id: "gone-root", action: "gone", input: {} },
              ],
              attempts: [{ status: "completed" }],
              finishReason: "tool_calls",
            }
            : {
              content: {
                type: "text",
                role: "body",
                text: "continued exactly once",
              },
              attempts: [{ status: "completed" }],
            };
        }),
      },
    },
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({ plugins: [corePlugin, app] });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
    execution: { capacity: 1 },
  });
  try {
    const rootEventId = await startRun(engine, [testAgent]);
    await goodStarted.promise;
    // Revoke only the second selected Tool after plan creation and before its
    // ready delivery. The first branch remains a real Action lifecycle.
    mutableAgent.capabilities.tools = ["good"];
    releaseGood();
    await waitForIdle(engine, rootEventId);
    assertEquals(
      executions,
      ["good"],
      "unavailable branch never invokes its Action",
    );
    assertEquals(calls, ["a", "a"], "both roots still yield one continuation");
    const messages = (await projectMessages(engine, NAMESPACE, "thread"))
      .filter((message) => message.sender.participantType === "tool");
    assertEquals(
      messages.map((message) =>
        (message.metadata as Record<string, unknown>).toolPlanIndex
      ),
      [0, 1],
    );
    const unavailable = coreToolPlanResultMetadata(messages[1].metadata);
    assert(
      unavailable,
      "unavailable root carries formal branch-result provenance",
    );
    assertEquals(unavailable.resultKind, "unavailable");
    assertEquals(
      unavailable.sourceAction,
      undefined,
      "root unavailable must not claim an Action run",
    );
    assertEquals(
      (messages[1].metadata as Record<string, unknown>).copilotzToolAction,
      undefined,
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("a trailing jq result retains its real Action provenance", async () => {
  const source = defineAction({
    id: "test.parallel.trailing-jq-source",
    execute() {
      return { value: "source" };
    },
  });
  const sourceTool = defineTool("source", source, {
    name: "Source",
    description: "Source value for jq",
  });
  const testAgent = agent("a", ["source"]);
  const calls: string[] = [];
  const app = definePlugin({
    id: "test.parallel-trailing-jq",
    version: "1.0.0",
    actions: { source },
    resources: {
      agents: { a: testAgent },
      tools: { source: sourceTool },
      models: { testModel: { adapter: "test", model: "trailing-jq" } },
    },
    adapters: {
      llm: {
        test: adapterFrom((input) => {
          calls.push(activeAgent(input));
          return calls.length === 1
            ? {
              content: [],
              toolCalls: [{
                id: "source-root",
                action: "source",
                input: {},
                pipeline: {
                  id: "source-pipe",
                  stages: [
                    {
                      type: "tool",
                      id: "source-root",
                      action: "source",
                      input: {},
                    },
                    { type: "jq", filter: '. + {value: (.value + "-jq")}' },
                  ],
                },
              }],
              attempts: [{ status: "completed" }],
              finishReason: "tool_calls",
            }
            : {
              content: { type: "text", role: "body", text: "done" },
              attempts: [{ status: "completed" }],
            };
        }),
      },
    },
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const registry = await createPluginRegistry({ plugins: [corePlugin, app] });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
  });
  try {
    const rootEventId = await startRun(engine, [testAgent]);
    await waitForIdle(engine, rootEventId);
    const [result] = (await projectMessages(engine, NAMESPACE, "thread"))
      .filter((message) => message.sender.participantType === "tool");
    const provenance = coreToolActionMessageMetadata(result.metadata);
    assert(provenance, "successful jq result remains action-backed");
    const actions = await projectActionEvents(engine, NAMESPACE, source.id);
    const terminal = actions.find((event) => event.status === "completed");
    assertEquals(provenance.actionRunId, terminal?.actionRunId);
    assert(!provenance.actionRunId.startsWith("jq:"));
    assertEquals(calls, ["a", "a"]);
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
