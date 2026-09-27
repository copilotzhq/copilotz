/**
 * Pins the exact provider-neutral wire transcript each Agent receives, from
 * stored Core Messages through the LLM bridge formatter. Any change to these
 * strings changes what a model sees and must be deliberate.
 */
import { assertEquals } from "@std/assert";
import type { ConversationMessage } from "../contracts.ts";
import { buildLlmTranscript } from "../agents/transcript.ts";
import {
  type AgentAskMetadata,
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  CORE_TOOL_PLAN_METADATA_SCHEMA,
  type CoreToolActionOrigin,
  withAgentAskMetadata,
  withAgentAskResultMetadata,
  withCoreToolActionMessageMetadata,
  withCoreToolPlanMetadata,
} from "../workflow-metadata.ts";
import { formatLlmRequestForWire } from "../../../llm/adapters/bridge/index.ts";
import type { WireChatMessage } from "../../../llm/shared/types.ts";

const STAMP = "2026-09-08T00:00:00.000Z";

type Sender = ConversationMessage["sender"];

function participant(
  id: string,
  name: string,
  participantType: Sender["participantType"],
): Sender {
  return {
    id,
    namespace: "tenant",
    externalId: id,
    participantType,
    name,
    metadata: {},
    createdAt: STAMP,
    updatedAt: STAMP,
  } as Sender;
}

const ana = participant("ana", "Ana", "human");
const north = participant("north", "North", "agent");
const south = participant("south", "South", "agent");
const tool = participant("tool", "tool", "tool");

function text(value: string) {
  return {
    kind: "text",
    role: "body",
    mediaType: "text/plain; charset=utf-8",
    value,
  };
}

