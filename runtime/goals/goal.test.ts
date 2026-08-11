import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import { createCopilotzApplication } from "../application/index.ts";
import type { CopilotzApplication } from "../application/index.ts";
import { createSqlSession } from "../events/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import type { GoalStreamEvent } from "./types.ts";

const NAMESPACE = "goal-tenant";

const testedAgent: Agent = Object.freeze({
  id: "tested",
  name: "Tested agent",
  role: "assistant under test",
});

const simulatorAgent: Agent = Object.freeze({
  id: "simulator",
  name: "Simulated customer",
  role: "goal simulator",
});

const judgeAgent: Agent = Object.freeze({
  id: "judge",
  name: "Goal judge",
  role: "goal evaluator",
});

type ScriptMode = "normal" | "tool-isolation";

async function messageText(
  context: CopilotzProcessorContext,
  messageId: string,
): Promise<string> {
  const message = await context.conversation.getMessage(messageId);
  assertExists(message);
  const resolved = await context.content.resolveMany(message.content);
  return resolved.map((value) => value.text ?? "").join("\n");
}

function scriptedGoalPlugin(mode: ScriptMode = "normal"): CopilotzPlugin {
  const processor = defineProcessor<CopilotzProcessorContext>({
    id: `fixture.goal-script.${mode}`,
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => Boolean(event.routing?.recipientIds?.length),
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const recipientId = event.routing.recipientIds?.[0];
      if (!recipientId) return;
      const recipient = await context.conversation.getParticipant(recipientId);
      if (!recipient || recipient.participantType !== "agent") return;
      const incoming = await context.conversation.getMessage(event.subject.id);
      assertExists(incoming);
      const input = await messageText(context, incoming.id);
      const agentId = recipient.agentId ?? recipient.externalId;

      if (mode === "tool-isolation" && agentId === "tested") {
        const toolContent = await context.content.prepare(
          { type: "text", text: "SECRET_TOOL_RESULT" },
          { operationKey: "fixture:secret-tool-content" },
        );
        await context.conversation.createMessage({
          threadId: incoming.threadId,
          sender: {
            externalId: "fixture-secret-tool",
            participantType: "tool",
            name: "Fixture secret tool",
          },
          content: toolContent,
          metadata: { historyVisibility: "public_status" },
        }, { operationKey: "fixture:secret-tool-message" });
      }

      const answer = agentId === "tested"
        ? input.includes("details")
          ? "Payment link generated"
          : "Which passenger details should I use?"
        : agentId === "simulator"
        ? mode === "tool-isolation"
          ? input.includes("SECRET_TOOL_RESULT")
            ? "LEAKED_TOOL_RESULT"
            : "TOOL_RESULT_NOT_VISIBLE"
          : "Use my details"
        : agentId === "judge"
        ? "PASS score=0.8"
        : "";
      if (!answer) return;
      const content = await context.content.prepare(
        { type: "text", text: answer },
        { operationKey: "fixture:answer-content" },
      );
      await context.conversation.createMessage({
        threadId: incoming.threadId,
        sender: {
          id: recipient.id,
          externalId: recipient.externalId,
          participantType: "agent",
          agentId,
          name: recipient.name,
        },
        content,
      }, { operationKey: "fixture:answer-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: `fixture.goals.${mode}`,
      version: "1.0.0",
      provides: {
        agents: [testedAgent.id, simulatorAgent.id, judgeAgent.id],
        processors: [processor.id],
      },
    },
    resources: {
      agents: [testedAgent, simulatorAgent, judgeAgent],
      processors: [processor],
    },
  });
}

async function createFixture(
  schema: string,
  mode: ScriptMode = "normal",
): Promise<
  Readonly<{
    application: CopilotzApplication;
    close(): Promise<void>;
  }>
> {
  const database = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database,
    namespace: NAMESPACE,
    databaseSchema: schema,
    core: false,
    plugins: [scriptedGoalPlugin(mode)],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  return Object.freeze({
    application,
    async close() {
      await application.shutdown();
      await database.close();
    },
  });
}

async function collect(
  stream: ReadableStream<GoalStreamEvent>,
): Promise<GoalStreamEvent[]> {
  const values: GoalStreamEvent[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

Deno.test("event-native goal runs bounded target and simulator threads", async () => {
  const fixture = await createFixture("goal_loop");
  try {
    const handle = await fixture.application.goal({
      content: "I want a ticket",
      sender: {
        id: "client-01",
        externalId: "client-01",
        name: "Client One",
        usingAgent: "simulator",
      },
      target: "tested",
      thread: { externalId: "goal-main-thread" },
      maxTurns: 4,
      stop: ({ lastMessage }) =>
        lastMessage?.text.includes("Payment")
          ? { stop: true, status: "completed", reason: "payment generated" }
          : false,
    });
    const streamed = collect(handle.events);
    const result = await handle.done;
    const items = await streamed;

    assertEquals(result.status, "completed");
    assertEquals(result.reason, "payment generated");
    assertEquals(result.metrics.targetRuns, 2);
    assertEquals(result.metrics.leadRuns, 1);
    assertEquals(result.metrics.judgeRuns, 0);
    assertEquals(
      result.transcript.map((message) => [
        message.phase,
        message.sender.participantType,
        message.text,
      ]),
      [
        ["target", "human", "I want a ticket"],
        ["target", "agent", "Which passenger details should I use?"],
        ["lead", "human", "Which passenger details should I use?"],
        ["lead", "agent", "Use my details"],
        ["target", "human", "Use my details"],
        ["target", "agent", "Payment link generated"],
      ],
    );

    const targetQuestion = result.transcript.find((message) =>
      message.phase === "target" &&
      message.sender.participantType === "agent" &&
      message.text.startsWith("Which passenger")
    );
    const leadInput = result.transcript.find((message) =>
      message.phase === "lead" && message.sender.participantType === "human"
    );
    const leadAnswer = result.transcript.find((message) =>
      message.phase === "lead" && message.sender.participantType === "agent"
    );
    const targetFollowup = result.transcript.find((message) =>
      message.phase === "target" && message.turn === 2 &&
      message.sender.participantType === "human"
    );
    assertExists(targetQuestion);
    assertExists(leadInput);
    assertExists(leadAnswer);
    assertExists(targetFollowup);
    assertEquals(
      leadInput.content[0]?.assetId,
      targetQuestion.content[0]?.assetId,
    );
    assertEquals(
      targetFollowup.content[0]?.assetId,
      leadAnswer.content[0]?.assetId,
    );

    assert(items.some((item) => item.type === "goal.stopped"));
    assert(items.some((item) => item.type === "goal.result"));
    assert(
      items.some((item) =>
        item.type === "goal.event" && item.payload.phase === "lead" &&
        item.payload.event.type === "message.created"
      ),
    );
    assert(!items.some((item) => item.type.startsWith("GOAL_")));
    const persisted = await fixture.application.events.list({
      namespace: NAMESPACE,
      limit: 1_000,
    });
    assert(persisted.every((event) => !event.type.startsWith("GOAL_")));
  } finally {
    await fixture.close();
  }
});

Deno.test("goal hands only the target final message assets to its simulator", async () => {
  const fixture = await createFixture("goal_tool_isolation", "tool-isolation");
  try {
    const handle = await fixture.application.goal({
      content: "I want a ticket",
      sender: {
        externalId: "client-02",
        name: "Client Two",
        usingAgent: "simulator",
      },
      target: "tested",
      maxTurns: 2,
    });
    const streamed = collect(handle.events);
    const result = await handle.done;
    await streamed;

    const toolResult = result.transcript.find((message) =>
      message.phase === "target" &&
      message.sender.participantType === "tool" &&
      message.text === "SECRET_TOOL_RESULT"
    );
    const targetAnswer = result.transcript.find((message) =>
      message.phase === "target" && message.turn === 1 &&
      message.sender.participantType === "agent"
    );
    const leadInput = result.transcript.find((message) =>
      message.phase === "lead" && message.sender.participantType === "human"
    );
    const leadAnswer = result.transcript.find((message) =>
      message.phase === "lead" && message.sender.participantType === "agent"
    );
    assertExists(toolResult);
    assertExists(targetAnswer);
    assertExists(leadInput);
    assertExists(leadAnswer);
    assertEquals(leadInput.text, "Which passenger details should I use?");
    assertEquals(leadAnswer.text, "TOOL_RESULT_NOT_VISIBLE");
    assertEquals(
      leadInput.content[0]?.assetId,
      targetAnswer.content[0]?.assetId,
    );
    assert(leadInput.content[0]?.assetId !== toolResult.content[0]?.assetId);
  } finally {
    await fixture.close();
  }
});

Deno.test("goal evaluation can invoke a declared judge through normal runs", async () => {
  const fixture = await createFixture("goal_judge");
  try {
    const handle = await fixture.application.goal({
      content: "I want a ticket",
      sender: {
        externalId: "client-03",
        name: "Client Three",
        usingAgent: "simulator",
      },
      target: "tested",
      maxTurns: 1,
      evaluate: async ({ run }) => {
        const judge = await run({
          content: "Judge this transcript",
          target: "judge",
        });
        return {
          name: "judge",
          status: judge.text.includes("PASS") ? "completed" : "failed",
          score: 0.8,
          report: judge.text,
        };
      },
    });
    const streamed = collect(handle.events);
    const result = await handle.done;
    const items = await streamed;

    assertEquals(result.status, "completed");
    assertEquals(result.score, 0.8);
    assertEquals(result.report, "PASS score=0.8");
    assertEquals(result.metrics.judgeRuns, 1);
    assert(
      result.transcript.some((message) =>
        message.phase === "judge" && message.sender.agentId === "judge" &&
        message.text === "PASS score=0.8"
      ),
    );
    assert(
      items.some((item) =>
        item.type === "goal.event" && item.payload.phase === "judge"
      ),
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("goal cancellation settles without starting another phase", async () => {
  const fixture = await createFixture("goal_cancel");
  try {
    const controller = new AbortController();
    controller.abort("cancel before simulation");
    const handle = await fixture.application.goal({
      content: "Do not run",
      sender: {
        externalId: "client-04",
        usingAgent: "simulator",
      },
      target: "tested",
      signal: controller.signal,
    });
    const streamed = collect(handle.events);
    const result = await handle.done;
    const items = await streamed;

    assertEquals(result.status, "cancelled");
    assertEquals(result.reason, "cancel before simulation");
    assertEquals(result.metrics.targetRuns, 0);
    assertEquals(result.metrics.leadRuns, 0);
    assertEquals(items.at(-1)?.type, "goal.result");
    await handle.cancel("already settled");
  } finally {
    await fixture.close();
  }
});

Deno.test("goal requires declared agent resource identities", async () => {
  const fixture = await createFixture("goal_agents");
  try {
    await assertRejects(
      () =>
        fixture.application.goal({
          content: "hello",
          sender: {
            externalId: "client-05",
            usingAgent: "inline-or-missing",
          },
          target: "tested",
        }),
      Error,
      "Unknown agents resource 'inline-or-missing'",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("goal runtime remains factory-first and runtime-neutral", async () => {
  for (const module of ["goal.ts", "index.ts", "types.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bclass\s+\w+/.test(source), module);
    assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/queueId|queueTTL|ackMode|runGeneration/.test(source), module);
    assert(!/GOAL_STOPPED|GOAL_RESULT/.test(source), module);
  }
});