function message(
  id: string,
  sender: Sender,
  body: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ConversationMessage {
  return {
    id,
    namespace: "tenant",
    threadId: "thread",
    sender,
    recipientIds: [],
    content: body ? [text(body)] : [],
    metadata,
    createdAt: STAMP,
    updatedAt: STAMP,
  } as unknown as ConversationMessage;
}

function origin(
  planId: string,
  toolCallId: string,
  action: string,
): CoreToolActionOrigin {
  return {
    schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
    planId,
    planMessageId: `message:${planId}`,
    planIndex: 0,
    stageIndex: 0,
    stageCount: 1,
    planSize: 1,
    toolCallId,
    action,
    threadId: "thread",
    triggerMessageId: "trigger",
    agentId: "north",
    agentParticipantId: "north",
    initiatorParticipantId: "ana",
    availableToolIds: [action],
    responseVisibility: { kind: "public" },
    parentLlmActionRunId: `llm:${planId}`,
  };
}

function toolPlan(
  id: string,
  sender: Sender,
  body: string,
  planId: string,
  calls: readonly { id: string; action: string; input: object }[],
  extra: Readonly<Record<string, unknown>> = {},
): ConversationMessage {
  return message(
    id,
    sender,
    body,
    withCoreToolPlanMetadata({ ...extra, llmToolCalls: calls }, {
      schema: CORE_TOOL_PLAN_METADATA_SCHEMA,
      planId,
      planSize: calls.length,
    }),
  );
}

function toolResult(
  id: string,
  body: string,
  planId: string,
  toolCallId: string,
  action: string,
  extra: Readonly<Record<string, unknown>> = {},
): ConversationMessage {
  return message(
    id,
    tool,
    body,
    withCoreToolActionMessageMetadata(
      { requesterId: "north", ...extra },
      origin(planId, toolCallId, action),
      `run:${id}`,
    ),
  );
}

function render(messages: readonly WireChatMessage[]): string {
  return messages.map((entry) => {
    const body = typeof entry.content === "string"
      ? entry.content
      : entry.content.map((part) =>
        part.type === "text" ? part.text : `[${part.type}]`
      ).join("");
    return `--- ${entry.role}\n${body}`;
  }).join("\n");
}

function wire(
  history: readonly ConversationMessage[],
  participantId: string,
): string {
  const messages = buildLlmTranscript({
    threadId: "thread",
    participantId,
    history,
  }).map((entry) => entry.message);
  const { messages: formatted } = formatLlmRequestForWire(
    { messages },
    { model: "test-model" },
    "tenant",
  );
  return render(formatted);
}

const peerConversation = [
  message("h1", ana, "Hi team, plan the launch."),
  message("n1", north, "I'll draft the timeline."),
  message("s1", south, "I'll handle the budget."),
  message("h2", ana, "North, what do you think of South's plan?"),
];

Deno.test("golden: peer conversation seen by North", () => {
  assertEquals(
    wire(peerConversation, "north"),
    `--- user
[Ana]: Hi team, plan the launch.
--- assistant
I'll draft the timeline.
--- user
[South]: I'll handle the budget.

[Ana]: North, what do you think of South's plan?`,
  );
});

Deno.test("golden: peer conversation seen by South", () => {
  assertEquals(
    wire(peerConversation, "south"),
    `--- user
[Ana]: Hi team, plan the launch.

[North]: I'll draft the timeline.
--- assistant
I'll handle the budget.
--- user
[Ana]: North, what do you think of South's plan?`,
  );
});

function toolConversation(resultExtra: Readonly<Record<string, unknown>> = {}) {
  return [
    message("h1", ana, "What's the weather in Tokyo?"),
    toolPlan("n1", north, "Checking.", "plan-1", [{
      id: "call-1",
      action: "weather",
      input: { city: "Tokyo" },
    }], { llmReasoning: [text("Need the weather tool.")] }),
    toolResult(
      "t1",
      "21°C, clear",
      "plan-1",
      "call-1",
      "weather",
      resultExtra,
    ),
    message("n2", north, "It's 21°C and clear in Tokyo."),
    message("s1", south, "Thanks North."),
  ];
}

Deno.test("golden: own tool plan seen by its requester", () => {
  assertEquals(
    wire(toolConversation(), "north"),
    `--- user
[Ana]: What's the weather in Tokyo?
--- assistant
<think>
Need the weather tool.
</think>

Checking.

<tool_calls>
{"name":"weather","arguments":{"city":"Tokyo"},"tool_call_id":"call-1","tool_plan_id":"plan-1"}
</tool_calls>
--- user
<tool_results>
{"name":"weather","output":"21°C, clear","tool_call_id":"call-1","tool_plan_id":"plan-1"}
</tool_results>
--- assistant
It's 21°C and clear in Tokyo.
--- user
[South]: Thanks North.`,
  );
});

Deno.test("golden: peer tool plan with default visibility", () => {
  assertEquals(
    wire(toolConversation(), "south"),
    `--- user
[Ana]: What's the weather in Tokyo?

[North]: It's 21°C and clear in Tokyo.
--- assistant
Thanks North.`,
  );
});

Deno.test("golden: peer tool plan with public result visibility", () => {
  assertEquals(
    wire(toolConversation({ historyVisibility: "public" }), "south"),
    `--- user
[Ana]: What's the weather in Tokyo?

[tool]: 21°C, clear

[North]: It's 21°C and clear in Tokyo.
--- assistant
Thanks North.`,
  );
});

Deno.test("golden: parallel tool plan with chained results", () => {
  const history = [
    message("h1", ana, "Compare Tokyo and Paris."),
    toolPlan("n1", north, "", "plan-2", [
      { id: "call-a", action: "weather", input: { city: "Tokyo" } },
      { id: "call-b", action: "weather", input: { city: "Paris" } },
    ]),
    toolResult("t1", "21°C", "plan-2", "call-a", "weather"),
    toolResult("t2", "14°C", "plan-2", "call-b", "weather"),
  ];
  assertEquals(
    wire(history, "north"),
    `--- user
[Ana]: Compare Tokyo and Paris.
--- assistant
<tool_calls>
{"name":"weather","arguments":{"city":"Tokyo"},"tool_call_id":"call-a","tool_plan_id":"plan-2"}
{"name":"weather","arguments":{"city":"Paris"},"tool_call_id":"call-b","tool_plan_id":"plan-2"}
</tool_calls>
--- user
<tool_results>
{"name":"weather","output":"21°C","tool_call_id":"call-a","tool_plan_id":"plan-2"}
{"name":"weather","output":"14°C","tool_call_id":"call-b","tool_plan_id":"plan-2"}
</tool_results>`,
  );
});

function askConversation(mode: "public" | "private") {
  const ask = (phase: AgentAskMetadata["phase"]): AgentAskMetadata => ({
    schema: "copilotz.ask.v1",
    askId: "ask-1",
    phase,
    mode,
    toolActionRunId: "run:ask",
    toolCallId: "ask-call",
    questionMessageId: "q1",
    askingParticipantId: "north",
    askingAgentId: "north",
    askingAgentName: "North",
    askedParticipantId: "south",
    askedAgentId: "south",
    askedAgentName: "South",
    origin: origin("plan-ask", "ask-call", "ask"),
    depth: 1,
  });
  return [
    message("h1", ana, "North, get South's budget estimate."),
    toolPlan("n1", north, "", "plan-ask", [{
      id: "ask-call",
      action: "ask",
      input: { agent: "south", question: "Budget estimate?" },
    }]),
    message(
      "q1",
      north,
      "What is your budget estimate?",
      withAgentAskMetadata({}, ask("question")),
    ),
    message(
      "a1",
      south,
      "About $10k.",
      withAgentAskMetadata({}, ask("answer")),
    ),
    toolResult(
      "r1",
      "",
      "plan-ask",
      "ask-call",
      "ask",
      withAgentAskResultMetadata({}, {
        schema: "copilotz.ask-result.v1",
        askId: "ask-1",
        status: "completed",
        askedParticipantId: "south",
        askedAgentId: "south",
        answerMessageId: "a1",
      }),
    ),
    message("n2", north, "South estimates $10k."),
  ];
}

const askAsker = `--- user
[Ana]: North, get South's budget estimate.
--- assistant
<tool_calls>
{"name":"ask","arguments":{"agent":"south","question":"Budget estimate?"},"tool_call_id":"ask-call","tool_plan_id":"plan-ask"}
</tool_calls>
--- user
<tool_results>
{"name":"ask","output":"About $10k.","tool_call_id":"ask-call","tool_plan_id":"plan-ask"}
</tool_results>
--- assistant
South estimates $10k.`;

const askAsked = `--- user
[Ana]: North, get South's budget estimate.

[North]: What is your budget estimate?
--- assistant
About $10k.
--- user
[North]: South estimates $10k.`;

const expectedAsk = {
  public: {
    north: askAsker,
    south: askAsked,
    west: `--- user
[Ana]: North, get South's budget estimate.

[North]: What is your budget estimate?

[South]: About $10k.

[North]: South estimates $10k.`,
  },
  private: {
    north: askAsker,
    south: askAsked,
    west: `--- user
[Ana]: North, get South's budget estimate.

[North]: South estimates $10k.`,
  },
} as const;

for (const mode of ["public", "private"] as const) {
  for (const viewer of ["north", "south", "west"] as const) {
    Deno.test(`golden: ${mode} ask seen by ${viewer}`, () => {
      assertEquals(
        wire(askConversation(mode), viewer),
        expectedAsk[mode][viewer],
      );
    });
  }
}
